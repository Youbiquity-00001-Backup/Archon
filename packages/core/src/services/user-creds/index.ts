/**
 * `UserCredsService` — per-user credential plumbing for Patch 3
 * (`user_creds_self_service`). Owns:
 *   - bootstrap from the configured secret store at server start
 *   - cache of decoded creds keyed by Slack user id
 *   - filesystem materialization of `.claude/.credentials.json` and
 *     `.git-credentials` under each user's per-user `HOME` dir
 *   - per-user env-overlay computation consumed by the orchestrator
 *   - upsert side that backs the slash-command + OAuth-callback flows
 *
 * The service is intentionally pluggable on its secret-store backend
 * (see `secret-store.ts`) so `@archon/core` stays cloud-neutral. The AWS
 * Secrets Manager wiring is provided by the deployment package.
 *
 * Threading: `getEnvOverlay()` is synchronous (cache hit) — the orchestrator
 * hot path must not do I/O per message. `upsertForUser()` performs I/O
 * (secret store + disk) and returns a reply suitable for the Slack adapter.
 */
import { mkdir, writeFile, chmod, readFile, rm } from 'fs/promises';
import { join } from 'path';
import { createLogger } from '@archon/paths';
import { getArchonHome } from '@archon/paths';
import type { ISecretStore } from './secret-store';
import { InMemorySecretStore } from './secret-store';
import type {
  AnthropicCreds,
  ConnectionStatus,
  GithubCreds,
  UserCreds,
  UserEnvOverlay,
  UpsertResult,
} from './types';

/**
 * Lead time before a GitHub access-token expiry triggers a proactive refresh.
 * GitHub access tokens live ~8h; refreshing 10 min ahead gives multiple retry
 * windows on transient failures without sending the user into expired-token
 * territory mid-request.
 */
const GITHUB_REFRESH_LEAD_MS = 10 * 60 * 1000;

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('user-creds');
  return cachedLog;
}

/** What we keep in the in-memory cache for a user. */
interface CacheEntry {
  home: string;
  ghToken?: string;
  ghTokenExpiresAt?: number;
  /** Anthropic cred we materialized — kept so `getEnvOverlay` knows whether to set ANTHROPIC_API_KEY. */
  anthropicAccessToken?: string;
}

/** Optional dependencies for testability and deployment-specific wiring. */
export interface UserCredsServiceOptions {
  /** Pluggable secret store. Defaults to a process-local in-memory map. */
  store?: ISecretStore;
  /**
   * Override the per-user home root. Defaults to `~/.archon/users/`.
   * Used by tests to point at a tmpdir.
   */
  usersDir?: string;
  /**
   * Probe function for validating Anthropic creds. Defaults to a real
   * fetch against the Anthropic OAuth roles endpoint. Tests inject a stub.
   */
  anthropicProbe?: AnthropicProbe;
  /**
   * Probe function for validating GitHub access tokens. Defaults to a real
   * fetch against `GET https://api.github.com/user`. Tests inject a stub.
   */
  githubProbe?: GithubProbe;
  /**
   * Refresh-token exchange used by `ensureFreshGithub`. Defaults to a real
   * POST to GitHub's OAuth token endpoint. Tests inject a stub.
   */
  githubRefresh?: GithubRefresh;
  /**
   * Returns "now" in ms — used by `ensureFreshGithub` to compare against
   * `expiresAt`. Defaults to `Date.now`. Tests inject a fake clock.
   */
  clock?: () => number;
}

export type AnthropicProbe = (accessToken: string) => Promise<{
  ok: boolean;
  accountEmail?: string;
  status?: number;
}>;

export type GithubProbe = (accessToken: string) => Promise<{
  ok: boolean;
  login?: string;
  status?: number;
}>;

/**
 * Result of exchanging a refresh token at GitHub's token endpoint.
 *
 * `status === 401` is the unrecoverable case: GitHub has invalidated the
 * refresh chain (revocation, expired refresh token). Caller tombstones the
 * user.
 *
 * Any other non-OK result (5xx, network blip) is treated as transient — the
 * cache is left untouched and the next refresh attempt retries.
 */
