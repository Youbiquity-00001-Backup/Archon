import { describe, test, expect } from 'bun:test';
import { Hono } from 'hono';
import {
  buildSlackAuthorizeUrl,
  handleSlackOidcCallback,
  handleSlackOidcInitiate,
  type SlackOidcConfig,
  type SlackTokenExchange,
  type SlackUserInfoFetcher,
} from './auth-slack';
import { InMemorySlackOidcStateStore, type ISlackOidcStateStore } from './oauth-state-store';
import { verifyArchonSessionToken } from './middleware/oidc-identity';

const CONFIG: SlackOidcConfig = {
  clientId: 'CID',
  clientSecret: 'CSECRET',
  callbackBase: 'https://archon.example.com',
};

const SECRET = 'test-secret-do-not-use-in-prod-test-secret-do-not-use-in-prod';

function makeStore(): ISlackOidcStateStore {
  return new InMemorySlackOidcStateStore();
}

describe('buildSlackAuthorizeUrl', () => {
  test('returns Slack authorize URL with required PKCE params', () => {
    const store = makeStore();
    const url = buildSlackAuthorizeUrl(CONFIG, store);
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://slack.com/openid/connect/authorize');
    const params = parsed.searchParams;
    expect(params.get('client_id')).toBe('CID');
    expect(params.get('scope')).toBe('openid profile email');
    expect(params.get('response_type')).toBe('code');
    expect(params.get('redirect_uri')).toBe('https://archon.example.com/auth/slack/callback');
    expect(params.get('code_challenge_method')).toBe('S256');
    expect(params.get('code_challenge')).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(params.get('state')).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  test('stores codeVerifier against returned state, and challenge derives from it', () => {
    const store = makeStore();
    const url = buildSlackAuthorizeUrl(CONFIG, store, 'https://app.example.com/cb');
    const params = new URL(url).searchParams;
    const state = params.get('state')!;
    const challenge = params.get('code_challenge')!;
    const data = store.consume(state);
    expect(data?.redirectAfter).toBe('https://app.example.com/cb');
    expect(data?.codeVerifier).toMatch(/^[A-Za-z0-9_-]+$/);
    // Verify the challenge is SHA-256(verifier) → base64url
    const { createHash } = require('node:crypto') as typeof import('node:crypto');
    const expected = createHash('sha256').update(data!.codeVerifier).digest().toString('base64url');
    expect(challenge).toBe(expected);
  });

  test('different invocations produce distinct verifiers/states (entropy check)', () => {
    const store = makeStore();
    const a = new URL(buildSlackAuthorizeUrl(CONFIG, store)).searchParams;
    const b = new URL(buildSlackAuthorizeUrl(CONFIG, store)).searchParams;
    expect(a.get('state')).not.toBe(b.get('state'));
    expect(a.get('code_challenge')).not.toBe(b.get('code_challenge'));
  });
});

// ─── handleSlackOidcInitiate ────────────────────────────────────────────────

describe('handleSlackOidcInitiate', () => {
  test('302 redirects to Slack authorize URL', async () => {
    const store = makeStore();
    const app = new Hono();
    app.get('/auth/slack/initiate', c => handleSlackOidcInitiate(c, CONFIG, store));
    const res = await app.request('/auth/slack/initiate');
    expect(res.status).toBe(302);
    const location = res.headers.get('location')!;
    expect(location).toContain('https://slack.com/openid/connect/authorize?');
  });

  test('stores redirectAfter when query param present', async () => {
    const store = makeStore();
    const app = new Hono();
    app.get('/auth/slack/initiate', c => handleSlackOidcInitiate(c, CONFIG, store));
    const res = await app.request(
      '/auth/slack/initiate?redirect_after=https%3A%2F%2Fapp.example.com%2Fcb'
    );
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    expect(store.consume(state)?.redirectAfter).toBe('https://app.example.com/cb');
  });

  test('empty redirect_after is treated as absent (not stored as empty string)', async () => {
    const store = makeStore();
    const app = new Hono();
    app.get('/auth/slack/initiate', c => handleSlackOidcInitiate(c, CONFIG, store));
    const res = await app.request('/auth/slack/initiate?redirect_after=');
    const state = new URL(res.headers.get('location')!).searchParams.get('state')!;
    expect(store.consume(state)?.redirectAfter).toBeUndefined();
  });
});

// ─── handleSlackOidcCallback ────────────────────────────────────────────────

function buildCallbackApp(
  store: ISlackOidcStateStore,
  deps: {
    tokenExchange?: SlackTokenExchange;
    userInfoFetcher?: SlackUserInfoFetcher;
  } = {}
): Hono {
  const app = new Hono();
  app.get('/auth/slack/callback', c => handleSlackOidcCallback(c, CONFIG, store, SECRET, deps));
  return app;
}

describe('handleSlackOidcCallback', () => {
  test('happy path (no redirectAfter): returns JSON with a valid session JWT', async () => {
    const store = makeStore();
    const state = store.create({ codeVerifier: 'verifier-abc' });

    const tokenExchange: SlackTokenExchange = async input => {
      expect(input.code).toBe('CODE_XYZ');
      expect(input.codeVerifier).toBe('verifier-abc');
      return { ok: true, access_token: 'AT' };
    };
    const userInfoFetcher: SlackUserInfoFetcher = async at => {
      expect(at).toBe('AT');
      return {
        ok: true,
        sub: 'TTEAM-UALICE',
        email: 'alice@example.com',
        name: 'Alice',
      };
    };

    const app = buildCallbackApp(store, { tokenExchange, userInfoFetcher });
    const res = await app.request(
      `/auth/slack/callback?code=CODE_XYZ&state=${encodeURIComponent(state)}`
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      token: string;
      slackUserId: string;
      email: string;
      displayName: string;
    };
    expect(body.slackUserId).toBe('UALICE');
    expect(body.email).toBe('alice@example.com');
    expect(body.displayName).toBe('Alice');

    const identity = verifyArchonSessionToken(body.token, SECRET);
    expect(identity).toEqual({
      slackUserId: 'UALICE',
      email: 'alice@example.com',
      displayName: 'Alice',
    });
  });

  test('happy path (with redirectAfter): 302 to redirectAfter?token=...', async () => {
    const store = makeStore();
    // redirectAfter must share the same origin as callbackBase (https://archon.example.com).
    const state = store.create({
      codeVerifier: 'verifier-r',
      redirectAfter: 'https://archon.example.com/done?other=1',
    });
    const app = buildCallbackApp(store, {
      tokenExchange: async () => ({ ok: true, access_token: 'AT' }),
      userInfoFetcher: async () => ({ ok: true, sub: 'TT-UBOB' }),
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(302);
    const loc = new URL(res.headers.get('location')!);
    expect(loc.origin + loc.pathname).toBe('https://archon.example.com/done');
    expect(loc.searchParams.get('other')).toBe('1');
    const token = loc.searchParams.get('token')!;
    expect(verifyArchonSessionToken(token, SECRET)?.slackUserId).toBe('UBOB');
  });

  test('expired/replayed state → 400', async () => {
    const store = makeStore();
    const state = store.create({ codeVerifier: 'verifier-once' });
    // Consume once so callback gets null on its own consume() call.
    store.consume(state);
    const app = buildCallbackApp(store, {
      tokenExchange: async () => {
        throw new Error('should not be called');
      },
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
  });

  test('Slack returned an OAuth error in the query string → 400', async () => {
    const store = makeStore();
    const app = buildCallbackApp(store);
    const res = await app.request('/auth/slack/callback?error=access_denied');
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.detail).toBe('access_denied');
  });

  test('missing code or state → 400', async () => {
    const store = makeStore();
    const app = buildCallbackApp(store);
    const r1 = await app.request('/auth/slack/callback?state=anything');
    expect(r1.status).toBe(400);
    const r2 = await app.request('/auth/slack/callback?code=anything');
    expect(r2.status).toBe(400);
  });

  test('token endpoint throws (network failure) → 502', async () => {
    const store = makeStore();
    const state = store.create({ codeVerifier: 'v' });
    const app = buildCallbackApp(store, {
      tokenExchange: async () => {
        throw new Error('boom');
      },
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(502);
  });

  test('token endpoint returns ok:false → 400', async () => {
    const store = makeStore();
    const state = store.create({ codeVerifier: 'v' });
    const app = buildCallbackApp(store, {
      tokenExchange: async () => ({ ok: false, error: 'invalid_code' }),
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; detail: string };
    expect(body.detail).toBe('invalid_code');
  });

  test('userinfo throws → 502', async () => {
    const store = makeStore();
    const state = store.create({ codeVerifier: 'v' });
    const app = buildCallbackApp(store, {
      tokenExchange: async () => ({ ok: true, access_token: 'AT' }),
      userInfoFetcher: async () => {
        throw new Error('boom');
      },
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(502);
  });

  test('userinfo returns ok:false → 400', async () => {
    const store = makeStore();
    const state = store.create({ codeVerifier: 'v' });
    const app = buildCallbackApp(store, {
      tokenExchange: async () => ({ ok: true, access_token: 'AT' }),
      userInfoFetcher: async () => ({ ok: false, error: 'invalid_token' }),
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
  });

  test('malformed redirectAfter URL → 400 (not a server crash)', async () => {
    const store = makeStore();
    const state = store.create({
      codeVerifier: 'v',
      redirectAfter: 'not-a-url',
    });
    const app = buildCallbackApp(store, {
      tokenExchange: async () => ({ ok: true, access_token: 'AT' }),
      userInfoFetcher: async () => ({ ok: true, sub: 'TT-UCAROL' }),
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
  });

  test('cross-origin redirectAfter → 400 (open-redirect guard)', async () => {
    const store = makeStore();
    const state = store.create({
      codeVerifier: 'v',
      redirectAfter: 'https://attacker.example.com/steal',
    });
    const app = buildCallbackApp(store, {
      tokenExchange: async () => ({ ok: true, access_token: 'AT' }),
      userInfoFetcher: async () => ({ ok: true, sub: 'TT-UDAVE' }),
    });
    const res = await app.request(`/auth/slack/callback?code=C&state=${encodeURIComponent(state)}`);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('redirect_after origin not permitted');
  });
});
