import { describe, test, expect, beforeEach, mock } from 'bun:test';
import { mkdtemp, readFile } from 'fs/promises';
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
      expect(overlay?.ANTHROPIC_API_KEY).toBe('sk-test-anthropic');

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
      store.seed('U1', JSON.stringify({ github: { type: 'oauth', accessToken: 'g1', login: 'l' } }));
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
      expect(overlay?.ANTHROPIC_API_KEY).toBe('sk-only');
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
      expect(overlay?.ANTHROPIC_API_KEY).toBe('sk-second');
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