export interface GithubRefreshResult {
  ok: boolean;
  status?: number;
  /** Unix epoch *seconds* when the new access token expires. */
  expiresAt?: number;
  /** Unix epoch *seconds* when the new refresh token expires. */
  refreshExpiresAt?: number;
  accessToken?: string;
  refreshToken?: string;
}

export type GithubRefresh = (refreshToken: string) => Promise<GithubRefreshResult>;

/** Default Anthropic probe — used in production wiring. */
const defaultAnthropicProbe: AnthropicProbe = async accessToken => {
  try {
    const res = await fetch('https://api.anthropic.com/api/oauth/claude_cli/roles', {
      headers: { Authorization: `Bearer ${accessToken}` },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { account?: { email?: string } };
    return { ok: true, accountEmail: body.account?.email, status: res.status };
  } catch (err) {
    getLog().warn({ err }, 'user-creds.anthropic_probe_threw');
    return { ok: false };
  }
};

/** Default GitHub probe. */
const defaultGithubProbe: GithubProbe = async accessToken => {
  try {
    const res = await fetch('https://api.github.com/user', {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        Accept: 'application/vnd.github+json',
      },
    });
    if (!res.ok) return { ok: false, status: res.status };
    const body = (await res.json()) as { login?: string };
    return { ok: true, login: body.login, status: res.status };
  } catch (err) {
    getLog().warn({ err }, 'user-creds.github_probe_threw');
    return { ok: false };
  }
};

/**
 * Default GitHub OAuth refresh-token exchange. Hits the canonical token
 * endpoint with `grant_type=refresh_token`. Caller (`ensureFreshGithub`)
 * supplies the refresh token; client id/secret are sourced from env vars
 * (`GITHUB_OAUTH_CLIENT_ID`, `GITHUB_OAUTH_CLIENT_SECRET`) configured at
 * server bootstrap. Tests stub this whole function.
 */
const defaultGithubRefresh: GithubRefresh = async refreshToken => {
  const clientId = process.env.GITHUB_OAUTH_CLIENT_ID;
  const clientSecret = process.env.GITHUB_OAUTH_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    getLog().warn('user-creds.github_refresh_misconfigured');
    return { ok: false };
  }
  try {
    const res = await fetch('https://github.com/login/oauth/access_token', {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: 'refresh_token',
        refresh_token: refreshToken,
      }).toString(),
    });
    const status = res.status;
    if (!res.ok) return { ok: false, status };
    const body = (await res.json()) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      refresh_token_expires_in?: number;
      error?: string;
    };
    if (body.error || typeof body.access_token !== 'string') {
      // GitHub returns 200 with `{ error: "bad_refresh_token" }` when the
      // refresh chain is dead. Map that to the same 401 semantics.
      return { ok: false, status: 401 };
    }
    const nowSec = Math.floor(Date.now() / 1000);
    return {
      ok: true,
      status,
      accessToken: body.access_token,
      refreshToken: body.refresh_token,
      expiresAt: typeof body.expires_in === 'number' ? nowSec + body.expires_in : undefined,
      refreshExpiresAt:
        typeof body.refresh_token_expires_in === 'number'
          ? nowSec + body.refresh_token_expires_in
          : undefined,
    };
  } catch (err) {
    getLog().warn({ err }, 'user-creds.github_refresh_threw');
    return { ok: false };
  }
};

export class UserCredsService {
  private readonly store: ISecretStore;
  private readonly usersDir: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly anthropicProbe: AnthropicProbe;
  private readonly githubProbe: GithubProbe;
  private readonly githubRefresh: GithubRefresh;
  private readonly clock: () => number;
  private bootstrapped = false;

  constructor(opts: UserCredsServiceOptions = {}) {
    this.store = opts.store ?? new InMemorySecretStore();
    this.usersDir = opts.usersDir ?? join(getArchonHome(), 'users');
    this.anthropicProbe = opts.anthropicProbe ?? defaultAnthropicProbe;
    this.githubProbe = opts.githubProbe ?? defaultGithubProbe;
    this.githubRefresh = opts.githubRefresh ?? defaultGithubRefresh;
    this.clock = opts.clock ?? Date.now;
  }

