/**
 * Types for the per-user credentials service (Patch 3 — `user_creds_self_service`).
 *
 * Two cred kinds, both stored under `<prefix>/user-creds/<slack-uid>` in the
 * configured secret store as a single merged JSON document. The orchestrator
 * reads them only via `UserCredsService.getEnvOverlay()` — the SDK call sees
 * env vars, never the raw cred JSON.
 */

/** Anthropic Claude OAuth blob, shape matches `claude /login`'s `.credentials.json`. */
export interface AnthropicCreds {
  claudeAiOauth: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
    scopes?: string[];
    subscriptionType?: string;
  };
  /** Captured at upsert time by probing /api/oauth/claude_cli/roles. */
  accountEmail?: string;
}

/** GitHub user-to-server OAuth tokens (App-installed). */
export interface GithubCreds {
  /** Always 'oauth' — discriminator left in for forward-compat with PAT or Device flow. */
  type: 'oauth';
  accessToken: string;
  /** Refresh token (≈ 6-month lifetime per GitHub App docs). */
  refreshToken?: string;
  /** Unix epoch seconds; absent ⇒ never expires (rare). */
  expiresAt?: number;
  /** Refresh token expiry (≈ 6 months); enforced by GitHub. */
  refreshExpiresAt?: number;
  /** GitHub login (e.g. `octocat`); captured by probing GET /user at OAuth time. */
  login: string;
  /** Installation id captured if the user installed the App during authorize. */
  installationId?: number;
}

/** The merged JSON document persisted at `<prefix>/user-creds/<slack-uid>`. */
export interface UserCreds {
  anthropic?: AnthropicCreds;
  github?: GithubCreds;
}

/**
 * Subset of process-env vars the orchestrator overlays for a known platform user.
 * `HOME` points at the user's per-user dir so subprocesses pick up
 * `.claude/.credentials.json` and `.git-credentials` from that location.
 */
export interface UserEnvOverlay {
  HOME?: string;
  GH_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
}

/** Result of an `upsertForUser` call. */
export interface UpsertResult {
  /** Reply text to send back to the slash-command invoker. */
  replyText: string;
  /** Whether the upsert wrote anything (vs. validation reject). */
  persisted: boolean;
}
