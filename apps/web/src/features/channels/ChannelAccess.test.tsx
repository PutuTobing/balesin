import {
  API_ROUTES,
  apiPath,
  channelAccessLoosens,
  channelTypeInfos,
  type ChannelAccess,
  type EmailChannel,
} from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, fakeTeamUser, json, type FakeHandler } from '../../test/fake-api';
import { confirmIdentity, TEST_CODE, TEST_PASSWORD } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import {
  accessBody,
  accessSummary,
  initialDraft,
  sameDraft,
  selectableUsers,
  toggleId,
} from './channel-access-form';

/** Tahap 9.0 — Pengaturan → Channel → [channel] → Akses tim. */

const a = t.channels.teamAccess;
const NOW = '2026-11-22T03:00:00.000Z';
const CHANNEL_ID = '6f1c2a90-3333-4c4c-9a9a-000000000002';
const BILLING = { id: '6f1c2a90-3333-4c4c-9a9a-0000000000d1', name: 'Tagihan', memberCount: 3 };
const SUPPORT = { id: '6f1c2a90-3333-4c4c-9a9a-0000000000d2', name: 'Teknis', memberCount: 4 };
const SINTA = fakeTeamUser({
  id: '6f1c2a90-3333-4c4c-9a9a-0000000000e1',
  name: 'Sinta',
  role: 'cs',
});
const MADE = fakeTeamUser({
  id: '6f1c2a90-3333-4c4c-9a9a-0000000000e2',
  name: 'Made',
  role: 'teknisi',
});
const ADMIN = fakeTeamUser({
  id: '6f1c2a90-3333-4c4c-9a9a-0000000000e3',
  name: 'Ayu Admin',
  role: 'admin',
});
const GONE = fakeTeamUser({
  id: '6f1c2a90-3333-4c4c-9a9a-0000000000e4',
  name: 'Lama',
  role: 'cs',
  status: 'disabled',
});

const EMAIL: EmailChannel = {
  enabled: true,
  disabledAt: null,
  status: 'connected',
  lastTest: null,
  credentialsUpdatedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  id: CHANNEL_ID,
  type: 'email',
  name: 'Email Tagihan',
  emailAddress: 'tagihan@majujaya.co.id',
  aliases: [],
  fromName: 'Tagihan Maju Jaya',
  imap: {
    host: 'mail.majujaya.co.id',
    port: 993,
    security: 'ssl',
    username: 'tagihan@majujaya.co.id',
    passwordHint: '••••',
    folder: 'INBOX',
  },
  pollIntervalMinutes: 2,
  markAsRead: true,
  senderVerification: { trustedAuthServIds: ['mail.majujaya.co.id'], isDefault: true },
  smtp: { mode: 'system' },
  mailbox: {
    lastPolledAt: NOW,
    lastPollOk: true,
    lastPollCode: null,
    lastPollMessage: null,
    skippedMessages: 0,
  },
};

const ALL: ChannelAccess = {
  channelId: CHANNEL_ID,
  mode: 'all',
  departments: [],
  users: [],
  exemptRoles: ['owner', 'admin'],
};

function setup(access: ChannelAccess, extra: Record<string, FakeHandler> = {}) {
  const R = API_ROUTES.channelConnections;
  return {
    teamUsers: { users: [SINTA, MADE, ADMIN, GONE], manageableRoles: [] },
    routes: {
      [`GET ${R.list}`]: () =>
        json({
          channels: [EMAIL],
          types: channelTypeInfos(),
          canStoreSecrets: true,
          maxChannels: 20,
        }),
      [`GET ${apiPath(R.channel, { channelId: CHANNEL_ID })}`]: () => json({ channel: EMAIL }),
      [`GET ${apiPath(API_ROUTES.channels.access, { channelId: CHANNEL_ID })}`]: () =>
        json({ access }),
      [`GET ${API_ROUTES.departments.list}`]: () =>
        json({
          departments: [
            { ...BILLING, description: null },
            { ...SUPPORT, description: null },
          ],
        }),
      ...extra,
    },
  };
}

async function card() {
  const heading = await screen.findByRole('heading', { name: a.title });
  return within(heading.closest('section')!);
}