  /**
   * Boot-time: enumerate stored user creds, populate the cache, and
   * materialize per-user dotfiles to disk. Idempotent — calling twice is
   * a no-op after the first call (re-bootstrap requires a process restart,
   * matching the cache-invalidation design).
   */
  async bootstrap(): Promise<void> {
    if (this.bootstrapped) return;
    const ids = await this.store.listSecretIds();
    let materializedCount = 0;
    for (const id of ids) {
      try {
        const json = await this.store.getSecret(id);
        if (!json) continue;
        const creds = JSON.parse(json) as UserCreds;
        // Skip tombstones (`{}` written by `markRefreshChainDead`) — leaving
        // a `HOME`-only cache entry would point the spawn at an empty per-user
        // dir and break the global-auth fallback. The user re-links via
        // `/archon-creds <provider>` when they're ready.
        if (!creds.anthropic && !creds.github) continue;
        await this.materialize(id, creds);
        materializedCount++;
      } catch (err) {
        // Single-user failure must not block the whole bootstrap — log and
        // proceed. The caller can self-heal via `/archon-creds anthropic|github`.
        getLog().error({ err, slackUserId: maskUid(id) }, 'user-creds.bootstrap_user_failed');
      }
    }
    this.bootstrapped = true;
    getLog().info(
      { totalIds: ids.length, materialized: materializedCount },
      'user-creds.bootstrap_completed'
    );
  }

  /**
   * Synchronous lookup used by the orchestrator hot path.
   * Returns the env overlay for the given user, or null when no creds are
   * cached (caller treats null as "no overlay" — same semantics as before).
   */
  getEnvOverlay(slackUserId: string): UserEnvOverlay | null {
    const entry = this.cache.get(slackUserId);
    if (!entry) return null;
    const overlay: UserEnvOverlay = { HOME: entry.home };
    if (entry.ghToken) overlay.GH_TOKEN = entry.ghToken;
    if (entry.anthropicAccessToken) overlay.ANTHROPIC_API_KEY = entry.anthropicAccessToken;
    return overlay;
  }

  /**
   * Persist Anthropic creds for a user. Validates the JSON shape, probes the
   * Anthropic API, persists to the secret store, materializes to disk, and
   * updates the cache.
   */
  async upsertAnthropic(slackUserId: string, rawJson: string): Promise<UpsertResult> {
    const parsed = parseAnthropicJson(rawJson);
    if (!parsed.ok) {
      return { replyText: parsed.error, persisted: false };
    }

    const probe = await this.anthropicProbe(parsed.creds.claudeAiOauth.accessToken);
    if (!probe.ok) {
      return {
        replyText:
          `Anthropic rejected the credential (status ${probe.status ?? 'unknown'}). ` +
          'Re-run `claude /login` and paste the new credentials.json.',
        persisted: false,
      };
    }

    const credsToStore: AnthropicCreds = {
      ...parsed.creds,
      accountEmail: probe.accountEmail ?? parsed.creds.accountEmail,
    };

    const merged = await this.mergeAndPersist(slackUserId, prev => ({
      ...prev,
      anthropic: credsToStore,
    }));
    await this.materialize(slackUserId, merged);

    const emailSuffix = probe.accountEmail ? ` as ${probe.accountEmail}` : '';
    return {
      replyText: `Saved. Your next @archon … runs${emailSuffix}.`,
      persisted: true,
    };
  }

  /**
   * Persist GitHub creds for a user (called from the OAuth callback after
   * code-for-token exchange). Probes `/user` to capture login, persists,
   * and materializes git config.
   */
  async upsertGithub(
    slackUserId: string,
    creds: Omit<GithubCreds, 'login'> & { login?: string }
  ): Promise<UpsertResult> {
    const probe = await this.githubProbe(creds.accessToken);
    if (!probe.ok || !probe.login) {
      return {
        replyText:
          `GitHub rejected the access token (status ${probe.status ?? 'unknown'}). ` +
          'Re-run `/archon-creds github` and complete the OAuth flow again.',
        persisted: false,
      };
    }

    const credsToStore: GithubCreds = { ...creds, login: probe.login };
    const merged = await this.mergeAndPersist(slackUserId, prev => ({
      ...prev,
      github: credsToStore,
    }));
    await this.materialize(slackUserId, merged);

    return {
      replyText: `Linked GitHub as ${probe.login}.`,
      persisted: true,
    };
  }

