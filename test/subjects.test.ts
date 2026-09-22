import { describe, expect, it } from 'vitest';
import {
  covers,
  hasWildcards,
  isLiteralSubject,
  isValidPattern,
  literalPrefix,
  matches,
  minimize,
  overlaps,
} from '../src/subjects.js';

describe('isValidPattern', () => {
  it.each([
    ['SENSORS.reading', true],
    ['SENSORS.*', true],
    ['SENSORS.>', true],
    ['*', true],
    ['>', true],
    ['$JS.API.CONSUMER.CREATE.S.*.F', true],
    ['', false],
    ['SENSORS..reading', false],
    ['.SENSORS', false],
    ['SENSORS.', false],
    ['SENSORS.>.x', false],
    ['SENSORS reading', false],
    ['DEVICE-*', true],
  ])('%s → %s', (pattern, expected) => {
    expect(isValidPattern(pattern)).toBe(expected);
  });
});

describe('matches', () => {
  it.each([
    ['SENSORS.reading', 'SENSORS.reading', true],
    ['SENSORS.reading', 'SENSORS.calibrated', false],
    ['SENSORS.*', 'SENSORS.reading', true],
    ['SENSORS.*', 'SENSORS.reading.v1', false],
    ['SENSORS.>', 'SENSORS.reading', true],
    ['SENSORS.>', 'SENSORS.reading.v1', true],
    ['SENSORS.>', 'SENSORS', false],
    ['*.reading', 'SENSORS.reading', true],
    ['*', 'SENSORS.reading', false],
    ['>', 'anything.at.all', true],
    ['DEVICE-*', 'DEVICE-1', false],
    ['DEVICE-*', 'DEVICE-*', true],
  ])('%s matches %s → %s', (pattern, subject, expected) => {
    expect(matches(pattern, subject)).toBe(expected);
  });
});

describe('covers', () => {
  it.each([
    ['SENSORS.>', 'SENSORS.reading', true],
    ['SENSORS.>', 'SENSORS.*', true],
    ['SENSORS.>', 'SENSORS.*.>', true],
    ['SENSORS.*', 'SENSORS.reading', true],
    ['SENSORS.*', 'SENSORS.>', false],
    ['SENSORS.*', 'SENSORS.*', true],
    ['SENSORS.reading', 'SENSORS.*', false],
    ['SENSORS.reading', 'SENSORS.reading', true],
    ['*.>', 'SENSORS.reading', true],
    ['>', 'SENSORS.>', true],
    ['SENSORS.>', 'SENSORS', false],
    ['SENSORS.*.done', 'SENSORS.x.done', true],
    ['SENSORS.*.done', 'SENSORS.x.y.done', false],
    ['A.B', 'A.B.C', false],
  ])('%s covers %s → %s', (broad, narrow, expected) => {
    expect(covers(broad, narrow)).toBe(expected);
  });

  it('is reflexive and transitive on a sample lattice', () => {
    const lattice = ['A.>', 'A.*', 'A.B', 'A.*.>', 'A.B.>', 'A.B.C', '>'];
    for (const p of lattice) expect(covers(p, p)).toBe(true);
    for (const a of lattice)
      for (const b of lattice)
        for (const c of lattice) {
          if (covers(a, b) && covers(b, c)) expect(covers(a, c), `${a} ⊇ ${b} ⊇ ${c}`).toBe(true);
        }
  });
});

describe('overlaps', () => {
  it.each([
    ['SENSORS.>', 'SENSORS.reading', true],
    ['SENSORS.*', 'SENSORS.>', true],
    ['SENSORS.reading', 'SENSORS.calibrated', false],
    ['*.reading', 'SENSORS.*', true],
    ['A.B.C', 'A.>', true],
    ['A.B', 'A.B.C', false],
    ['A.*', 'B.*', false],
    ['>', 'A', true],
  ])('%s overlaps %s → %s', (a, b, expected) => {
    expect(overlaps(a, b)).toBe(expected);
    expect(overlaps(b, a)).toBe(expected);
  });
});

describe('minimize', () => {
  it('drops covered entries, dedupes and sorts system subjects first', () => {
    expect(minimize(['SENSORS.reading', 'SENSORS.>', 'SENSORS.reading', '_INBOX.>', '$JS.ACK.>', 'A.B'])).toEqual([
      '$JS.ACK.>',
      '_INBOX.>',
      'A.B',
      'SENSORS.>',
    ]);
  });
  it('keeps two entries that merely overlap', () => {
    expect(minimize(['*.reading', 'SENSORS.*'])).toEqual(['*.reading', 'SENSORS.*']);
  });
});

describe('helpers', () => {
  it('hasWildcards / isLiteralSubject / literalPrefix', () => {
    expect(hasWildcards('A.B')).toBe(false);
    expect(hasWildcards('A.*')).toBe(true);
    expect(isLiteralSubject('A.B')).toBe(true);
    expect(isLiteralSubject('A.>')).toBe(false);
    expect(literalPrefix('A.B.*.C')).toBe('A.B');
    expect(literalPrefix('>')).toBe('');
  });
});
