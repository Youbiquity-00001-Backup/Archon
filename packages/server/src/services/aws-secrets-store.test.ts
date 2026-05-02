import { describe, test, expect } from 'bun:test';
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  type SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import { AwsSecretsManagerStore } from './aws-secrets-store';

interface SendCall {
  command: unknown;
}

interface FakeClient {
  client: SecretsManagerClient;
  calls: SendCall[];
  setHandler(fn: (command: unknown) => unknown): void;
}

function makeFakeClient(initialHandler: (command: unknown) => unknown = () => ({})): FakeClient {
  const calls: SendCall[] = [];
  let handler = initialHandler;
  const fake = {
    send: (command: unknown) => {
      calls.push({ command });
      return Promise.resolve(handler(command));
    },
  } as unknown as SecretsManagerClient;
  return {
    client: fake,
    calls,
    setHandler(fn) {
      handler = fn;
    },
  };
}

const PREFIX = 'youbiquity-archon/dev/user-creds';

function makeNotFoundError(): ResourceNotFoundException {
  return new ResourceNotFoundException({
    $metadata: {},
    message: 'Secrets Manager can’t find the specified secret.',
  });
}

function makeExistsError(): ResourceExistsException {
  return new ResourceExistsException({
    $metadata: {},
    message: 'The operation failed because the secret already exists.',
  });
}