  /**
   * Public-safe connection status for a user: which integrations are linked
   * and the cosmetic identifiers (account email / GitHub login) needed to
   * render the Settings → Connections page. Never includes raw cred
   * material — the SPA must never see access tokens.
   *
   * Implementation note: this reads the secret store rather than the cache
   * because the cache only retains tokens (for the env overlay) and not
   * cosmetic fields like `accountEmail` or GitHub `login`. Cost is a single
   * `getSecret(uid)` per page load — the SM call is fast enough at this
   * scale. If it ever isn't, materialize() can also seed the email/login
   * into the cache.
   */
  async getConnectionStatus(slackUserId: string): Promise<ConnectionStatus> {
    const json = await this.store.getSecret(slackUserId);
    if (!json) {
      return { anthropic: { linked: false }, github: { linked: false } };
    }
    let creds: UserCreds;
    try {
      creds = JSON.parse(json) as UserCreds;
    } catch (err) {
      // Stored doc is corrupt — surface as "not linked" rather than 500ing.
      // The user can re-link via /archon-creds and we'll overwrite the
      // bad doc on the next upsert.
      getLog().error(
        { err, slackUserId: maskUid(slackUserId) },
        'user-creds.connection_status_parse_failed'
      );
      return { anthropic: { linked: false }, github: { linked: false } };
    }
    return {
      anthropic: creds.anthropic
        ? { linked: true, accountEmail: creds.anthropic.accountEmail }
        : { linked: false },
      github: creds.github
        ? {
            linked: true,
            login: creds.github.login,
            installationId: creds.github.installationId,
          }
        : { linked: false },
    };
  }

  /**
   * Self-fallback rule: when the requesting user X has no GitHub creds but
   * codebase C was registered by X, X may still use X's stored GitHub creds
   * for actions on C. No cross-user borrowing.
   *
   * Returns the GH access token from X's stored creds, or null if X has none.
   */
  async selfFallbackToken(
    requestingUid: string,
    codebaseRegisteredBy: string | null
  ): Promise<string | null> {
    if (!codebaseRegisteredBy) return null;
    if (requestingUid !== codebaseRegisteredBy) return null;
    const entry = this.cache.get(requestingUid);
    return entry?.ghToken ?? null;
  }

