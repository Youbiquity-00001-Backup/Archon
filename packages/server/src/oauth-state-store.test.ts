import { describe, test, expect } from 'bun:test';
import { InMemoryOAuthStateStore, InMemorySlackOidcStateStore } from './oauth-state-store';

describe('InMemoryOAuthStateStore', () => {
  test('roundtrips token → slack user id', () => {
    const store = new InMemoryOAuthStateStore();
    const token = store.create('U_ALICE');
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(store.consume(token)).toBe('U_ALICE');
  });

  test('rejects empty slack user id (programmer error, not user input)', () => {
    const store = new InMemoryOAuthStateStore();
    expect(() => store.create('')).toThrow();
  });

  test('single-use: a token cannot be consumed twice (replay protection)', () => {
    const store = new InMemoryOAuthStateStore();
    const token = store.create('U_BOB');
    expect(store.consume(token)).toBe('U_BOB');
    expect(store.consume(token)).toBeNull();
  });

  test('expired tokens return null even if cached', () => {
    let now = 1_000_000;
    const store = new InMemoryOAuthStateStore({
      defaultTtlMs: 5_000,
      clock: () => now,
    });
    const token = store.create('U_CAROL');
    now += 10_000;
    expect(store.consume(token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  test('consume of unknown token returns null', () => {
    expect(new InMemoryOAuthStateStore().consume('not-a-real-token')).toBeNull();
  });
});

describe('InMemorySlackOidcStateStore', () => {
  test('roundtrips token → state data', () => {
    const store = new InMemorySlackOidcStateStore();
    const token = store.create({
      codeVerifier: 'v_abc',
      redirectAfter: 'https://example.com/cb',
    });
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    const got = store.consume(token);
    expect(got).toEqual({
      codeVerifier: 'v_abc',
      redirectAfter: 'https://example.com/cb',
    });
  });

  test('redirectAfter is optional', () => {
    const store = new InMemorySlackOidcStateStore();
    const token = store.create({ codeVerifier: 'v_xyz' });
    expect(store.consume(token)).toEqual({ codeVerifier: 'v_xyz' });
  });

  test('rejects empty codeVerifier (programmer error)', () => {
    const store = new InMemorySlackOidcStateStore();
    expect(() => store.create({ codeVerifier: '' })).toThrow();
  });

  test('single-use: a state token cannot be consumed twice (PKCE replay protection)', () => {
    const store = new InMemorySlackOidcStateStore();
    const token = store.create({ codeVerifier: 'v_once' });
    expect(store.consume(token)).not.toBeNull();
    expect(store.consume(token)).toBeNull();
  });

  test('expired state returns null and is evicted', () => {
    let now = 1_000_000;
    const store = new InMemorySlackOidcStateStore({
      defaultTtlMs: 5_000,
      clock: () => now,
    });
    const token = store.create({ codeVerifier: 'v_x' });
    now += 10_000;
    expect(store.consume(token)).toBeNull();
    expect(store.size()).toBe(0);
  });

  test('per-call TTL overrides default', () => {
    let now = 0;
    const store = new InMemorySlackOidcStateStore({
      defaultTtlMs: 1_000,
      clock: () => now,
    });
    const token = store.create({ codeVerifier: 'v_short' }, 100);
    now += 500;
    expect(store.consume(token)).toBeNull();
  });

  test('clear() empties the map', () => {
    const store = new InMemorySlackOidcStateStore();
    store.create({ codeVerifier: 'v_a' });
    store.create({ codeVerifier: 'v_b' });
    store.clear();
    expect(store.size()).toBe(0);
  });

  test('different tokens for repeated create() calls', () => {
    const store = new InMemorySlackOidcStateStore();
    const a = store.create({ codeVerifier: 'v_dup' });
    const b = store.create({ codeVerifier: 'v_dup' });
    expect(a).not.toBe(b);
  });
});
