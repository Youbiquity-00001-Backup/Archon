/**
 * Direct Slack OIDC handlers (non-ALB).
 *
 * AWS ALB-fronted deployments validate Slack identities via the
 * `x-amzn-oidc-data` header (see `middleware/oidc-identity.ts`). Caddy /
 * Docker deployments don't have ALB, so this module implements a direct
 * PKCE round-trip against Slack's OpenID Connect endpoints:
 *
 *   1. `GET /auth/slack/initiate?redirect_after=<url>` — mints a PKCE
 *      verifier, stores it server-side against a random `state`, and 302s
 *      the user to Slack's authorize URL.
 *   2. `GET /auth/slack/callback?code=...&state=...` — exchanges the code
 *      for an access token, fetches userinfo, mints an Archon session JWT,
 *      and either redirects to `redirectAfter?token=...` or returns the
 *      token as JSON.
 *
 * The minted JWT is the same shape consumed by the OIDC middleware's
 * Bearer-token path, so the same `/api/*` surface is reachable on both
 * deployment models with no per-route code change.
 *
 * Backend-only — no React, no SDK. Both routes must live in the OIDC
 * middleware bypass list (they ARE the auth flow).
 */
import { randomBytes, createHash } from 'node:crypto';
import type { Context } from 'hono';
import { createLogger } from '@archon/paths';
import type { OidcIdentity } from './middleware/oidc-identity';
import { buildArchonSessionToken, parseSlackSub } from './middleware/oidc-identity';
import type { ISlackOidcStateStore } from './oauth-state-store';

/** Lazy-initialized logger (deferred so test mocks can intercept createLogger). */
let cachedLog: ReturnType<typeof createLogger> | undefined;
function getLog(): ReturnType<typeof createLogger> {
  if (!cachedLog) cachedLog = createLogger('auth.slack');
  return cachedLog;
}

/**
 * Slack OIDC config. The deployment package supplies these at server start
 * (env vars `SLACK_CLIENT_ID`, `SLACK_CLIENT_SECRET`, `OAUTH_CALLBACK_BASE`);
 * tests inject a literal object.
 */
export interface SlackOidcConfig {
  clientId: string;
  clientSecret: string;
  /** Public-facing base URL where `/auth/slack/callback` is reachable. */
  callbackBase: string;
}

/**
 * Pluggable token-exchange function. Lets tests stub the
 * `code → access_token` step without intercepting global `fetch`.
 */
export type SlackTokenExchange = (input: {
  code: string;
  codeVerifier: string;
  config: SlackOidcConfig;
}) => Promise<SlackTokenResponse>;

export interface SlackTokenResponse {
  ok: boolean;
  access_token?: string;
  token_type?: string;
  id_token?: string;
  error?: string;
}

/**
 * Pluggable userinfo function. Lets tests stub the
 * `access_token → user identity` step without intercepting global `fetch`.
 */
export type SlackUserInfoFetcher = (accessToken: string) => Promise<SlackUserInfoResponse>;

export interface SlackUserInfoResponse {
  ok: boolean;
  sub?: string;
  email?: string;
  name?: string;
  error?: string;
  ['https://slack.com/user_id']?: string;
  ['https://slack.com/team_id']?: string;
}

const SLACK_AUTHORIZE_URL = 'https://slack.com/openid/connect/authorize';
const SLACK_TOKEN_URL = 'https://slack.com/api/openid.connect.token';
const SLACK_USERINFO_URL = 'https://slack.com/api/openid.connect.userInfo';

