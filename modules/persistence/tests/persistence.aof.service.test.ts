import { describe, expect, it } from 'vitest';

import PersistenceService from '../persistence.service';

const { encodeAofCommand, formatAofManifest, formatG17, parseAofCommand, parseAofManifest, snapshotToAof } = PersistenceService;

describe('AOF helpers', () => {
  it('manifest parse / format round trip, quoted names', () => {
    const text = 'file "my file.aof" seq 1 type b\nfile appendonly.aof.1.incr.aof seq 1 type i\nfile appendonly.aof.2.incr.aof seq 2 type i\n';
    const m = parseAofManifest(text);
    expect(m.base?.name).toBe('my file.aof');
    expect(m.incr.map((i) => i.seq)).toEqual([1, 2]);
    expect(formatAofManifest(m)).toBe(text);
    expect(() => parseAofManifest('file x seq 1\n')).toThrow('Invalid AOF manifest file format');
  });

  it('RESP records and %.17g scores', () => {
    const rec = encodeAofCommand(['SET', 'k', 'a\r\nb']);
    expect(rec).toBe('*3\r\n$3\r\nSET\r\n$1\r\nk\r\n$4\r\na\r\nb\r\n');
    expect(parseAofCommand(rec, 0)).toEqual({ argv: ['SET', 'k', 'a\r\nb'], next: rec.length });
    expect(parseAofCommand(rec.slice(0, -3), 0)).toEqual({ incomplete: true });
    expect(formatG17(1.5)).toBe('1.5');
    expect(formatG17(0.1)).toBe('0.10000000000000001');
    expect(formatG17(1e21)).toBe('1e+21');
    expect(formatG17(123)).toBe('123');
    expect(formatG17(-Infinity)).toBe('-inf');
    expect(formatG17(1e-5)).toBe('1.0000000000000001e-05');
    expect(snapshotToAof({ dbs: [], functions: [] })).toBe('');
  });
});
