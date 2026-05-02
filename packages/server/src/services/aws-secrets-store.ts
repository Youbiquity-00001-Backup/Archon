/**
 * AWS Secrets Manager-backed `ISecretStore` implementation.
 *
 * Lives in `@archon/server` so `@archon/core` does not pull in the AWS SDK
 * (per the doc note in `packages/core/src/services/user-creds/secret-store.ts`).
 * Production deployments wire this in via `new UserCredsService({ store: ... })`
 * at server bootstrap; local dev / CLI / tests fall through to the default
 * `InMemorySecretStore`.
 *
 * Layout: one secret per user at `<prefix>/<slackUserId>` (e.g.
 * `youbiquity-archon/dev/user-creds/U0AVABCDE`). The prefix is set via the
 * `USER_CREDS_SECRET_PREFIX` env var; the IAM task role grants the SM actions
 * scoped to `<prefix>/*` (see infra/iam.tf in youbiquity-archon-infra).
 */
import {
  CreateSecretCommand,
  GetSecretValueCommand,
  ListSecretsCommand,
  PutSecretValueCommand,
  ResourceExistsException,
  ResourceNotFoundException,
  SecretsManagerClient,
} from '@aws-sdk/client-secrets-manager';
import type { ISecretStore, SecretId } from '@archon/core';
import { createLogger } from '@archon/paths';

const log = createLogger('aws-secrets-store');

/** Slack user IDs are `[A-Z0-9]{10,11}` per Slack's docs; we accept the slightly broader id chars Secrets Manager allows for forward-compat (e.g. `_`, `-`). */
const SECRET_ID_PATTERN = /^[A-Za-z0-9_-]+$/;

export interface AwsSecretsStoreOptions {
  /** Required. e.g. `youbiquity-archon/dev/user-creds`. Secrets are stored at `<prefix>/<slackUserId>`. */
  prefix: string;
  /** Optional region override; defaults to the SDK's resolution chain (env / IMDS). */
  region?: string;
  /** Test seam — defaults to a real `SecretsManagerClient`. */
  client?: SecretsManagerClient;
}

export class AwsSecretsManagerStore implements ISecretStore {
  private readonly client: SecretsManagerClient;
  private readonly prefix: string;

  constructor(opts: AwsSecretsStoreOptions) {
    if (!opts.prefix || opts.prefix.trim().length === 0) {
      throw new Error('AwsSecretsManagerStore: prefix is required and must be non-empty');
    }
    // Strip trailing slash so we can always append `/${id}` without doubling.
    this.prefix = opts.prefix.replace(/\/+$/, '');
    this.client =
      opts.client ?? new SecretsManagerClient(opts.region ? { region: opts.region } : {});
  }

  async getSecret(id: SecretId): Promise<string | null> {
    this.assertValidId(id);
    const fullId = `${this.prefix}/${id}`;
    try {
      const res = await this.client.send(new GetSecretValueCommand({ SecretId: fullId }));
      return res.SecretString ?? null;
    } catch (err) {
      if (err instanceof ResourceNotFoundException) return null;
      log.error({ err, secretId: fullId }, 'aws-secrets-store.get_failed');
      throw err;
    }
  }

  async putSecret(id: SecretId, json: string): Promise<void> {
    this.assertValidId(id);
    const fullId = `${this.prefix}/${id}`;
    // Try Put first. If the secret has never existed, fall back to Create.
    // Pattern avoids needing `secretsmanager:DescribeSecret` to probe existence
    // (the IAM policy may not grant it), and concurrent first-writers collide
    // on Create — the loser retries Put.
    try {
      await this.client.send(new PutSecretValueCommand({ SecretId: fullId, SecretString: json }));
      return;
    } catch (err) {
      if (!(err instanceof ResourceNotFoundException)) {
        log.error({ err, secretId: fullId }, 'aws-secrets-store.put_failed');
        throw err;
      }
    }
    try {
      await this.client.send(new CreateSecretCommand({ Name: fullId, SecretString: json }));
    } catch (err) {
      if (err instanceof ResourceExistsException) {
        // Lost a race with a parallel first-writer; the secret now exists, retry Put.
        await this.client.send(new PutSecretValueCommand({ SecretId: fullId, SecretString: json }));
        return;
      }
      log.error({ err, secretId: fullId }, 'aws-secrets-store.create_failed');
      throw err;
    }
  }

  async listSecretIds(): Promise<SecretId[]> {
    const ids: SecretId[] = [];
    let nextToken: string | undefined;
    const filterPrefix = `${this.prefix}/`;
    do {
      const res = await this.client.send(
        new ListSecretsCommand({
          Filters: [{ Key: 'name', Values: [filterPrefix] }],
          NextToken: nextToken,
        })
      );
      for (const entry of res.SecretList ?? []) {
        const name = entry.Name;
        if (typeof name !== 'string') continue;
        if (!name.startsWith(filterPrefix)) continue;
        const id = name.slice(filterPrefix.length);
        // Defense in depth — `name` filter is a "starts-with" match, not a
        // segment match, so `<prefix>/<other>/foo` could leak in. Skip ids
        // containing `/` to be safe.
        if (id.length === 0 || id.includes('/')) continue;
        ids.push(id);
      }
      nextToken = res.NextToken;
    } while (nextToken);
    return ids;
  }

  private assertValidId(id: SecretId): void {
    if (!SECRET_ID_PATTERN.test(id)) {
      throw new Error(
        `AwsSecretsManagerStore: invalid secret id ${JSON.stringify(id)} — must match [A-Za-z0-9_-]+`
      );
    }
  }
}
