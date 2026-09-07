import { describe, expect, it } from '@jest/globals';
import { isSearchable, parseAroundSeq, stripMarks } from '../search-utils';

/**
 * TASK-MOB-014 — search helpers (FR-SRCH-001/002, mirrors TC-SRCH-006).
 */
describe('search utils', () => {
  it('stripMarks collapses server highlight markup for RN Text', () => {
    expect(stripMarks('hello <mark>world</mark>')).toBe('hello «world»');
    expect(stripMarks('escaped &amp; stays')).toBe('escaped &amp; stays');
    expect(stripMarks('<mark>ประชุม</mark>พรุ่งนี้')).toBe('«ประชุม»พรุ่งนี้');
  });

  it('isSearchable requires 2+ characters (TC-SRCH-006 client mirror)', () => {
    expect(isSearchable('')).toBe(false);
    expect(isSearchable(' a ')).toBe(false);
    expect(isSearchable('ab')).toBe(true);
    expect(isSearchable(' ประชุม ')).toBe(true);
  });

  it('parseAroundSeq accepts positive integers only', () => {
    expect(parseAroundSeq(undefined)).toBeUndefined();
    expect(parseAroundSeq('')).toBeUndefined();
    expect(parseAroundSeq('abc')).toBeUndefined();
    expect(parseAroundSeq('-5')).toBeUndefined();
    expect(parseAroundSeq('40')).toBe(40);
  });
});
