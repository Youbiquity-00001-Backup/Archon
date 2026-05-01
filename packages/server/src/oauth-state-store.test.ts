import { describe, test, expect } from 'bun:test';
import { InMemoryOAuthStateStore } from './oauth-state-store';

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
    now += 10_000; // 10s later, default TTL is 5s
    expect(store.consume(token)).toBeNull();
    // And expired tokens are also evicted (not just hidden) — replay-safe.
    expect(store.size()).toBe(0);
  });

  test('different tokens for repeated create() calls', () => {
    const store = new InMemoryOAuthStateStore();
    const a = store.create('U_X');
    const b = store.create('U_X');
    expect(a).not.toBe(b);
  });

  test('per-call TTL overrides default', () => {
    let now = 0;
    const store = new InMemoryOAuthStateStore({ defaultTtlMs: 1_000, clock: () => now });
    const shortLived = store.create('U_X', 100);
    now += 500;
    expect(store.consume(shortLived)).toBeNull();
  });

  test('consume of unknown token returns null (defensive)', () => {
    expect(new InMemoryOAuthStateStore().consume('not-a-real-token')).toBeNull();
  });

  test('clear() empties the map', () => {
    const store = new InMemoryOAuthStateStore();
    store.create('U_A');
    store.create('U_B');
    store.clear();
    expect(store.size()).toBe(0);
  });
});
