import { describe, test, expect, mock } from 'bun:test';
import { Hono } from 'hono';
import {
  buildGithubAuthorizeUrl,
  handleGithubOAuthCallback,
  handleGithubOAuthInitiate,
  type GithubOAuthConfig,
  type GithubTokenExchange,
} from './auth-github';
import { InMemoryOAuthStateStore } from './oauth-state-store';
import { UserCredsService, InMemorySecretStore } from '@archon/core';

/** Build a minimal app that wires the callback for a single route hit. */
function buildApp(opts: {
  config: GithubOAuthConfig;
  stateStore: InMemoryOAuthStateStore;
  userCreds: UserCredsService;
  tokenExchange: GithubTokenExchange;
}): Hono {
  const app = new Hono();
  app.get('/auth/github/callback', async c =>
    handleGithubOAuthCallback(c, {
      config: opts.config,
      stateStore: opts.stateStore,
      userCreds: opts.userCreds,
      tokenExchange: opts.tokenExchange,
    })
  );
  app.get('/auth/github/initiate', async c =>
    handleGithubOAuthInitiate(c, {
      config: opts.config,
      stateStore: opts.stateStore,
      // Not used by callback tests; keep null so the initiate test can flip
      // its own resolver.
      resolveSlackUserId: async () => null,
    })
  );
  return app;
}

const validConfig: GithubOAuthConfig = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  callbackBase: 'https://archon.test',
};

function newStubProbes() {
  return {
    anthropic: mock(async () => ({ ok: true })),
    github: mock(async (_token: string) => ({ ok: true, login: 'octocat' })),
  };
}

function newCredsService() {
  const probes = newStubProbes();
  const svc = new UserCredsService({
    store: new InMemorySecretStore(),
    usersDir: '/tmp/archon-test-users',
    anthropicProbe: async tok => probes.anthropic(tok),
    githubProbe: async tok => probes.github(tok),
  });
  return { svc, probes };
}

describe('buildGithubAuthorizeUrl', () => {
  test('produces a URL bound to a fresh state token', () => {
    const stateStore = new InMemoryOAuthStateStore();
    const url = buildGithubAuthorizeUrl({
      config: validConfig,
      stateStore,
      slackUserId: 'U1',
    });
    expect(url).toContain('https://github.com/login/oauth/authorize?');
    expect(url).toContain('client_id=test-client-id');
    expect(url).toContain('redirect_uri=https%3A%2F%2Farchon.test%2Fauth%2Fgithub%2Fcallback');
    const stateMatch = /state=([^&]+)/.exec(url);
    expect(stateMatch).not.toBeNull();
    // Token is consumable, returns the bound user.
    const tok = decodeURIComponent(stateMatch?.[1] ?? '');
    expect(stateStore.consume(tok)).toBe('U1');
  });
});

describe('handleGithubOAuthCallback', () => {
  test('400s when code or state is missing', async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const { svc } = newCredsService();
    const app = buildApp({
      config: validConfig,
      stateStore,
      userCreds: svc,
      tokenExchange: async () => ({ access_token: 'x' }),
    });
    const res = await app.request('/auth/github/callback?state=abc');
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(body).toContain('Missing');
  });

  test('400s on invalid/expired state', async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const { svc } = newCredsService();
    const app = buildApp({
      config: validConfig,
      stateStore,
      userCreds: svc,
      tokenExchange: async () => ({ access_token: 'x' }),
    });
    const res = await app.request('/auth/github/callback?code=c&state=does-not-exist');
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/expired or already used/);
  });

  test('400s when GitHub rejects the token exchange', async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const { svc } = newCredsService();
    const state = stateStore.create('U1');
    const tokenExchange: GithubTokenExchange = mock(async () => ({
      access_token: '',
      error: 'bad_verification_code',
      error_description: 'The code passed is incorrect or expired.',
    }));
    const app = buildApp({
      config: validConfig,
      stateStore,
      userCreds: svc,
      tokenExchange,
    });
    const res = await app.request(`/auth/github/callback?code=anycode&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/incorrect or expired/);
  });

  test('happy path persists creds and returns 200 with the GitHub login', async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const { svc, probes } = newCredsService();
    probes.github.mockImplementation(async () => ({ ok: true, login: 'octocat' }));
    const state = stateStore.create('U1');
    const tokenExchange: GithubTokenExchange = mock(async () => ({
      access_token: 'gho-fresh',
      refresh_token: 'ghr-fresh',
      expires_in: 28_800,
      refresh_token_expires_in: 15_552_000,
    }));
    const app = buildApp({
      config: validConfig,
      stateStore,
      userCreds: svc,
      tokenExchange,
    });
    const res = await app.request(`/auth/github/callback?code=anycode&state=${state}`);
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('octocat');
    // Cred materialized → orchestrator overlay sees the new GH_TOKEN.
    expect(svc.getEnvOverlay('U1')?.GH_TOKEN).toBe('gho-fresh');
  });

  test('exchange throwing is surfaced as a generic 400', async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const { svc } = newCredsService();
    const state = stateStore.create('U1');
    const app = buildApp({
      config: validConfig,
      stateStore,
      userCreds: svc,
      tokenExchange: async () => {
        throw new Error('connect ECONNREFUSED');
      },
    });
    const res = await app.request(`/auth/github/callback?code=c&state=${state}`);
    expect(res.status).toBe(400);
    expect(await res.text()).toMatch(/GitHub did not respond/);
  });
});

describe('handleGithubOAuthInitiate', () => {
  test('401s when the request has no resolved Slack identity (Phase A.1 default)', async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const { svc } = newCredsService();
    const app = buildApp({
      config: validConfig,
      stateStore,
      userCreds: svc,
      tokenExchange: async () => ({ access_token: 'x' }),
    });
    const res = await app.request('/auth/github/initiate');
    expect(res.status).toBe(401);
  });

  test('redirects when the resolver returns a slack id', async () => {
    const stateStore = new InMemoryOAuthStateStore();
    const { svc } = newCredsService();
    const app = new Hono();
    app.get('/auth/github/initiate', async c =>
      handleGithubOAuthInitiate(c, {
        config: validConfig,
        stateStore,
        resolveSlackUserId: async () => 'U_AUTHED',
      })
    );
    const res = await app.request('/auth/github/initiate', { redirect: 'manual' });
    expect(res.status).toBe(302);
    const location = res.headers.get('location') ?? '';
    expect(location).toContain('https://github.com/login/oauth/authorize');
    expect(location).toContain('client_id=test-client-id');
  });
});
