/**
 * GitHub user-to-server OAuth handlers (Patch 3 / Phase A.1).
 *
 * Two surfaces:
 *
 * 1. `buildGithubAuthorizeUrl` — pure helper that mints a state token via
 *    the OAuth state store and returns the URL the user clicks. Reused by
 *    both the slash-command flow (`/archon-creds github` posts the URL in
 *    a Slack DM) and the web flow (`POST /api/auth/github/initiate`).
 *
 * 2. `handleGithubOAuthCallback` — Hono handler for
 *    `GET /auth/github/callback?code=...&state=...`. Exchanges the code,
 *    persists creds via `UserCredsService.upsertGithub`, and renders a
 *    minimal HTML "you can close this tab" response.
 *
 * Both surfaces are deliberately backend-only — no React, no SDK — so the
 * route stays in the bypass list when Slack OIDC eventually fronts the
 * web UI (Patch 4).
 */
import type { Context } from 'hono';
import { createLogger } from '@archon/paths';
import type { UserCredsService, GithubCreds } from '@archon/core';
import type { IOAuthStateStore } from './oauth-state-store';

/** Lazy-initialized logger. */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('auth.github');
  return cachedLog;
}

/**
 * Minimum config the OAuth flow needs. The deployment package supplies
 * these values at server start (typically read from Secrets Manager
 * `<prefix>/github-app`); tests inject a literal object.
 */
export interface GithubOAuthConfig {
  clientId: string;
  clientSecret: string;
  /** Public-facing base URL where `/auth/github/callback` is reachable. */
  callbackBase: string;
}

/**
 * Pluggable token-exchange function. Lets tests stub the `code → tokens`
 * step without intercepting global `fetch`. Production wiring uses the
 * default `fetchTokensFromGithub` below.
 */
export type GithubTokenExchange = (input: {
  code: string;
  config: GithubOAuthConfig;
}) => Promise<GithubTokenResponse>;

export interface GithubTokenResponse {
  access_token: string;
  token_type?: string;
  scope?: string;
  refresh_token?: string;
  /** Seconds until access_token expires (per GitHub Apps user-to-server tokens). */
  expires_in?: number;
  /** Seconds until refresh_token expires (≈ 6 months). */
  refresh_token_expires_in?: number;
  /** Present when the upstream rejected the exchange. */
  error?: string;
  error_description?: string;
}

/** Build the GitHub authorize URL bound to a fresh state token. */
export function buildGithubAuthorizeUrl(args: {
  config: GithubOAuthConfig;
  stateStore: IOAuthStateStore;
  slackUserId: string;
}): string {
  const state = args.stateStore.create(args.slackUserId);
  const params = new URLSearchParams({
    client_id: args.config.clientId,
    state,
    redirect_uri: `${args.config.callbackBase}/auth/github/callback`,
  });
  return `https://github.com/login/oauth/authorize?${params.toString()}`;
}

/** Default code-for-token exchange against api.github.com. */
export const fetchTokensFromGithub: GithubTokenExchange = async ({ code, config }) => {
  const res = await fetch('https://github.com/login/oauth/access_token', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code,
      redirect_uri: `${config.callbackBase}/auth/github/callback`,
    }),
  });
  // GitHub returns 200 even for app-rejected codes — error info is in the body.
  return (await res.json()) as GithubTokenResponse;
};

/**
 * Hono handler for `GET /auth/github/callback?code=...&state=...`.
 *
 * Note this route MUST be in the ALB OIDC bypass list (`/auth/github/callback`)
 * — GitHub's redirect cannot carry a Slack OIDC cookie.
 */
export interface GithubCallbackDeps {
  config: GithubOAuthConfig;
  stateStore: IOAuthStateStore;
  userCreds: UserCredsService;
  /** Override for tests; defaults to `fetchTokensFromGithub`. */
  tokenExchange?: GithubTokenExchange;
}

