import { describe, expect, it } from 'vitest';

describe('fake-indexeddb', () => {
  it('is installed globally', () => {
    expect(typeof indexedDB.open).toBe('function');
  });
});
