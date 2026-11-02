import { describe, expect, it } from 'vitest';
import {
  generateGroupPassword,
  groupPasswordStrength,
  isValidGroupTitle,
  parseGroupExpiryDays,
} from './public-chat-group.js';

describe('FR-PCHAT-043 group room helpers', () => {
  it('generates the requested length from the safe alphabet', () => {
    const p = generateGroupPassword(20);
    expect(p).toHaveLength(20);
    expect(p).toMatch(/^[A-HJ-NP-Za-km-z2-9_-]+$/);
  });

  it('rejects out-of-range bytes instead of folding them (no modulo bias)', () => {
    // 255 >= limit (256 - 256 % 58 = 232) must be skipped; 0 maps to the first symbol
    const feed = [255, 240, 0, 1, 2];
    const p = generateGroupPassword(3, (b) => b.map((_, i) => feed[i % feed.length] ?? 0));
    expect(p).toBe('ABC');
  });

  it('rates strength by length and treats repeats as weak', () => {
    expect(groupPasswordStrength('')).toBe('empty');
    expect(groupPasswordStrength('abc')).toBe('invalid');
    expect(groupPasswordStrength('abcdef1')).toBe('weak');
    expect(groupPasswordStrength('aaaaaaaaaaaaaaaaaaaa')).toBe('weak');
    expect(groupPasswordStrength('abcdefghijkl')).toBe('good');
    expect(groupPasswordStrength('abcdefghijklmnop')).toBe('strong');
    expect(groupPasswordStrength('x'.repeat(73))).toBe('invalid');
  });

  it('validates expiry days and titles without silent defaults', () => {
    expect(parseGroupExpiryDays('30')).toBe(30);
    expect(parseGroupExpiryDays('')).toBeNull();
    expect(parseGroupExpiryDays('1.5')).toBeNull();
    expect(parseGroupExpiryDays('0')).toBeNull();
    expect(parseGroupExpiryDays('366')).toBeNull();
    expect(isValidGroupTitle('  ')).toBe(false);
    expect(isValidGroupTitle('Friday planning')).toBe(true);
  });
});