export async function handleGithubOAuthCallback(
  c: Context,
  deps: GithubCallbackDeps
): Promise<Response> {
  const code = c.req.query('code');
  const state = c.req.query('state');

  if (!code || !state) {
    getLog().warn(
      { hasCode: Boolean(code), hasState: Boolean(state) },
      'auth.github.callback_missing_params'
    );
    return renderHtmlError(c, 'Missing `code` or `state` parameter.');
  }

  const slackUserId = deps.stateStore.consume(state);
  if (!slackUserId) {
    getLog().warn('auth.github.callback_state_invalid');
    return renderHtmlError(
      c,
      'Sign-in link expired or already used. Run `/archon-creds github` again.'
    );
  }

  const exchange = deps.tokenExchange ?? fetchTokensFromGithub;
  let tokens: GithubTokenResponse;
  try {
    tokens = await exchange({ code, config: deps.config });
  } catch (err) {
    getLog().error({ err }, 'auth.github.callback_exchange_threw');
    return renderHtmlError(c, 'GitHub did not respond. Try `/archon-creds github` again.');
  }

  if (tokens.error || !tokens.access_token) {
    getLog().warn(
      { error: tokens.error, errorDescription: tokens.error_description },
      'auth.github.callback_exchange_rejected'
    );
    return renderHtmlError(
      c,
      `GitHub rejected the link: ${tokens.error_description ?? tokens.error ?? 'unknown error'}.`
    );
  }

  const now = Math.floor(Date.now() / 1000);
  const credsToStore: Omit<GithubCreds, 'login'> = {
    type: 'oauth',
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: tokens.expires_in ? now + tokens.expires_in : undefined,
    refreshExpiresAt: tokens.refresh_token_expires_in
      ? now + tokens.refresh_token_expires_in
      : undefined,
  };

  const result = await deps.userCreds.upsertGithub(slackUserId, credsToStore);
  if (!result.persisted) {
    return renderHtmlError(c, result.replyText);
  }

  return renderHtmlOk(c, result.replyText);
}

/**
 * Hono handler for `GET /auth/github/initiate`. Used by the web Settings
 * page once Slack OIDC is in place. For Phase A.1, the slash-command path
 * builds the URL directly via `buildGithubAuthorizeUrl()` and DMs it, so
 * this handler is a forward-looking surface — it's wired but no SPA calls
 * it yet. Tests cover it for behavior parity with the slash-command path.
 *
 * Identity comes from the request — supplied by Patch 4's OIDC middleware
 * (which sets a request-scoped `slackUserId`). For now the deps include
 * a callback that pulls the id from the request context.
 */
export interface GithubInitiateDeps {
  config: GithubOAuthConfig;
  stateStore: IOAuthStateStore;
  /**
   * Resolves the Slack user id from the request. In Phase A.1 (no OIDC
   * middleware yet) this returns null and the handler responds 401, since
   * unauthenticated callers have no business minting an OAuth state.
   */
  resolveSlackUserId: (c: Context) => Promise<string | null>;
}

export async function handleGithubOAuthInitiate(
  c: Context,
  deps: GithubInitiateDeps
): Promise<Response> {
  const slackUserId = await deps.resolveSlackUserId(c);
  if (!slackUserId) {
    return c.json({ error: 'unauthenticated' }, 401);
  }
  const url = buildGithubAuthorizeUrl({
    config: deps.config,
    stateStore: deps.stateStore,
    slackUserId,
  });
  // 302 redirect — the SPA follows it directly.
  return c.redirect(url, 302);
}

// ─── HTML helpers ───────────────────────────────────────────────────────────

function renderHtmlOk(c: Context, msg: string): Response {
  // No external assets, no JS — keeps the page renderable even when ALB OIDC
  // is in the middle of redirecting.
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Linked</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">` +
      `<h2>${escapeHtml(msg)}</h2><p>You can close this tab.</p></body></html>`,
    200
  );
}

function renderHtmlError(c: Context, msg: string): Response {
  return c.html(
    `<!doctype html><html><head><meta charset="utf-8"><title>Sign-in failed</title></head>` +
      `<body style="font-family:system-ui,sans-serif;max-width:32rem;margin:4rem auto;line-height:1.5">` +
      `<h2>Sign-in failed</h2><p>${escapeHtml(msg)}</p></body></html>`,
    400
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
