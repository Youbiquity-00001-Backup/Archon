import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { access, mkdtemp, readFile, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createMockLogger } from '../test/mocks/logger';

// Logger mock — must be installed before the module under test imports.
const mockLogger = createMockLogger();
mock.module('@archon/paths', () => ({
  createLogger: mock(() => mockLogger),
  getArchonHome: () => '/tmp/archon-test-home-unused',
}));

import {
  UserCredsService,
  InMemorySecretStore,
  type AnthropicProbe,
  type GithubProbe,
  type GithubRefresh,
  type UserCreds,
} from './user-creds';

describe('UserCredsService', () => {
  let usersDir: string;
  let store: InMemorySecretStore;
  let probes: { anthropic: AnthropicProbe; github: GithubProbe };

  beforeEach(async () => {
    usersDir = await mkdtemp(join(tmpdir(), 'archon-user-creds-'));
    store = new InMemorySecretStore();
    // Default probes: always-OK so happy paths work without explicit overrides.
    probes = {
      anthropic: async () => ({ ok: true, accountEmail: 'alice@example.com' }),
      github: async () => ({ ok: true, login: 'alice' }),
    };
  });

  function newService(): UserCredsService {
    return new UserCredsService({
      store,
      usersDir,
      anthropicProbe: probes.anthropic,
      githubProbe: probes.github,
    });
  }

  describe('bootstrap', () => {
    test('rebuilds cache + per-user files from existing secret store entries', async () => {
      const seeded = {
        anthropic: {
          claudeAiOauth: { accessToken: 'sk-test-anthropic' },
          accountEmail: 'alice@example.com',
        },
        github: { type: 'oauth', accessToken: 'gho_test', login: 'alice' },
      };
      store.seed('U1', JSON.stringify(seeded));

      const svc = newService();
      await svc.bootstrap();

      const overlay = svc.getEnvOverlay('U1');
      expect(overlay).not.toBeNull();
      expect(overlay?.HOME).toBe(join(usersDir, 'U1'));
      expect(overlay?.GH_TOKEN).toBe('gho_test');
      expect(overlay?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-test-anthropic');

      // Disk materialization too — that's what the orchestrator's HOME-overlay
      // depends on for git/Claude SDK to find the right credential files.
      const credsJson = await readFile(
        join(usersDir, 'U1', '.claude', '.credentials.json'),
        'utf8'
      );
      expect(credsJson).toContain('sk-test-anthropic');
      const gitCreds = await readFile(join(usersDir, 'U1', '.git-credentials'), 'utf8');
      expect(gitCreds).toBe('https://x-access-token:gho_test@github.com\n');
    });

    test('is idempotent (second call is a no-op)', async () => {
      store.seed(
        'U1',
        JSON.stringify({ github: { type: 'oauth', accessToken: 'g1', login: 'l' } })
      );
      const svc = newService();
      await svc.bootstrap();
      await svc.bootstrap();
      expect(svc.isBootstrapped()).toBe(true);
    });

    test('one bad entry does not block the rest', async () => {
      store.seed('U1', '{ this is not json');
      store.seed(
        'U2',
        JSON.stringify({ github: { type: 'oauth', accessToken: 'gh-ok', login: 'l' } })
      );
      const svc = newService();
      await svc.bootstrap();

      expect(svc.getEnvOverlay('U1')).toBeNull();
      expect(svc.getEnvOverlay('U2')?.GH_TOKEN).toBe('gh-ok');
    });

    test('skips tombstone entries (empty docs left by refresh-chain-dead)', async () => {
      store.seed('U_DEAD', JSON.stringify({}));
      const svc = newService();
      await svc.bootstrap();
      // Tombstone must NOT materialize a HOME-only cache entry — otherwise
      // the orchestrator would build an env overlay pointing at an empty
      // per-user dir and break the global-auth fallback.
      expect(svc.getEnvOverlay('U_DEAD')).toBeNull();
    });
  });

  describe('getEnvOverlay', () => {
    test('returns null for unknown user (matches legacy "no overlay" semantics)', () => {
      expect(newService().getEnvOverlay('UNKNOWN')).toBeNull();
    });

    test('omits GH_TOKEN when only Anthropic creds are present', async () => {
      const svc = newService();
      const result = await svc.upsertAnthropic(
        'U1',
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-only' } })
      );
      expect(result.persisted).toBe(true);
      const overlay = svc.getEnvOverlay('U1');
      expect(overlay?.GH_TOKEN).toBeUndefined();
      expect(overlay?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-only');
      expect(overlay?.HOME).toContain('U1');
    });
  });

  describe('upsertAnthropic', () => {
    test('rejects non-JSON', async () => {
      const result = await newService().upsertAnthropic('U1', 'not-json');
      expect(result.persisted).toBe(false);
      expect(result.replyText).toContain('did not parse');
    });

    test('rejects missing claudeAiOauth.accessToken', async () => {
      const result = await newService().upsertAnthropic(
        'U1',
        JSON.stringify({ claudeAiOauth: {} })
      );
      expect(result.persisted).toBe(false);
      expect(result.replyText).toContain('accessToken');
    });

    test('rejects when Anthropic API rejects the token', async () => {
      probes.anthropic = async () => ({ ok: false, status: 401 });
      const result = await newService().upsertAnthropic(
        'U1',
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-bad' } })
      );
      expect(result.persisted).toBe(false);
      expect(result.replyText).toMatch(/Anthropic rejected/);
    });

    test('persists, materializes, and includes account email in the reply', async () => {
      const svc = newService();
      const result = await svc.upsertAnthropic(
        'U1',
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-good' } })
      );
      expect(result.persisted).toBe(true);
      expect(result.replyText).toContain('alice@example.com');

      const stored = await store.getSecret('U1');
      expect(stored).not.toBeNull();
      const parsed = JSON.parse(stored ?? '{}');
      expect(parsed.anthropic?.accountEmail).toBe('alice@example.com');
      expect(parsed.anthropic?.claudeAiOauth?.accessToken).toBe('sk-good');
    });

    test('preserves an existing GitHub section when an Anthropic upsert lands on top', async () => {
      const svc = newService();
      // Seed GitHub first.
      const ghResult = await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho_first',
      });
      expect(ghResult.persisted).toBe(true);

      // Anthropic upsert merges into the same doc, doesn't drop github.
      await svc.upsertAnthropic(
        'U1',
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-second' } })
      );

      const stored = JSON.parse((await store.getSecret('U1')) ?? '{}');
      expect(stored.github?.accessToken).toBe('gho_first');
      expect(stored.anthropic?.claudeAiOauth?.accessToken).toBe('sk-second');
      // Cache reflects both.
      const overlay = svc.getEnvOverlay('U1');
      expect(overlay?.GH_TOKEN).toBe('gho_first');
      expect(overlay?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-second');
    });
  });

  describe('upsertGithub', () => {
    test('rejects when GitHub probe fails', async () => {
      probes.github = async () => ({ ok: false, status: 401 });
      const result = await newService().upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-bad',
      });
      expect(result.persisted).toBe(false);
      expect(result.replyText).toMatch(/GitHub rejected/);
    });

    test('persists creds and surfaces the GitHub login in the reply', async () => {
      probes.github = async () => ({ ok: true, login: 'octocat' });
      const result = await newService().upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-good',
      });
      expect(result.persisted).toBe(true);
      expect(result.replyText).toContain('octocat');
    });
  });

  describe('getConnectionStatus', () => {
    test('reports both kinds as not linked when no creds are stored', async () => {
      const svc = newService();
      const status = await svc.getConnectionStatus('U_NONE');
      expect(status.anthropic.linked).toBe(false);
      expect(status.github.linked).toBe(false);
    });

    test('exposes the captured Anthropic account email but never the access token', async () => {
      // Override the default probe BEFORE constructing the service, since
      // `newService()` captures the probe references at construction time.
      probes.anthropic = async () => ({ ok: true, accountEmail: 'alice@example.com' });
      const svc = newService();
      await svc.upsertAnthropic(
        'U1',
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-secret' } })
      );
      const status = await svc.getConnectionStatus('U1');
      // Discriminate the union explicitly so the test fails loudly if
      // someone changes the shape and ships tokens to the SPA.
      expect(status.anthropic.linked).toBe(true);
      if (status.anthropic.linked) {
        expect(status.anthropic.accountEmail).toBe('alice@example.com');
      }
      // Sanity: the JSON shape doesn't include the access token even after
      // serialization. This is the "safe to send to the SPA" property.
      const json = JSON.stringify(status);
      expect(json).not.toContain('sk-secret');
    });

    test('exposes the GitHub login but never the access token', async () => {
      probes.github = async () => ({ ok: true, login: 'octocat' });
      const svc = newService();
      await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-very-secret',
        refreshToken: 'ghr-secret',
      });
      const status = await svc.getConnectionStatus('U1');
      expect(status.github.linked).toBe(true);
      if (status.github.linked) {
        expect(status.github.login).toBe('octocat');
      }
      const json = JSON.stringify(status);
      expect(json).not.toContain('gho-very-secret');
      expect(json).not.toContain('ghr-secret');
    });

    test('treats a corrupt stored doc as "not linked" rather than throwing', async () => {
      const svc = newService();
      // Pre-seed the store with garbage; bootstrap would log+skip but we
      // bypass it here to exercise the runtime fetch path explicitly.
      store.seed('U_CORRUPT', '{ this is not json');
      const status = await svc.getConnectionStatus('U_CORRUPT');
      expect(status.anthropic.linked).toBe(false);
      expect(status.github.linked).toBe(false);
    });
  });

  describe('syncFromDisk', () => {
    test('captures Anthropic rotation written by the subprocess', async () => {
      const svc = newService();
      await svc.upsertAnthropic('U1', JSON.stringify({ claudeAiOauth: { accessToken: 'sk-old' } }));

      // Simulate the Claude Code subprocess refreshing creds in place.
      await writeFile(
        join(usersDir, 'U1', '.claude', '.credentials.json'),
        JSON.stringify({
          claudeAiOauth: { accessToken: 'sk-NEW', refreshToken: 'rt-new', expiresAt: 9_999 },
        })
      );

      const result = await svc.syncFromDisk('U1');
      expect(result.rotated).toBe(true);

      // Cache reflects the new access token (so the next env overlay has it).
      expect(svc.getEnvOverlay('U1')?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-NEW');

      // Store reflects the new tokens AND preserves the cosmetic accountEmail.
      const stored = JSON.parse((await store.getSecret('U1')) ?? '{}') as UserCreds;
      expect(stored.anthropic?.claudeAiOauth.accessToken).toBe('sk-NEW');
      expect(stored.anthropic?.claudeAiOauth.refreshToken).toBe('rt-new');
      expect(stored.anthropic?.accountEmail).toBe('alice@example.com');
    });

    test('rotation: false when the disk file matches the cache', async () => {
      const svc = newService();
      await svc.upsertAnthropic(
        'U1',
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-stable' } })
      );
      const result = await svc.syncFromDisk('U1');
      expect(result.rotated).toBe(false);
    });

    test('rotation: false when the user has no cache entry', async () => {
      const svc = newService();
      // No materialize call → no cache entry.
      const result = await svc.syncFromDisk('U_NEVER_LINKED');
      expect(result.rotated).toBe(false);
    });

    test('rotation: false when the credentials file is missing (pre-link state)', async () => {
      const svc = newService();
      // Materialize only GitHub so the user has a cache entry but no
      // .credentials.json on disk.
      await svc.upsertGithub('U1', { type: 'oauth', accessToken: 'gho-1' });
      const result = await svc.syncFromDisk('U1');
      expect(result.rotated).toBe(false);
    });

    test('malformed JSON on disk is logged and treated as no rotation', async () => {
      const svc = newService();
      await svc.upsertAnthropic('U1', JSON.stringify({ claudeAiOauth: { accessToken: 'sk-old' } }));
      await writeFile(join(usersDir, 'U1', '.claude', '.credentials.json'), '{ not json');
      const result = await svc.syncFromDisk('U1');
      expect(result.rotated).toBe(false);
      // Cache still has the old token — bad disk read should not overwrite.
      expect(svc.getEnvOverlay('U1')?.CLAUDE_CODE_OAUTH_TOKEN).toBe('sk-old');
    });

    test('captures GitHub access token written externally', async () => {
      const svc = newService();
      await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-old',
        refreshToken: 'ghr-keep',
      });
      await writeFile(
        join(usersDir, 'U1', '.git-credentials'),
        'https://x-access-token:gho-NEW@github.com\n'
      );
      const result = await svc.syncFromDisk('U1');
      expect(result.rotated).toBe(true);
      expect(svc.getEnvOverlay('U1')?.GH_TOKEN).toBe('gho-NEW');
      // Refresh token / login preserved from the stored doc.
      const stored = JSON.parse((await store.getSecret('U1')) ?? '{}') as UserCreds;
      expect(stored.github?.accessToken).toBe('gho-NEW');
      expect(stored.github?.refreshToken).toBe('ghr-keep');
      expect(stored.github?.login).toBe('alice');
    });

    test('store write failure is logged and reported as no rotation', async () => {
      const svc = newService();
      await svc.upsertAnthropic('U1', JSON.stringify({ claudeAiOauth: { accessToken: 'sk-old' } }));
      await writeFile(
        join(usersDir, 'U1', '.claude', '.credentials.json'),
        JSON.stringify({ claudeAiOauth: { accessToken: 'sk-NEW' } })
      );
      // Replace putSecret with a function that throws — the upsert is done
      // already so the only future write is the one from syncFromDisk.
      store.putSecret = async () => {
        throw new Error('SM unavailable');
      };
      const result = await svc.syncFromDisk('U1');
      expect(result.rotated).toBe(false);
    });
  });

  describe('ensureFreshGithub', () => {
    function fakeRefresh(impl: GithubRefresh): GithubRefresh {
      return impl;
    }

    test('no-op when the user is not linked', async () => {
      const calls: string[] = [];
      const svc = new UserCredsService({
        store,
        usersDir,
        anthropicProbe: probes.anthropic,
        githubProbe: probes.github,
        githubRefresh: fakeRefresh(async rt => {
          calls.push(rt);
          return { ok: true, accessToken: 'x' };
        }),
      });
      await svc.ensureFreshGithub('U_NONE');
      expect(calls).toEqual([]);
    });

    test('no-op when the token still has more than 10 minutes of life', async () => {
      const now = 1_700_000_000_000;
      const calls: string[] = [];
      const svc = new UserCredsService({
        store,
        usersDir,
        anthropicProbe: probes.anthropic,
        githubProbe: probes.github,
        clock: () => now,
        githubRefresh: fakeRefresh(async rt => {
          calls.push(rt);
          return { ok: true };
        }),
      });
      // Token expires in 1 hour — well past the 10-min lead.
      await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-fresh',
        refreshToken: 'ghr-1',
        expiresAt: Math.floor(now / 1000) + 3600,
      });
      await svc.ensureFreshGithub('U1');
      expect(calls).toEqual([]);
    });

    test('refreshes and persists when the token is at the threshold', async () => {
      let now = 1_700_000_000_000;
      const refreshCalls: string[] = [];
      const svc = new UserCredsService({
        store,
        usersDir,
        anthropicProbe: probes.anthropic,
        githubProbe: probes.github,
        clock: () => now,
        githubRefresh: fakeRefresh(async rt => {
          refreshCalls.push(rt);
          return {
            ok: true,
            status: 200,
            accessToken: 'gho-NEW',
            refreshToken: 'ghr-NEW',
            expiresAt: Math.floor(now / 1000) + 28_800,
          };
        }),
      });
      await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-old',
        refreshToken: 'ghr-old',
        expiresAt: Math.floor(now / 1000) + 60, // 60s left → inside the 10min lead
      });
      await svc.ensureFreshGithub('U1');
      expect(refreshCalls).toEqual(['ghr-old']);
      const overlay = svc.getEnvOverlay('U1');
      expect(overlay?.GH_TOKEN).toBe('gho-NEW');
      const stored = JSON.parse((await store.getSecret('U1')) ?? '{}') as UserCreds;
      expect(stored.github?.accessToken).toBe('gho-NEW');
      expect(stored.github?.refreshToken).toBe('ghr-NEW');
      // .git-credentials rewritten with the new token.
      const rewritten = await readFile(join(usersDir, 'U1', '.git-credentials'), 'utf8');
      expect(rewritten).toBe('https://x-access-token:gho-NEW@github.com\n');
    });

    test('a 401 from GitHub tombstones the user and clears dotfiles', async () => {
      const now = 1_700_000_000_000;
      const svc = new UserCredsService({
        store,
        usersDir,
        anthropicProbe: probes.anthropic,
        githubProbe: probes.github,
        clock: () => now,
        githubRefresh: fakeRefresh(async () => ({ ok: false, status: 401 })),
      });
      await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-doomed',
        refreshToken: 'ghr-revoked',
        expiresAt: Math.floor(now / 1000) + 60,
      });
      await svc.ensureFreshGithub('U1');

      // Cache cleared.
      expect(svc.getEnvOverlay('U1')).toBeNull();

      // Tombstone written so bootstrap won't re-materialize.
      const stored = JSON.parse((await store.getSecret('U1')) ?? '{}') as UserCreds;
      expect(stored.github).toBeUndefined();
      expect(stored.anthropic).toBeUndefined();

      // .git-credentials removed (best-effort).
      await expect(access(join(usersDir, 'U1', '.git-credentials'))).rejects.toThrow();
    });

    test('a transient failure leaves the cache untouched for retry', async () => {
      const now = 1_700_000_000_000;
      const svc = new UserCredsService({
        store,
        usersDir,
        anthropicProbe: probes.anthropic,
        githubProbe: probes.github,
        clock: () => now,
        githubRefresh: fakeRefresh(async () => ({ ok: false, status: 503 })),
      });
      await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-old',
        refreshToken: 'ghr-old',
        expiresAt: Math.floor(now / 1000) + 60,
      });
      await svc.ensureFreshGithub('U1');
      // Cache still has the old token — next call retries.
      expect(svc.getEnvOverlay('U1')?.GH_TOKEN).toBe('gho-old');
    });

    test('no-op when no refresh token is stored', async () => {
      const now = 1_700_000_000_000;
      const calls: string[] = [];
      const svc = new UserCredsService({
        store,
        usersDir,
        anthropicProbe: probes.anthropic,
        githubProbe: probes.github,
        clock: () => now,
        githubRefresh: fakeRefresh(async rt => {
          calls.push(rt);
          return { ok: true };
        }),
      });
      await svc.upsertGithub('U1', {
        type: 'oauth',
        accessToken: 'gho-no-refresh',
        // No refreshToken
        expiresAt: Math.floor(now / 1000) + 60,
      });
      await svc.ensureFreshGithub('U1');
      expect(calls).toEqual([]);
    });
  });

  describe('selfFallbackToken', () => {
    test('returns null when codebase has no registrar', async () => {
      const svc = newService();
      await svc.upsertGithub('U1', { type: 'oauth', accessToken: 'gh-1' });
      expect(await svc.selfFallbackToken('U1', null)).toBeNull();
    });

    test('returns null for cross-user requests (no borrowing across users)', async () => {
      const svc = newService();
      await svc.upsertGithub('U1', { type: 'oauth', accessToken: 'gh-1' });
      await svc.upsertGithub('U2', { type: 'oauth', accessToken: 'gh-2' });
      // U2 requesting against codebase registered by U1 → null.
      expect(await svc.selfFallbackToken('U2', 'U1')).toBeNull();
    });

    test('returns the requesting user’s own token when they registered the codebase', async () => {
      const svc = newService();
      await svc.upsertGithub('U1', { type: 'oauth', accessToken: 'gh-self' });
      expect(await svc.selfFallbackToken('U1', 'U1')).toBe('gh-self');
    });
  });
});

describe('InMemorySecretStore', () => {
  test('round-trips writes', async () => {
    const s = new InMemorySecretStore();
    await s.putSecret('A', '{}');
    expect(await s.getSecret('A')).toBe('{}');
    expect(await s.listSecretIds()).toContain('A');
  });

  test('seed bypasses the put pipeline (used for tests only)', async () => {
    const s = new InMemorySecretStore();
    s.seed('A', '{"hi":1}');
    expect(await s.getSecret('A')).toBe('{"hi":1}');
  });

  test('clear empties the store', async () => {
    const s = new InMemorySecretStore();
    await s.putSecret('A', '{}');
    s.clear();
    expect(await s.listSecretIds()).toEqual([]);
  });
});
