import { describe, it, expect } from 'vitest';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const formula = require('../services/formula');
const wordlist = require('../services/wordlist');

const ev = (src, ctx = {}) => formula.evaluate(src, ctx);
const WORDS = new Set(wordlist.WORDS);

describe('wordlist', () => {
  it('is lowercase a-z, deduped, and covers 3–9 letters', () => {
    expect(wordlist.WORDS.length).toBeGreaterThan(500);
    expect(wordlist.WORDS.every((w) => /^[a-z]+$/.test(w))).toBe(true);
    expect(WORDS.size).toBe(wordlist.WORDS.length);
    for (let l = 3; l <= 9; l++) expect(wordlist.wordsBetween(l, l).length).toBeGreaterThan(10);
  });
});

describe('formula generators', () => {
  it('word(min,max) returns a library word in range', () => {
    for (let i = 0; i < 200; i++) {
      const w = ev('word(4,8)');
      expect(WORDS.has(w)).toBe(true);
      expect(w.length).toBeGreaterThanOrEqual(4);
      expect(w.length).toBeLessThanOrEqual(8);
    }
    expect(ev('word(5)')).toHaveLength(5);
  });

  it('word() errors clearly when no word fits', () => {
    expect(() => ev('word(20,30)')).toThrow(/no library words/);
    expect(() => ev('word(8,4)')).toThrow(/less than min/);
  });

  it('num(n) returns exactly n digits (as a string, leading zeros kept)', () => {
    for (let i = 0; i < 100; i++) expect(ev('num(4)')).toMatch(/^\d{4}$/);
    expect(() => ev('num(0)')).toThrow(/digit count/);
  });

  it('special(n[,set]) draws from the default or given set', () => {
    for (let i = 0; i < 100; i++) {
      const s = ev('special(2)');
      expect(s).toHaveLength(2);
      for (const c of s) expect(formula.DEFAULT_SPECIALS).toContain(c);
    }
    expect(ev('special(3, "!")')).toBe('!!!');
    expect(ev('special()')).toHaveLength(1);
  });

  it('rand(a,b) and pick() stay in bounds', () => {
    for (let i = 0; i < 100; i++) {
      const n = Number(ev('rand(1,3)'));
      expect([1, 2, 3]).toContain(n);
      expect(['a', 'b']).toContain(ev('pick("a","b")'));
    }
  });
});

describe('upper / lower with a count', () => {
  it('0 or omitted = whole string; n = first n chars', () => {
    expect(ev('upper("maple")')).toBe('MAPLE');
    expect(ev('upper("maple",0)')).toBe('MAPLE');
    expect(ev('upper("maple",1)')).toBe('Maple');
    expect(ev('upper("maple",3)')).toBe('MAPle');
    expect(ev('upper("ab",5)')).toBe('AB');
    expect(ev('lower("MAPLE",2)')).toBe('maPLE');
    expect(ev('lower("MAPLE")')).toBe('maple');
  });

  it('existing one-arg formulas are unchanged', () => {
    const ctx = { field: { 'hr-first': 'John', 'hr-last': 'Doe' } };
    expect(ev('lower( slice({field.hr-first},0,1) ~ {field.hr-last} )', ctx)).toBe('jdoe');
  });
});

describe('minlen', () => {
  const PW = 'minlen( upper(word(4,8),1) ~ word(4,8) ~ num(2) ~ special(1), 12 )';

  it('always meets the minimum for the password recipe', () => {
    for (let i = 0; i < 300; i++) {
      const v = ev(PW);
      expect(v.length).toBeGreaterThanOrEqual(12);
      expect(v).toMatch(/^[A-Z][a-z]+\d{2}[^A-Za-z0-9]$/);
    }
  });

  it('honours an optional max', () => {
    for (let i = 0; i < 100; i++) {
      const v = ev('minlen(word(3,9) ~ num(2), 8, 10)');
      expect(v.length).toBeGreaterThanOrEqual(8);
      expect(v.length).toBeLessThanOrEqual(10);
    }
  });

  it('fails clearly when the length is unreachable', () => {
    expect(() => ev('minlen(word(3,3) ~ num(1), 20)')).toThrow(/couldn't produce/);
    expect(() => ev('minlen("abc", 5)')).toThrow(/3 chars, needs at least 5/);
    expect(ev('minlen("abcdef", 5)')).toBe('abcdef');
  });

  it('returns "" in safe mode instead of throwing', () => {
    expect(formula.evaluate('minlen("abc", 5)', {}, { safe: true })).toBe('');
  });
});

describe('isVolatile', () => {
  it('flags formulas that call a generator anywhere in the tree', () => {
    expect(formula.isVolatile('word(4,8)')).toBe(true);
    expect(formula.isVolatile('upper({field.x}) ~ if(1, num(2), "x")')).toBe(true);
    expect(formula.isVolatile('minlen(special(1) ~ "a", 2)')).toBe(true);
    expect(formula.isVolatile('upper({field.first}, 1) ~ "x"')).toBe(false);
    expect(formula.isVolatile('not valid (')).toBe(false);
  });
});
