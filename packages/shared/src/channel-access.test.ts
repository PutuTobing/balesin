import { describe, expect, it } from 'vitest';

import {
  CHANNEL_ACCESS_EXEMPT_ROLES,
  channelAccessLoosens,
  inboxAgentListQuerySchema,
  isChannelAccessExempt,
  updateChannelAccessRequestSchema,
} from './channel-access';
import { hasPermission } from './permissions';
import { USER_ROLES } from './roles';

const A = '0190f0a0-0000-7000-8000-000000000001';
const B = '0190f0a0-0000-7000-8000-000000000002';

describe('akses per channel — skema & peran', () => {
  it('hanya Owner/Admin yang kebal, dan merekalah pengelola channel', () => {
    expect(CHANNEL_ACCESS_EXEMPT_ROLES).toEqual(['owner', 'admin']);
    for (const role of USER_ROLES) {
      expect(isChannelAccessExempt(role), role).toBe(role === 'owner' || role === 'admin');
      // Pengelola akses = `channels.manage` = peran yang kebal (tidak bisa mengunci dirinya sendiri).
      expect(hasPermission(role, 'channels.manage'), role).toBe(isChannelAccessExempt(role));
    }
  });

  it('PUT: daftar dibakukan (huruf kecil, unik); bawaan kosong', () => {
    expect(
      updateChannelAccessRequestSchema.parse({
        mode: 'restricted',
        departmentIds: [A, A.toUpperCase()],
        userIds: [B],
      }),
    ).toEqual({ mode: 'restricted', departmentIds: [A], userIds: [B] });
    expect(updateChannelAccessRequestSchema.parse({ mode: 'restricted' })).toEqual({
      mode: 'restricted',
      departmentIds: [],
      userIds: [],
    });
    expect(updateChannelAccessRequestSchema.parse({ mode: 'all' })).toEqual({
      mode: 'all',
      departmentIds: [],
      userIds: [],
    });
  });

  it('PUT: menolak mode tak dikenal, ID rusak, daftar dengan mode "Semua tim", isian asing', () => {
    for (const body of [
      { mode: 'some' },
      { mode: 'restricted', departmentIds: ['bukan-uuid'] },
      { mode: 'restricted', userIds: 'semua' },
      { mode: 'all', userIds: [B] },
      { mode: 'all', departmentIds: [A] },
      { mode: 'restricted', extra: true },
      { mode: 'restricted', userIds: Array.from({ length: 501 }, () => A) },
    ]) {
      expect(updateChannelAccessRequestSchema.safeParse(body).success, JSON.stringify(body)).toBe(
        false,
      );
    }
  });

  it('GET agen: channelId opsional, harus UUID', () => {
    expect(inboxAgentListQuerySchema.parse({})).toEqual({});
    expect(inboxAgentListQuerySchema.parse({ channelId: A })).toEqual({ channelId: A });
    expect(inboxAgentListQuerySchema.safeParse({ channelId: 'x' }).success).toBe(false);
  });

  it('melonggarkan (butuh konfirmasi): restricted → all, atau menambah daftar channel terbatas', () => {
    const restricted = { mode: 'restricted' as const, departmentIds: [A], userIds: [] };
    const all = { mode: 'all' as const, departmentIds: [], userIds: [] };
    expect(channelAccessLoosens(restricted, all)).toBe(true);
    expect(channelAccessLoosens(restricted, { ...restricted, userIds: [B] })).toBe(true);
    expect(channelAccessLoosens(restricted, { ...restricted, departmentIds: [A, B] })).toBe(true);
    // Mempersempit / tetap.
    expect(channelAccessLoosens(all, { ...restricted, userIds: [B] })).toBe(false);
    expect(channelAccessLoosens(restricted, { ...restricted, departmentIds: [] })).toBe(false);
    expect(channelAccessLoosens(restricted, restricted)).toBe(false);
    expect(channelAccessLoosens(all, all)).toBe(false);
    expect(
      updateChannelAccessRequestSchema.safeParse({ mode: 'all', confirmation: { password: 'x' } })
        .success,
    ).toBe(true);
  });
});
