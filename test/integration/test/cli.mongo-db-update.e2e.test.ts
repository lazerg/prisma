import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { MongoControlAdapterImpl } from '@internal/adapter-mongo/control';
import { coreHash, crossRef, profileHash } from '@internal/contract/types';
import { MongoControlDriver } from '@internal/driver-mongo/control';
import { MongoCollection, type MongoContract } from '@internal/mongo-contract';
import { timeouts } from '@repo/test-utils';
import { type Db, MongoClient } from 'mongodb';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { runOnEngine, setupTestDirectoryFromFixtures, withTempDir } from './utils/cli-test-helpers';

const controlAdapter = new MongoControlAdapterImpl();

const JSON_STORAGE_HASH = `a1b2c3d${'0'.repeat(57)}`;
const BSON_STORAGE_HASH = `e5f6a7b${'1'.repeat(57)}`;
const JSON_BSON_TYPES = ['object', 'array', 'string', 'double', 'int', 'long', 'bool', 'null'];

function eventsSchema(payload: unknown, tags: unknown): Record<string, unknown> {
  return {
    bsonType: 'object',
    properties: { _id: { bsonType: 'objectId' }, payload, tags },
    additionalProperties: false,
    required: ['_id', 'payload', 'tags'],
  };
}

const jsonSchema = eventsSchema(
  { bsonType: JSON_BSON_TYPES },
  { bsonType: 'array', items: { bsonType: JSON_BSON_TYPES } },
);

const bsonSchema = eventsSchema({}, { bsonType: 'array', items: {} });

const bsonContract: MongoContract = {
  target: 'mongo',
  targetFamily: 'mongo',
  roots: { events: crossRef('Event') },
  domain: {
    namespaces: {
      __unbound__: {
        models: {
          Event: {
            fields: {
              _id: { nullable: false, type: { kind: 'scalar', codecId: 'mongo/objectId@1' } },
              payload: { nullable: false, type: { kind: 'scalar', codecId: 'mongo/bson@1' } },
              tags: {
                nullable: false,
                many: true,
                type: { kind: 'scalar', codecId: 'mongo/bson@1' },
              },
            },
            relations: {},
            storage: { collection: 'events' },
          },
        },
      },
    },
  },
  storage: {
    namespaces: {
      __unbound__: {
        id: '__unbound__' as const,
        kind: 'mongo-namespace' as const,
        entries: {
          collection: {
            events: new MongoCollection({
              validator: {
                jsonSchema: bsonSchema,
                validationLevel: 'strict',
                validationAction: 'error',
              },
            }),
          },
        },
      },
    },
    storageHash: coreHash(BSON_STORAGE_HASH),
  },
  capabilities: {},
  extensions: {},
  profileHash: profileHash('mongo-update-test'),
  meta: {},
};

function writeContractJson(testDir: string, contract: MongoContract): void {
  const outputDir = resolve(testDir, 'output');
  mkdirSync(outputDir, { recursive: true });
  writeFileSync(resolve(outputDir, 'contract.json'), JSON.stringify(contract, null, 2), 'utf-8');
}

describe('mongo db update command (e2e)', { timeout: timeouts.spinUpMongoMemoryServer }, () => {
  let replSet: MongoMemoryReplSet;
  let client: MongoClient;
  let db: Db;
  let mongoUri: string;
  const dbName = 'update_e2e_test';

  beforeAll(async () => {
    replSet = await MongoMemoryReplSet.create({
      instanceOpts: [
        { launchTimeout: timeouts.spinUpMongoMemoryServer, storageEngine: 'wiredTiger' },
      ],
      replSet: { count: 1, storageEngine: 'wiredTiger', dbName },
    });
    const url = new URL(replSet.getUri());
    url.pathname = `/${dbName}`;
    mongoUri = url.toString();
    client = new MongoClient(replSet.getUri());
    await client.connect();
    db = client.db(dbName);
  }, timeouts.spinUpMongoMemoryServer);

  afterAll(async () => {
    try {
      await client?.close();
      await replSet?.stop();
    } catch {
      // ignore cleanup errors
    }
  }, timeouts.spinUpMongoMemoryServer);

  withTempDir(({ createTempDir }) => {
    beforeEach(async () => {
      await db.dropDatabase();
    });

    it('applies a Json to Bson field change without asking for confirmation', async () => {
      await db.createCollection('events', {
        validator: { $jsonSchema: jsonSchema },
        validationLevel: 'strict',
        validationAction: 'error',
      });
      await controlAdapter.initMarker(new MongoControlDriver(db, client), 'app', {
        storageHash: coreHash(JSON_STORAGE_HASH),
        profileHash: bsonContract.profileHash!,
      });

      const testSetup = setupTestDirectoryFromFixtures(
        createTempDir,
        'mongo-db-commands',
        'prisma.config.with-db.ts',
        { '{{MONGO_URI}}': mongoUri },
      );
      writeContractJson(testSetup.testDir, bsonContract);

      const run = await runOnEngine(testSetup, ['db', 'update', '--no-interactive', '--json']);

      expect(run.exitCode, run.stdout).toBe(0);
      const [collection] = await db.listCollections({ name: 'events' }).toArray();
      expect(collection).toMatchObject({ options: { validator: { $jsonSchema: bsonSchema } } });
    });
  });
});
