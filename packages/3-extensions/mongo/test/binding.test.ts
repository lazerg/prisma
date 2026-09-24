import { describe, expect, it } from 'vitest';
import { resolveMongoBinding } from '../src/runtime/binding';

describe('resolveMongoBinding with a connection string', () => {
  it('accepts a seed list with credentials and a replica set', () => {
    const url =
      'mongodb://user:password@host1:27017,host2:27017,host3:27017/absensi?replicaSet=my-replica-set';

    expect(resolveMongoBinding({ url })).toEqual({ kind: 'url', url, dbName: 'absensi' });
  });

  it('accepts a bracketed IPv6 seed list', () => {
    const url = 'mongodb://[::1]:27017,[::2]:27017/db';

    expect(resolveMongoBinding({ url })).toEqual({ kind: 'url', url, dbName: 'db' });
  });

  it('accepts a single host whose password contains a comma', () => {
    const url = 'mongodb://user:pa,ss@host1:27017/db';

    expect(resolveMongoBinding({ url })).toEqual({ kind: 'url', url, dbName: 'db' });
  });

  it('rejects a seed list without a database name in the path', () => {
    expect(() => resolveMongoBinding({ url: 'mongodb://h1:27017,h2:27017' })).toThrow(
      expect.objectContaining({
        code: 'RUNTIME.BINDING_INVALID',
        message:
          'Mongo URL must include a database name in its path (e.g. mongodb://host:27017/mydb), or pass dbName explicitly',
      }),
    );
  });
});
