import { describe, test, expect, beforeEach } from 'bun:test';
import { isAcceptingNewWork, setAcceptingNewWork, resetForTests } from './drain-state';

describe('drain-state', () => {
  beforeEach(() => {
    resetForTests();
  });

  test('starts in accepting state', () => {
    expect(isAcceptingNewWork()).toBe(true);
  });

  test('setAcceptingNewWork(false) flips the flag', () => {
    setAcceptingNewWork(false);
    expect(isAcceptingNewWork()).toBe(false);
  });

  test('flag persists across reads (no auto-reset)', () => {
    setAcceptingNewWork(false);
    expect(isAcceptingNewWork()).toBe(false);
    expect(isAcceptingNewWork()).toBe(false);
  });

  test('setAcceptingNewWork(true) restores acceptance', () => {
    setAcceptingNewWork(false);
    setAcceptingNewWork(true);
    expect(isAcceptingNewWork()).toBe(true);
  });
});
