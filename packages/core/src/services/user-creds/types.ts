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
 *
 * Note: the Anthropic credential is the OAuth bearer token from
 * `claude /login` (`claudeAiOauth.accessToken`), NOT a console
 * `sk-ant-...` API key. It must be injected as `CLAUDE_CODE_OAUTH_TOKEN`
 * — the SDK env var that consumes OAuth tokens. Setting it as
 * `ANTHROPIC_API_KEY` makes the SDK send it as a Bearer API key, which
 * Anthropic 401s with "Invalid authentication credentials".
 */
export interface UserEnvOverlay {
  HOME?: string;
  GH_TOKEN?: string;
  CLAUDE_CODE_OAUTH_TOKEN?: string;
}

/** Result of an `upsertForUser` call. */
export interface UpsertResult {
  /** Reply text to send back to the slash-command invoker. */
  replyText: string;
  /** Whether the upsert wrote anything (vs. validation reject). */
  persisted: boolean;
}

/**
 * Public-safe per-user connection status, suitable for the Settings →
 * Connections SPA page. Each section is a discriminated union on `linked`
 * — when not linked, no extra fields are present, so a leaked-empty
 * response can never accidentally include a previously-linked email.
 */
export interface ConnectionStatus {
  anthropic:
    | { linked: false }
    | {
        linked: true;
        /** Account email captured at upsert time; absent for legacy uploads. */
        accountEmail?: string;
      };
  github:
    | { linked: false }
    | {
        linked: true;
        /** GitHub login captured at OAuth time. */
        login: string;
        /** Optional GitHub App installation id, when captured. */
        installationId?: number;
      };
}