  /**
   * Re-read the per-user dotfiles from disk and persist any changes back
   * to the secret store.
   *
   * The Claude Code subprocess refreshes Anthropic OAuth tokens in place by
   * rewriting `<HOME>/.claude/.credentials.json` (Anthropic rotates both
   * access *and* refresh tokens on every refresh — the old refresh token
   * stops working). Without write-back, the persistent store goes stale on
   * the first redeploy after a rotation. This method closes that loop:
   * after every spawn, the orchestrator calls `syncFromDisk` to capture
   * whatever the subprocess wrote.
   *
   * Best-effort. Any IO / parse / store error is logged and swallowed —
   * never block the response on persistence hiccups. The live filesystem
   * state is still correct after a failure; the next call retries.
   */
  async syncFromDisk(slackUserId: string): Promise<{ rotated: boolean }> {
    const entry = this.cache.get(slackUserId);
    if (!entry) {
      // No cache entry → user never linked or hasn't been materialized.
      // Nothing to read or compare against.
      return { rotated: false };
    }

    let diskAnthropic: AnthropicCreds | null = null;
    let diskGithubToken: string | null = null;

    // Read Anthropic credentials (may be absent if user hasn't linked Claude).
    try {
      const text = await readFile(join(entry.home, '.claude', '.credentials.json'), 'utf8');
      diskAnthropic = parseClaudeCredentialsFile(text);
    } catch (err) {
      if (!isFileMissing(err)) {
        getLog().warn(
          { err, slackUserId: maskUid(slackUserId) },
          'user-creds.sync_anthropic_read_failed'
        );
      }
    }

    // Read .git-credentials (may be absent if user hasn't linked GitHub).
    try {
      const text = await readFile(join(entry.home, '.git-credentials'), 'utf8');
      diskGithubToken = parseGitCredentialsFile(text);
    } catch (err) {
      if (!isFileMissing(err)) {
        getLog().warn(
          { err, slackUserId: maskUid(slackUserId) },
          'user-creds.sync_github_read_failed'
        );
      }
    }

    const anthropicChanged = Boolean(
      diskAnthropic && entry.anthropicAccessToken !== diskAnthropic.claudeAiOauth.accessToken
    );
    const githubChanged = Boolean(diskGithubToken && entry.ghToken !== diskGithubToken);

    if (!anthropicChanged && !githubChanged) {
      return { rotated: false };
    }

    try {
      const existingJson = await this.store.getSecret(slackUserId);
      const prev: UserCreds = existingJson ? (JSON.parse(existingJson) as UserCreds) : {};
      const next: UserCreds = { ...prev };

      if (anthropicChanged && diskAnthropic) {
        // Preserve cosmetic fields that the on-disk file does not carry
        // (accountEmail is captured at upsert time via the OAuth roles probe).
        next.anthropic = {
          ...diskAnthropic,
          accountEmail: prev.anthropic?.accountEmail ?? diskAnthropic.accountEmail,
        };
        entry.anthropicAccessToken = diskAnthropic.claudeAiOauth.accessToken;
      }

      if (githubChanged && diskGithubToken && prev.github) {
        // .git-credentials only carries the access token; preserve refresh
        // token, expiries, login, and installation id from the stored doc.
        next.github = { ...prev.github, accessToken: diskGithubToken };
        entry.ghToken = diskGithubToken;
      }

      await this.store.putSecret(slackUserId, JSON.stringify(next));

      getLog().info(
        {
          slackUserId: maskUid(slackUserId),
          anthropicRotated: anthropicChanged,
          githubRotated: githubChanged,
        },
        'user-creds.sync_from_disk_rotated'
      );
      return { rotated: true };
    } catch (err) {
      getLog().warn({ err, slackUserId: maskUid(slackUserId) }, 'user-creds.sync_from_disk_failed');
      return { rotated: false };
    }
  }

  /**
   * Refresh the user's GitHub OAuth access token if it is at or near
   * expiry. Called by the orchestrator before the env-build step so the
   * subprocess receives a fresh `GH_TOKEN`.
   *
   * GitHub access tokens live ~8h and the binary doesn't refresh for us,
   * so Archon owns the refresh flow. Does nothing when the user has no
   * GitHub creds, when no expiry is recorded, or when the token still has
   * more than `GITHUB_REFRESH_LEAD_MS` of life. Refresh is a no-op when
   * the stored doc has no `refreshToken`.
   *
   * On a 401 from GitHub the refresh chain is dead — we tombstone the
   * user so the next request falls through to the not-linked path. All
   * other failures are transient: the cache is left untouched and the
   * next call retries.
   */
  async ensureFreshGithub(slackUserId: string): Promise<void> {
    const entry = this.cache.get(slackUserId);
    if (!entry?.ghToken) return; // not linked
    const expiresAtSec = entry.ghTokenExpiresAt;
    if (!expiresAtSec) return; // unknown / never-expires — leave alone

    const expiresAtMs = expiresAtSec * 1000;
    if (expiresAtMs - this.clock() > GITHUB_REFRESH_LEAD_MS) return; // still fresh

    let creds: UserCreds;
    try {
      const json = await this.store.getSecret(slackUserId);
      if (!json) return;
      creds = JSON.parse(json) as UserCreds;
    } catch (err) {
      getLog().warn(
        { err, slackUserId: maskUid(slackUserId) },
        'user-creds.github_refresh_load_failed'
      );
      return;
    }

    const refreshToken = creds.github?.refreshToken;
    if (!refreshToken) {
      // Nothing to refresh against. Drop the expiry hint so we don't loop.
      entry.ghTokenExpiresAt = undefined;
      return;
    }

    const result = await this.githubRefresh(refreshToken);
    if (result.status === 401) {
      await this.markRefreshChainDead(slackUserId, 'github');
      return;
    }
    if (!result.ok || !result.accessToken) {
      getLog().warn(
        { slackUserId: maskUid(slackUserId), status: result.status },
        'user-creds.github_refresh_transient_failed'
      );
      return;
    }

    if (!creds.github) return; // defensive — refreshToken implies github

    const merged: GithubCreds = {
      ...creds.github,
      accessToken: result.accessToken,
      refreshToken: result.refreshToken ?? creds.github.refreshToken,
      expiresAt: result.expiresAt ?? creds.github.expiresAt,
      refreshExpiresAt: result.refreshExpiresAt ?? creds.github.refreshExpiresAt,
    };
    const next: UserCreds = { ...creds, github: merged };

    try {
      await this.store.putSecret(slackUserId, JSON.stringify(next));
    } catch (err) {
      // Persistence failed but the new token is still in our hands. Log,
      // materialize so the in-flight request gets the fresh token, and
      // accept that the next bootstrap might re-issue from a stale secret.
      getLog().warn(
        { err, slackUserId: maskUid(slackUserId) },
        'user-creds.github_refresh_persist_failed'
      );
    }
    await this.materialize(slackUserId, next);
    getLog().info(
      { slackUserId: maskUid(slackUserId), expiresAt: merged.expiresAt },
      'user-creds.github_refresh_completed'
    );
  }

