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
import { mkdir, writeFile, chmod } from 'fs/promises';
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

export class UserCredsService {
  private readonly store: ISecretStore;
  private readonly usersDir: string;
  private readonly cache = new Map<string, CacheEntry>();
  private readonly anthropicProbe: AnthropicProbe;
  private readonly githubProbe: GithubProbe;
  private bootstrapped = false;

  constructor(opts: UserCredsServiceOptions = {}) {
    this.store = opts.store ?? new InMemorySecretStore();
    this.usersDir = opts.usersDir ?? join(getArchonHome(), 'users');
    this.anthropicProbe = opts.anthropicProbe ?? defaultAnthropicProbe;
    this.githubProbe = opts.githubProbe ?? defaultGithubProbe;
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
 * Validate the JSON pasted by a user via `/archon-creds anthropic <json>`.
 * Accepts either the full `.credentials.json` document (with top-level
 * `claudeAiOauth`) or a wrapper containing it.
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
        '(no extra text), e.g. `/archon-creds anthropic {...}`.',
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
export type { ISecretStore } from './secret-store';
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