/** Build the Slack OpenID authorize URL bound to a fresh PKCE state. */
export function buildSlackAuthorizeUrl(
  config: SlackOidcConfig,
  stateStore: ISlackOidcStateStore,
  redirectAfter?: string
): string {
  const codeVerifier = randomBytes(96).toString('base64url');
  const codeChallenge = createHash('sha256').update(codeVerifier).digest().toString('base64url');
  const state = stateStore.create({ codeVerifier, redirectAfter });
  const params = new URLSearchParams({
    client_id: config.clientId,
    scope: 'openid profile email',
    response_type: 'code',
    state,
    redirect_uri: `${config.callbackBase}/auth/slack/callback`,
    code_challenge: codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${SLACK_AUTHORIZE_URL}?${params.toString()}`;
}

/** Default code-for-token exchange against Slack. */
export const fetchTokensFromSlack: SlackTokenExchange = async ({ code, codeVerifier, config }) => {
  // Slack's openid.connect.token endpoint uses application/x-www-form-urlencoded.
  // It always returns HTTP 200 with `ok: false` on error — do NOT rely on
  // `res.ok` alone to detect a rejected exchange.
  const body = new URLSearchParams({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    redirect_uri: `${config.callbackBase}/auth/slack/callback`,
    code_verifier: codeVerifier,
    grant_type: 'authorization_code',
  });
  const res = await fetch(SLACK_TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: body.toString(),
  });
  if (!res.ok) {
    throw new Error(`slack token endpoint returned ${res.status}`);
  }
  return (await res.json()) as SlackTokenResponse;
};

/** Default userinfo fetcher (Slack returns the openid sub + email + name). */
export const fetchSlackUserInfo: SlackUserInfoFetcher = async accessToken => {
  const res = await fetch(SLACK_USERINFO_URL, {
    method: 'GET',
    headers: { Authorization: `Bearer ${accessToken}` },
  });
  if (!res.ok) {
    throw new Error(`slack userinfo endpoint returned ${res.status}`);
  }
  return (await res.json()) as SlackUserInfoResponse;
};

/** Hono handler for `GET /auth/slack/initiate`. */
export async function handleSlackOidcInitiate(
  c: Context,
  config: SlackOidcConfig,
  stateStore: ISlackOidcStateStore
): Promise<Response> {
  const redirectAfterRaw = c.req.query('redirect_after');
  const redirectAfter = redirectAfterRaw && redirectAfterRaw !== '' ? redirectAfterRaw : undefined;
  const url = buildSlackAuthorizeUrl(config, stateStore, redirectAfter);
  return c.redirect(url, 302);
}

/** Dependencies for the callback handler — split out so tests can stub fetch. */
export interface SlackCallbackDeps {
  tokenExchange?: SlackTokenExchange;
  userInfoFetcher?: SlackUserInfoFetcher;
}

/** Hono handler for `GET /auth/slack/callback?code=...&state=...`. */
export async function handleSlackOidcCallback(
  c: Context,
  config: SlackOidcConfig,
  stateStore: ISlackOidcStateStore,
  sessionSecret: string,
  deps: SlackCallbackDeps = {}
): Promise<Response> {
  const code = c.req.query('code');
  const state = c.req.query('state');
  const oauthError = c.req.query('error');

  if (oauthError) {
    getLog().warn({ error: oauthError }, 'auth.slack.callback_oauth_error');
    return c.json({ error: 'slack_oauth_error', detail: oauthError }, 400);
  }

  if (!code || !state) {
    getLog().warn(
      { hasCode: Boolean(code), hasState: Boolean(state) },
      'auth.slack.callback_missing_params'
    );
    return c.json({ error: 'missing code or state' }, 400);
  }

  const stateData = stateStore.consume(state);
  if (!stateData) {
    getLog().warn('auth.slack.callback_state_invalid');
    return c.json({ error: 'sign-in link expired or already used' }, 400);
  }

  const tokenExchange = deps.tokenExchange ?? fetchTokensFromSlack;
  let tokenData: SlackTokenResponse;
  try {
    tokenData = await tokenExchange({ code, codeVerifier: stateData.codeVerifier, config });
  } catch (err) {
    getLog().error({ err }, 'auth.slack.callback_token_exchange_failed');
    return c.json({ error: 'slack token exchange failed' }, 502);
  }

  if (!tokenData.ok || !tokenData.access_token) {
    getLog().warn({ error: tokenData.error }, 'auth.slack.callback_token_rejected');
    return c.json({ error: 'slack rejected the code', detail: tokenData.error ?? 'unknown' }, 400);
  }

  const userInfoFetcher = deps.userInfoFetcher ?? fetchSlackUserInfo;
  let userInfo: SlackUserInfoResponse;
  try {
    userInfo = await userInfoFetcher(tokenData.access_token);
  } catch (err) {
    getLog().error({ err }, 'auth.slack.callback_userinfo_failed');
    return c.json({ error: 'slack userinfo failed' }, 502);
  }

  if (!userInfo.ok || !userInfo.sub) {
    getLog().warn({ error: userInfo.error }, 'auth.slack.callback_userinfo_rejected');
    return c.json({ error: 'slack userinfo rejected' }, 400);
  }

  const slackUserId = parseSlackSub(userInfo.sub);
  const identity: OidcIdentity = {
    slackUserId,
    email: userInfo.email,
    displayName: userInfo.name,
  };
  const sessionToken = buildArchonSessionToken(identity, sessionSecret);

  if (stateData.redirectAfter) {
    // Append the token as a query param. Use URL to handle existing query
    // strings on the caller-supplied URL without smashing them.
    let target: URL;
    try {
      target = new URL(stateData.redirectAfter);
    } catch {
      getLog().warn(
        { redirectAfter: stateData.redirectAfter },
        'auth.slack.callback_invalid_redirect_after'
      );
      return c.json({ error: 'invalid redirect_after url' }, 400);
    }
    target.searchParams.set('token', sessionToken);
    return c.redirect(target.toString(), 302);
  }

  return c.json({
    token: sessionToken,
    slackUserId,
    email: userInfo.email,
    displayName: userInfo.name,
  });
}