  /**
   * Mark a user's refresh chain dead. Clears the cache entry, removes the
   * per-user dotfiles (best-effort), and writes an empty tombstone doc to
   * the store so bootstrap will not re-materialize stale tokens.
   *
   * Re-linking via `/archon-creds <provider>` overwrites the tombstone via
   * the normal upsert path.
   */
  private async markRefreshChainDead(
    slackUserId: string,
    provider: 'anthropic' | 'github'
  ): Promise<void> {
    getLog().warn({ slackUserId: maskUid(slackUserId), provider }, 'user-creds.refresh_chain_dead');
    const entry = this.cache.get(slackUserId);
    this.cache.delete(slackUserId);
    if (entry) {
      // Best-effort dotfile cleanup. Don't take a worker down because the
      // home dir is missing or unwritable.
      const filesToRemove = [
        join(entry.home, '.claude', '.credentials.json'),
        join(entry.home, '.git-credentials'),
        join(entry.home, '.gitconfig'),
      ];
      for (const f of filesToRemove) {
        try {
          await rm(f, { force: true });
        } catch (err) {
          getLog().debug(
            { err, slackUserId: maskUid(slackUserId), file: f },
            'user-creds.tombstone_unlink_failed'
          );
        }
      }
    }
    try {
      // Empty doc — `getEnvOverlay` already returns null when the cache is
      // empty; this just makes the next bootstrap a no-op for this user.
      await this.store.putSecret(slackUserId, JSON.stringify({}));
    } catch (err) {
      getLog().warn(
        { err, slackUserId: maskUid(slackUserId), provider },
        'user-creds.tombstone_persist_failed'
      );
    }
  }

  /**
   * Returns the in-memory cache as a snapshot — primarily for diagnostic
   * endpoints / tests. Never includes raw cred material.
   */
  listKnownUsers(): { slackUserIdMasked: string; hasGithub: boolean; hasAnthropic: boolean }[] {
    return Array.from(this.cache.entries()).map(([id, entry]) => ({
      slackUserIdMasked: maskUid(id),
      hasGithub: Boolean(entry.ghToken),
      hasAnthropic: Boolean(entry.anthropicAccessToken),
    }));
  }

  /** Test/diagnostic: check whether bootstrap has run. */
  isBootstrapped(): boolean {
    return this.bootstrapped;
  }

  // ─── Internals ────────────────────────────────────────────────────────────

  /**
   * Read-modify-write the user's stored doc, merging the existing doc with
   * the result of `transform(prev)`. Persists the merged doc to the secret
   * store and returns it for caller's downstream materialization.
   */
  private async mergeAndPersist(
    slackUserId: string,
    transform: (prev: UserCreds) => UserCreds
  ): Promise<UserCreds> {
    const existingJson = await this.store.getSecret(slackUserId);
    const prev: UserCreds = existingJson ? (JSON.parse(existingJson) as UserCreds) : {};
    const next = transform(prev);
    await this.store.putSecret(slackUserId, JSON.stringify(next));
    return next;
  }

