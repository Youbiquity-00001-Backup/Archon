/**
 * Pluggable secret-store backend for `UserCredsService`.
 *
 * The interface is deliberately tiny — get / put / list. One backend ships
 * with this package: `InMemorySecretStore`, used in tests, single-process
 * dev, and as the default when no AWS-backed store is configured. Lifetime
 * is the process lifetime; restart loses state (matches the design note
 * "no TTL on the cache — invalidated on app restart"). For dev/test use only.
 *
 * The AWS Secrets Manager backend is NOT implemented in this package, to
 * avoid pulling `@aws-sdk/client-secrets-manager` into `@archon/core`'s dep
 * graph. Production AWS deployments wire their own impl in via
 * `new UserCredsService(awsStore)`. Keeps `@archon/core` cloud-neutral.
 */

/** Identifier for a single user's cred document — typically a Slack user ID. */
export type SecretId = string;

/** A pluggable secret store. All operations are async to allow remote backends. */
export interface ISecretStore {
  /** Read the JSON-serialized doc for a user; returns null if not found. */
  getSecret(id: SecretId): Promise<string | null>;
  /** Atomically write/replace the JSON-serialized doc for a user. */
  putSecret(id: SecretId, json: string): Promise<void>;
  /** Enumerate all known secret ids (used by `bootstrap`). */
  listSecretIds(): Promise<SecretId[]>;
}

/**
 * Process-local in-memory store. Not suitable for multi-task production
 * deployments — use the AWS-backed wiring there. Useful for local single-task
 * dev and as a deterministic test fixture.
 */
export class InMemorySecretStore implements ISecretStore {
  private readonly map = new Map<SecretId, string>();

  async getSecret(id: SecretId): Promise<string | null> {
    return this.map.get(id) ?? null;
  }

  async putSecret(id: SecretId, json: string): Promise<void> {
    this.map.set(id, json);
  }

  async listSecretIds(): Promise<SecretId[]> {
    return Array.from(this.map.keys());
  }

  /** Test/seeding helper. Bypasses any future write-side validation. */
  seed(id: SecretId, json: string): void {
    this.map.set(id, json);
  }

  /** Test helper: reset to empty state. */
  clear(): void {
    this.map.clear();
  }
}
