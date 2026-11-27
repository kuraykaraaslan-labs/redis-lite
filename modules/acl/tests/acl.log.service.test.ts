import { describe, expect, it } from 'vitest';

import { makeAcl } from './acl.fixtures';

/** ACL LOG grouping, trimming and replies. */

describe('ACL LOG', () => {
  it('groups same reason/context/object/username within 60s', () => {
    let t = 1_000_000;
    const acl = makeAcl({ now: () => t });
    const base = { reason: 'command', context: 'toplevel', object: 'get', username: 'u' } as const;
    acl.log({ ...base, clientInfo: 'c1' });
    t += 1000;
    acl.log({ ...base, clientInfo: 'c2' });
    let entries = acl.logEntries();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      count: 2,
      clientInfo: 'c2',
      ageSeconds: 0,
    });
    acl.log({ ...base, object: 'set', clientInfo: 'c3' });
    t += 61_000;
    acl.log({ ...base, clientInfo: 'c4' });
    entries = acl.logEntries();
    expect(entries.map((e) => [e.object, e.count, e.clientInfo])).toEqual([
      ['get', 1, 'c4'],
      ['set', 1, 'c3'],
      ['get', 2, 'c2'],
    ]);
    expect(entries[1].ageSeconds).toBe(61);
    expect(acl.logEntries(1)).toHaveLength(1);
    acl.logDenial({ reason: 'key', object: 'k' }, 'u', 'multi', 'c5');
    expect(acl.logEntries(1)[0]).toMatchObject({ reason: 'key', context: 'multi', object: 'k' });
    acl.resetLog();
    expect(acl.logEntries()).toEqual([]);
  });

  it('is bounded by acllog-max-len', () => {
    const acl = makeAcl({ logMaxLen: 3 });
    for (let i = 0; i < 5; i++) acl.log({ reason: 'auth', context: 'toplevel', object: 'AUTH', username: `u${i}`, clientInfo: '' });
    expect(acl.logEntries(10).map((e) => e.username)).toEqual(['u4', 'u3', 'u2']);
  });
});