  /**
   * Write per-user dotfiles into `~/.archon/users/<uid>/...` and update the
   * in-memory cache so subsequent `getEnvOverlay()` calls see the new state.
   */
  private async materialize(slackUserId: string, creds: UserCreds): Promise<void> {
    const home = join(this.usersDir, slackUserId);
    await mkdir(home, { recursive: true });

    const cacheEntry: CacheEntry = { home };

    if (creds.anthropic) {
      const claudeDir = join(home, '.claude');
      await mkdir(claudeDir, { recursive: true });
      const credsPath = join(claudeDir, '.credentials.json');
      await writeFile(credsPath, JSON.stringify(creds.anthropic, null, 2), {
        encoding: 'utf8',
      });
      // Best-effort permission lockdown — don't fail materialization if the
      // platform doesn't support chmod (e.g. some Windows file systems).
      try {
        await chmod(credsPath, 0o600);
      } catch (err) {
        getLog().debug({ err, credsPath }, 'user-creds.credentials_chmod_failed');
      }
      cacheEntry.anthropicAccessToken = creds.anthropic.claudeAiOauth.accessToken;
    }

    if (creds.github) {
      // .git-credentials uses the canonical x-access-token form. Same shape
      // git's `credential.helper=store` writes itself.
      const gitCredsPath = join(home, '.git-credentials');
      const line = `https://x-access-token:${creds.github.accessToken}@github.com\n`;
      await writeFile(gitCredsPath, line, { encoding: 'utf8' });
      try {
        await chmod(gitCredsPath, 0o600);
      } catch (err) {
        getLog().debug({ err, gitCredsPath }, 'user-creds.git_credentials_chmod_failed');
      }
      // Minimal .gitconfig pointing at the per-user .git-credentials.
      // We only own `credential.helper`; user-customizable keys (user.name etc.)
      // are not set here on purpose.
      const gitconfigPath = join(home, '.gitconfig');
      const cfg = '[credential]\n\thelper = store\n';
      await writeFile(gitconfigPath, cfg, { encoding: 'utf8' });

      cacheEntry.ghToken = creds.github.accessToken;
      cacheEntry.ghTokenExpiresAt = creds.github.expiresAt;
    }

    this.cache.set(slackUserId, cacheEntry);
    getLog().info(
      {
        slackUserId: maskUid(slackUserId),
        hasGithub: Boolean(creds.github),
        hasAnthropic: Boolean(creds.anthropic),
      },
      'user-creds.materialize_completed'
    );
  }
}

// ─── Validation helpers ─────────────────────────────────────────────────────

type ParseResult = { ok: true; creds: AnthropicCreds } | { ok: false; error: string };

/**
 * Validate the JSON pasted by a user into the Connect Anthropic modal
 * (opened by `/archon-creds anthropic`). Accepts either the full
 * `.credentials.json` document (with top-level `claudeAiOauth`) or a
 * wrapper containing it.
 */
function parseAnthropicJson(raw: string): ParseResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      error:
        'That JSON did not parse. Paste the full contents of `~/.claude/.credentials.json` ' +
        '(no extra text) into the modal opened by `/archon-creds anthropic`.',
    };
  }
  if (!parsed || typeof parsed !== 'object') {
    return { ok: false, error: 'Expected a JSON object — got something else.' };
  }
  const obj = parsed as Record<string, unknown>;
  const oauthRaw = obj.claudeAiOauth;
  if (!oauthRaw || typeof oauthRaw !== 'object') {
    return {
      ok: false,
      error:
        'Missing `claudeAiOauth` object. Run `claude /login` to refresh ' +
        '`~/.claude/.credentials.json` and paste the new contents.',
    };
  }
  const oauth = oauthRaw as Record<string, unknown>;
  const accessToken = oauth.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) {
    return { ok: false, error: 'Missing or empty `claudeAiOauth.accessToken`.' };
  }
  return {
    ok: true,
    creds: {
      claudeAiOauth: {
        accessToken,
        refreshToken: pickStringField(oauth, 'refreshToken'),
        expiresAt: pickNumberField(oauth, 'expiresAt'),
        scopes: pickStringArrayField(oauth, 'scopes'),
        subscriptionType: pickStringField(oauth, 'subscriptionType'),
      },
    },
  };
}

