import { describe, it, expect } from 'vitest';
import { isAbortError } from '../lib/abortable';

describe('isAbortError', () => {
  it('returns true for native AbortError', () => {
    const e = new DOMException('Aborted', 'AbortError');
    expect(isAbortError(e)).toBe(true);
  });

  it('returns true for axios CanceledError (by name)', () => {
    const e = { name: 'CanceledError', message: 'canceled' };
    expect(isAbortError(e)).toBe(true);
  });

  it('returns true for axios CanceledError (by code)', () => {
    const e = { name: 'Error', code: 'ERR_CANCELED' };
    expect(isAbortError(e)).toBe(true);
  });

  it('returns false for a regular Error', () => {
    expect(isAbortError(new Error('nope'))).toBe(false);
  });

  it('returns false for null and primitives', () => {
    expect(isAbortError(null)).toBe(false);
    expect(isAbortError(undefined)).toBe(false);
    expect(isAbortError(42)).toBe(false);
    expect(isAbortError('boom')).toBe(false);
  });
});