describe('akses tim (logika)', () => {
  it('awal dari server: pengguna nonaktif dilepas; mode all → isi PUT tanpa daftar', () => {
    const { draft, droppedInactive } = initialDraft({
      ...ALL,
      mode: 'restricted',
      departments: [{ ...BILLING }],
      users: [
        { id: SINTA.id, name: 'Sinta', role: 'cs', active: true },
        { id: GONE.id, name: 'Lama', role: 'cs', active: false },
      ],
    });
    expect(draft).toEqual({ mode: 'restricted', departmentIds: [BILLING.id], userIds: [SINTA.id] });
    expect(droppedInactive).toBe(1);
    expect(accessBody({ ...draft, mode: 'all' })).toEqual({ mode: 'all' });
    expect(accessBody(draft)).toEqual({
      mode: 'restricted',
      departmentIds: [BILLING.id],
      userIds: [SINTA.id],
    });
  });

  it('perbandingan, ringkasan, pilihan pengguna tanpa Owner/Admin & nonaktif', () => {
    const base = { mode: 'restricted' as const, departmentIds: ['a', 'b'], userIds: [] };
    expect(sameDraft(base, { ...base, departmentIds: ['b', 'a'] })).toBe(true);
    expect(
      sameDraft({ ...base, mode: 'all' }, { mode: 'all', departmentIds: [], userIds: ['x'] }),
    ).toBe(true);
    expect(toggleId(['a'], 'b', true)).toEqual(['a', 'b']);
    expect(toggleId(['a', 'b'], 'a', false)).toEqual(['b']);
    expect(
      accessSummary({ ...base, departmentIds: [BILLING.id, SUPPORT.id] }, [BILLING, SUPPORT]),
    ).toEqual({ ownersOnly: false, departments: 2, members: 7, users: 0 });
    expect(accessSummary({ ...base, departmentIds: [] }, []).ownersOnly).toBe(true);
    expect(selectableUsers([SINTA, MADE, ADMIN, GONE]).map((user) => user.name)).toEqual([
      'Made',
      'Sinta',
    ]);
  });
});

describe('akses tim: kapan butuh konfirmasi', () => {
  it('melonggarkan = terbatas → semua tim, atau menambah departemen/pengguna', () => {
    const restricted = { mode: 'restricted' as const, departmentIds: ['a'], userIds: ['u'] };
    expect(channelAccessLoosens(restricted, { ...restricted, mode: 'all' })).toBe(true);
    expect(channelAccessLoosens(restricted, { ...restricted, userIds: ['u', 'v'] })).toBe(true);
    expect(channelAccessLoosens(restricted, { ...restricted, departmentIds: [] })).toBe(false);
    expect(channelAccessLoosens({ mode: 'all', departmentIds: [], userIds: [] }, restricted)).toBe(
      false,
    );
  });
});