/**
 * Parse the on-disk Claude credentials file.
 *
 * Returns null on any structural problem (missing claudeAiOauth, missing
 * accessToken, malformed JSON). `syncFromDisk` treats null as "nothing to
 * persist" rather than as an error.
 */
function parseClaudeCredentialsFile(text: string): AnthropicCreds | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const root = parsed as Record<string, unknown>;
  // The file may be the raw `claudeAiOauth` object or our materialized shape
  // (a wrapper containing the oauth block). Materialize() writes the wrapped
  // shape, but accept either to stay robust against future SDK changes.
  const oauthBlock =
    root.claudeAiOauth && typeof root.claudeAiOauth === 'object'
      ? (root.claudeAiOauth as Record<string, unknown>)
      : root;
  const accessToken = oauthBlock.accessToken;
  if (typeof accessToken !== 'string' || accessToken.length === 0) return null;
  return {
    claudeAiOauth: {
      accessToken,
      refreshToken: pickStringField(oauthBlock, 'refreshToken'),
      expiresAt: pickNumberField(oauthBlock, 'expiresAt'),
      scopes: pickStringArrayField(oauthBlock, 'scopes'),
      subscriptionType: pickStringField(oauthBlock, 'subscriptionType'),
    },
    accountEmail: pickStringField(root, 'accountEmail'),
  };
}

/**
 * Extract the access token from a `.git-credentials` file. Format written
 * by `materialize()` and by git's `credential.helper=store`:
 * `https://x-access-token:<token>@github.com\n`.
 *
 * Returns null when no github.com line is present.
 */
function parseGitCredentialsFile(text: string): string | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const match = /^https:\/\/x-access-token:([^@]+)@github\.com\b/.exec(trimmed);
    if (match) return match[1];
  }
  return null;
}

/** True iff the error is an ENOENT (file not found). */
function isFileMissing(err: unknown): boolean {
  return (err as NodeJS.ErrnoException | undefined)?.code === 'ENOENT';
}

function pickStringField(o: Record<string, unknown>, key: string): string | undefined {
  const v = o[key];
  return typeof v === 'string' ? v : undefined;
}

function pickNumberField(o: Record<string, unknown>, key: string): number | undefined {
  const v = o[key];
  return typeof v === 'number' ? v : undefined;
}

function pickStringArrayField(o: Record<string, unknown>, key: string): string[] | undefined {
  const v = o[key];
  if (!Array.isArray(v)) return undefined;
  return v.filter((x): x is string => typeof x === 'string');
}

/**
 * Mask a Slack user id for logging. Preserves enough prefix to disambiguate
 * different users in logs while not echoing the full id.
 */
function maskUid(uid: string): string {
  if (uid.length <= 4) return '***';
  return `${uid.slice(0, 4)}***`;
}

export { maskUid };
export type { ISecretStore, SecretId } from './secret-store';
export { InMemorySecretStore } from './secret-store';
export type {
  UserCreds,
  UserEnvOverlay,
  AnthropicCreds,
  GithubCreds,
  UpsertResult,
  ConnectionStatus,
} from './types';

// ─── Singleton accessor ─────────────────────────────────────────────────────
//
// The orchestrator hot path needs a synchronous lookup, so we keep a
// process-level singleton wired up at server bootstrap. Tests that need a
// scoped instance use `setUserCredsService(testInstance)` and reset in
// `afterEach`.

let singleton: UserCredsService | null = null;

/** Install the singleton (call from server bootstrap, exactly once). */
export function setUserCredsService(svc: UserCredsService | null): void {
  singleton = svc;
}

/**
 * Return the configured singleton, or null if none has been installed.
 * Call sites that don't need creds — CLI, isolated tests — keep working.
 * The orchestrator treats null as "no overlay" exactly like the old
 * static-config code path.
 */
export function getUserCredsService(): UserCredsService | null {
  return singleton;
}