describe('AwsSecretsManagerStore', () => {
  describe('construction', () => {
    test('throws on empty prefix', () => {
      expect(() => new AwsSecretsManagerStore({ prefix: '' })).toThrow(/prefix is required/);
    });

    test('throws on whitespace-only prefix', () => {
      expect(() => new AwsSecretsManagerStore({ prefix: '   ' })).toThrow(/prefix is required/);
    });

    test('strips trailing slashes from prefix', async () => {
      const fake = makeFakeClient(() => ({ SecretString: '{}' }));
      const store = new AwsSecretsManagerStore({ prefix: `${PREFIX}/`, client: fake.client });
      await store.getSecret('U1');
      const cmd = fake.calls[0].command as GetSecretValueCommand;
      expect(cmd.input.SecretId).toBe(`${PREFIX}/U1`);
    });
  });

  describe('id validation', () => {
    test('rejects ids with disallowed chars on get', async () => {
      const fake = makeFakeClient();
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await expect(store.getSecret('bad/id')).rejects.toThrow(/invalid secret id/);
      await expect(store.getSecret('bad id')).rejects.toThrow(/invalid secret id/);
    });

    test('rejects ids with disallowed chars on put', async () => {
      const fake = makeFakeClient();
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await expect(store.putSecret('a..b', '{}')).rejects.toThrow(/invalid secret id/);
    });
  });

  describe('getSecret', () => {
    test('returns SecretString on success', async () => {
      const fake = makeFakeClient(() => ({ SecretString: '{"github":{}}' }));
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      const out = await store.getSecret('U1');
      expect(out).toBe('{"github":{}}');
      const cmd = fake.calls[0].command as GetSecretValueCommand;
      expect(cmd.input.SecretId).toBe(`${PREFIX}/U1`);
    });

    test('returns null on ResourceNotFoundException', async () => {
      const fake = makeFakeClient(() => {
        throw makeNotFoundError();
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      const out = await store.getSecret('U1');
      expect(out).toBeNull();
    });

    test('propagates non-NotFound errors', async () => {
      const fake = makeFakeClient(() => {
        throw new Error('boom');
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await expect(store.getSecret('U1')).rejects.toThrow('boom');
    });

    test('returns null when SecretString is missing', async () => {
      const fake = makeFakeClient(() => ({}));
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      expect(await store.getSecret('U1')).toBeNull();
    });
  });

  describe('putSecret', () => {
    test('uses PutSecretValueCommand on the happy path', async () => {
      const fake = makeFakeClient(cmd => {
        if (cmd instanceof PutSecretValueCommand) return {};
        throw new Error(`unexpected command: ${cmd?.constructor.name}`);
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await store.putSecret('U1', '{"hello":"world"}');
      expect(fake.calls).toHaveLength(1);
      const put = fake.calls[0].command as PutSecretValueCommand;
      expect(put).toBeInstanceOf(PutSecretValueCommand);
      expect(put.input.SecretId).toBe(`${PREFIX}/U1`);
      expect(put.input.SecretString).toBe('{"hello":"world"}');
    });

    test('falls back to CreateSecret when secret does not exist', async () => {
      const fake = makeFakeClient(cmd => {
        if (cmd instanceof PutSecretValueCommand) throw makeNotFoundError();
        if (cmd instanceof CreateSecretCommand) return { ARN: 'arn:fake', Name: cmd.input.Name };
        throw new Error('unexpected');
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await store.putSecret('U1', '{}');
      expect(fake.calls).toHaveLength(2);
      expect(fake.calls[0].command).toBeInstanceOf(PutSecretValueCommand);
      const create = fake.calls[1].command as CreateSecretCommand;
      expect(create).toBeInstanceOf(CreateSecretCommand);
      expect(create.input.Name).toBe(`${PREFIX}/U1`);
      expect(create.input.SecretString).toBe('{}');
    });

    test('retries Put when Create races into ResourceExistsException', async () => {
      const fake = makeFakeClient(cmd => {
        if (cmd instanceof PutSecretValueCommand) {
          // First call: NotFound (drives the Create attempt). Second call: succeed.
          if (fake.calls.filter(c => c.command instanceof PutSecretValueCommand).length === 1) {
            throw makeNotFoundError();
          }
          return {};
        }
        if (cmd instanceof CreateSecretCommand) {
          throw makeExistsError();
        }
        throw new Error('unexpected');
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await store.putSecret('U1', '{}');
      expect(fake.calls.length).toBe(3);
      expect(fake.calls[0].command).toBeInstanceOf(PutSecretValueCommand);
      expect(fake.calls[1].command).toBeInstanceOf(CreateSecretCommand);
      expect(fake.calls[2].command).toBeInstanceOf(PutSecretValueCommand);
    });

    test('propagates non-NotFound errors from Put', async () => {
      const fake = makeFakeClient(() => {
        throw new Error('access denied');
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await expect(store.putSecret('U1', '{}')).rejects.toThrow('access denied');
    });

    test('propagates non-Exists errors from Create', async () => {
      const fake = makeFakeClient(cmd => {
        if (cmd instanceof PutSecretValueCommand) throw makeNotFoundError();
        throw new Error('quota exceeded');
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await expect(store.putSecret('U1', '{}')).rejects.toThrow('quota exceeded');
    });
  });

  describe('listSecretIds', () => {
    test('paginates via NextToken and strips prefix', async () => {
      let pageNum = 0;
      const fake = makeFakeClient(cmd => {
        if (!(cmd instanceof ListSecretsCommand)) throw new Error('unexpected');
        pageNum++;
        if (pageNum === 1) {
          return {
            SecretList: [{ Name: `${PREFIX}/U1` }, { Name: `${PREFIX}/U2` }],
            NextToken: 'tok',
          };
        }
        return { SecretList: [{ Name: `${PREFIX}/U3` }] };
      });
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      const ids = await store.listSecretIds();
      expect(ids).toEqual(['U1', 'U2', 'U3']);
      expect(fake.calls).toHaveLength(2);
      const second = fake.calls[1].command as ListSecretsCommand;
      expect(second.input.NextToken).toBe('tok');
    });

    test('skips entries with nested paths and missing names', async () => {
      const fake = makeFakeClient(() => ({
        SecretList: [
          { Name: `${PREFIX}/U_OK` },
          { Name: `${PREFIX}/nested/U_BAD` },
          { Name: undefined },
          { Name: 'unrelated/secret' },
        ],
      }));
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      const ids = await store.listSecretIds();
      expect(ids).toEqual(['U_OK']);
    });

    test('returns empty array when no secrets exist', async () => {
      const fake = makeFakeClient(() => ({}));
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      expect(await store.listSecretIds()).toEqual([]);
    });

    test('passes the prefix as the name filter', async () => {
      const fake = makeFakeClient(() => ({}));
      const store = new AwsSecretsManagerStore({ prefix: PREFIX, client: fake.client });
      await store.listSecretIds();
      const cmd = fake.calls[0].command as ListSecretsCommand;
      expect(cmd.input.Filters).toEqual([{ Key: 'name', Values: [`${PREFIX}/`] }]);
    });
  });
});