describe('Pengaturan → Channel → Akses tim', () => {
  it('bawaan "Semua tim"; pilih departemen & pengguna → PUT restricted', async () => {
    let body: unknown = null;
    await renderApp(
      `/pengaturan/channel/lain/${CHANNEL_ID}`,
      setup(ALL, {
        [`PUT ${apiPath(API_ROUTES.channels.access, { channelId: CHANNEL_ID })}`]: (request) => {
          body = request.body;
          return json({
            access: {
              ...ALL,
              mode: 'restricted',
              departments: [BILLING],
              users: [{ id: SINTA.id, name: 'Sinta', role: 'cs', active: true }],
            },
            releasedConversations: 2,
          });
        },
      }),
    );
    const view = await card();
    expect(await view.findByRole('radio', { name: new RegExp(a.modeAll) })).toBeChecked();
    expect(view.getByText(a.summaryAll)).toBeVisible();
    expect(view.getByText(a.exempt)).toBeVisible();
    expect(view.getByRole('button', { name: a.save })).toBeDisabled();

    fireEvent.click(view.getByRole('radio', { name: new RegExp(a.modeRestricted) }));
    // Kedua daftar kosong: hanya Owner/Admin — diperingatkan.
    expect(await view.findByText(a.onlyOwnersHint)).toBeVisible();
    fireEvent.click(await view.findByRole('checkbox', { name: /Tagihan/ }));
    const users = within(view.getByRole('group', { name: new RegExp(a.users) }));
    // Owner/Admin & pengguna nonaktif tidak ditawarkan.
    expect(users.queryByRole('checkbox', { name: /Ayu Admin/ })).toBeNull();
    expect(users.queryByRole('checkbox', { name: /Lama/ })).toBeNull();
    fireEvent.click(users.getByRole('checkbox', { name: /Sinta/ }));
    expect(view.getByText(a.summaryTitle).nextElementSibling).toHaveTextContent(
      `${a.summaryOwners} · ${a.summaryDepartments(1, 3)} · ${a.summaryUsers(1)}`,
    );
    expect(view.queryByText(a.onlyOwnersHint)).toBeNull();

    fireEvent.click(view.getByRole('button', { name: a.save }));
    // Mempersempit (semua tim → terbatas): tanpa konfirmasi identitas.
    await waitFor(() =>
      expect(body).toEqual({
        mode: 'restricted',
        departmentIds: [BILLING.id],
        userIds: [SINTA.id],
      }),
    );
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(await view.findByText(a.savedTitle)).toBeVisible();
    // Teks dinormalkan (NBSP → spasi) oleh pencocok.
    expect(view.getByText(`${a.saved} ${a.released(2)}`.replace(/\u00a0/g, ' '))).toBeVisible();
    expect(a.released(2)).toContain('2\u00a0percakapan');
    expect(view.getByRole('button', { name: a.save })).toBeDisabled();
  });

  it('kembali ke "Semua tim" (melonggarkan): konfirmasi identitas; galat server tampil apa adanya', async () => {
    const bodies: unknown[] = [];
    await renderApp(
      `/pengaturan/channel/lain/${CHANNEL_ID}`,
      setup(
        {
          ...ALL,
          mode: 'restricted',
          departments: [BILLING],
          users: [],
        },
        {
          [`PUT ${apiPath(API_ROUTES.channels.access, { channelId: CHANNEL_ID })}`]: (request) => {
            bodies.push(request.body);
            return apiError(400, 'VALIDATION_ERROR', 'Departemen tidak ditemukan.');
          },
        },
      ),
    );
    const view = await card();
    expect(await view.findByRole('checkbox', { name: /Tagihan/ })).toBeChecked();
    fireEvent.click(view.getByRole('radio', { name: new RegExp(a.modeAll) }));
    expect(view.getByText(a.unsaved)).toBeVisible();
    fireEvent.click(view.getByRole('button', { name: a.save }));
    await confirmIdentity(a.confirmTitle, a.save);
    expect(await view.findByText('Departemen tidak ditemukan.')).toBeVisible();
    expect(bodies).toEqual([
      { mode: 'all', confirmation: { password: TEST_PASSWORD, code: TEST_CODE } },
    ]);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    fireEvent.click(view.getByRole('button', { name: a.reset }));
    expect(view.getByRole('radio', { name: new RegExp(a.modeRestricted) })).toBeChecked();
  });

  it('pengguna tersimpan yang kini nonaktif dilepas dengan penjelasan', async () => {
    await renderApp(
      `/pengaturan/channel/lain/${CHANNEL_ID}`,
      setup({
        ...ALL,
        mode: 'restricted',
        departments: [],
        users: [{ id: GONE.id, name: 'Lama', role: 'cs', active: false }],
      }),
    );
    const view = await card();
    expect(await view.findByText(a.droppedInactive(1))).toBeVisible();
    expect(view.getByRole('button', { name: a.save })).toBeEnabled();
    const lama = await view.findByRole('checkbox', { name: /Lama/ });
    expect(lama).not.toBeChecked();
    expect(lama).toBeDisabled();
  });

  it('halaman nomor WhatsApp juga punya Akses tim (navigasi bagian)', async () => {
    const R = API_ROUTES.channels;
    const whatsapp = (await import('../../test/fake-api')).fakeChannel({ id: CHANNEL_ID });
    await renderApp(`/pengaturan/channel/${CHANNEL_ID}`, {
      session: fakeSession('admin'),
      routes: {
        [`GET ${apiPath(R.channel, { channelId: CHANNEL_ID })}`]: () => json({ channel: whatsapp }),
        [`GET ${apiPath(R.access, { channelId: CHANNEL_ID })}`]: () => json({ access: ALL }),
      },
    });
    expect(await screen.findByRole('heading', { name: a.title })).toBeVisible();
    const nav = await screen.findByRole('navigation', { name: t.channels.sections.label });
    expect(within(nav).getByRole('link', { name: t.channels.sections.teamAccess })).toHaveAttribute(
      'href',
      '#akses-tim',
    );
  });
});
