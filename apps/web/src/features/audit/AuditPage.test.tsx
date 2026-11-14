import { API_ROUTES, CSRF_HEADER_NAME, type AuditLogListResponse } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import {
  apiError,
  defaultBranding,
  fakeAuditEntry,
  fakeSession,
  fakeTeamUser,
  json,
  type FakeHandler,
} from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { auditFileName, fileSlug } from './audit-export';
import { metadataLabel, metadataValue } from './audit-metadata';
import { activeFilterCount, auditFilter, parseAuditSearch, rangeInvalid } from './audit-search';

const copy = t.audit;
const USER_ID = '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b01';

describe('saringan di URL', () => {
  it('nilai tak dikenal dibuang; tanggal mustahil ditolak', () => {
    expect(
      parseAuditSearch({
        action: 'user.role_changed',
        targetType: 'bukan-target',
        userId: 'bukan-uuid',
        from: '2026-02-31',
        to: '2026-11-14',
        targetId: 'team.manage.role',
      }),
    ).toEqual({
      actorUserId: undefined,
      userId: undefined,
      action: 'user.role_changed',
      targetType: undefined,
      targetId: 'team.manage.role',
      from: undefined,
      to: '2026-11-14',
    });
  });

  it('"sampai tanggal" inklusif → dikirim sebagai awal hari berikutnya; rentang terbalik tidak dikirim', () => {
    const filter = auditFilter({ from: '2026-11-07', to: '2026-11-14', userId: USER_ID });
    expect(filter.userId).toBe(USER_ID);
    expect(new Date(filter.from!).getDate()).toBe(7);
    expect(new Date(filter.to!).getDate()).toBe(15);
    expect(rangeInvalid({ from: '2026-11-14', to: '2026-11-07' })).toBe(true);
    expect(auditFilter({ from: '2026-11-14', to: '2026-11-07' })).toEqual({});
    expect(activeFilterCount({ action: 'auth.logout', from: '2026-11-01' })).toBe(2);
  });

  it('rincian: label bahasa Indonesia untuk kunci dikenal, nilai apa adanya sebagai teks', () => {
    expect(metadataLabel('previousHost')).toBe('Server sebelumnya');
    expect(metadataLabel('kunciBaru')).toBe('kunciBaru');
    expect(metadataValue(true)).toBe(copy.yes);
    expect(metadataValue(null)).toBe(copy.emptyValue);
    expect(metadataValue('<b>x</b>')).toBe('<b>x</b>');
  });

  it('nama berkas ekspor memakai nama produk (white-label), aman untuk sistem berkas', () => {
    expect(fileSlug('Balesin Maju Jaya')).toBe('balesin-maju-jaya');
    expect(fileSlug('  Café / CS!  ')).toBe('cafe-cs');
    expect(fileSlug('***')).toBe('aplikasi');
    expect(auditFileName('Balesin', new Date(2026, 10, 14))).toBe('audit-log-balesin-20261114.csv');
  });
});

async function openAudit(path = '/pengaturan/audit', routes: Record<string, FakeHandler> = {}) {
  const view = await renderApp(path, {
    session: fakeSession('owner'),
    teamUsers: {
      users: [
        fakeTeamUser(),
        fakeTeamUser({
          id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001',
          name: 'Rina Kartika',
          isSelf: true,
        }),
      ],
      manageableRoles: ['owner', 'admin', 'supervisor', 'cs', 'teknisi'],
    },
    routes,
  });
  await screen.findByRole('heading', { level: 1, name: copy.title });
  return view;
}

const auditRequests = (view: Awaited<ReturnType<typeof openAudit>>) =>
  view.api.requests.filter((request) => request.path === API_ROUTES.audit.list);

describe('Pengaturan → Audit log', () => {
  it('daftar terbaca pembaca layar: label kolom per entri, aksi berlabel, rincian dari server', async () => {
    await openAudit('/pengaturan/audit', {
      [`GET ${API_ROUTES.audit.list}`]: () =>
        json({
          entries: [
            fakeAuditEntry(),
            fakeAuditEntry({
              id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c02',
              action: 'aksi.masa.depan',
              actor: null,
              target: null,
              metadata: {},
              ipAddress: null,
              device: null,
            }),
          ],
          nextCursor: null,
        } satisfies AuditLogListResponse),
    });
    const list = await screen.findByRole('list', { name: copy.listLabel });
    const [first, second] = within(list).getAllByRole('listitem');
    expect(first).toHaveTextContent('Peran pengguna diubah');
    expect(first).toHaveTextContent(`${copy.columns.actor}: Rina Kartika`);
    expect(within(first!).getByText(copy.details)).toBeVisible();
    expect(first).toHaveTextContent('Dari');
    // Aksi yang belum dikenal web: kodenya tampil apa adanya; pelaku kosong = sistem.
    expect(second).toHaveTextContent('aksi.masa.depan');
    expect(second).toHaveTextContent(copy.system);
    expect(screen.getByText(copy.end)).toBeVisible();
  });

  it('saringan dari URL dikirim ke server; "Muat lagi" memakai kursor; mengubah saringan memuat ulang', async () => {
    const view = await openAudit(`/pengaturan/audit?userId=${USER_ID}&from=2026-11-07`, {
      [`GET ${API_ROUTES.audit.list}`]: (request) =>
        request.query.get('cursor')
          ? json({
              entries: [fakeAuditEntry({ id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c03' })],
              nextCursor: null,
            })
          : json({ entries: [fakeAuditEntry()], nextCursor: 'kursor-2' }),
    });
    await screen.findByRole('list', { name: copy.listLabel });
    const first = auditRequests(view)[0]!;
    expect(first.query.get('userId')).toBe(USER_ID);
    expect(first.query.get('from')).toMatch(/^2026-11-0[67]T/);
    expect(first.query.get('limit')).toBe('50');
    expect(screen.getByText(copy.filters.chipUser('Citra Maharani'))).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: copy.loadMore }));
    await waitFor(() => expect(screen.getAllByRole('listitem').length).toBeGreaterThanOrEqual(2));
    expect(auditRequests(view).at(-1)?.query.get('cursor')).toBe('kursor-2');

    fireEvent.change(screen.getByLabelText(copy.filters.action), {
      target: { value: 'user.disabled' },
    });
    await waitFor(() =>
      expect(auditRequests(view).at(-1)?.query.get('action')).toBe('user.disabled'),
    );
    expect(view.router.state.location.search).toMatchObject({ action: 'user.disabled' });
  });

  it('"Muat lagi" halaman terakhir: tombolnya hilang, fokus ke entri pertama yang baru', async () => {
    await openAudit('/pengaturan/audit', {
      [`GET ${API_ROUTES.audit.list}`]: (request) =>
        request.query.get('cursor')
          ? json({
              entries: [fakeAuditEntry({ id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c03' })],
              nextCursor: null,
            })
          : json({ entries: [fakeAuditEntry()], nextCursor: 'kursor-2' }),
    });
    const list = await screen.findByRole('list', { name: copy.listLabel });
    const more = screen.getByRole('button', { name: copy.loadMore });
    more.focus();
    fireEvent.click(more);
    await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(2));
    expect(screen.queryByRole('button', { name: copy.loadMore })).toBeNull();
    await waitFor(() => expect(within(list).getAllByRole('listitem')[1]).toHaveFocus());
  });

  it('kosong tanpa saringan vs tidak ada yang cocok (dengan tombol hapus saringan)', async () => {
    const view = await openAudit('/pengaturan/audit?action=auth.logout');
    expect(await screen.findByRole('heading', { name: copy.noMatchTitle })).toBeVisible();
    fireEvent.click(screen.getAllByRole('button', { name: copy.filters.clear }).at(-1)!);
    expect(await screen.findByRole('heading', { name: copy.emptyTitle })).toBeVisible();
    expect(view.router.state.location.search).toEqual({});
  });

  it('rentang tanggal terbalik: pesan di isian "Sampai tanggal", tidak dikirim ke server', async () => {
    const view = await openAudit('/pengaturan/audit?from=2026-11-14&to=2026-11-07');
    await screen.findByRole('heading', { name: copy.noMatchTitle });
    expect(screen.getByText(copy.filters.rangeError)).toBeVisible();
    expect(screen.getByLabelText(copy.filters.to)).toHaveAttribute('aria-invalid', 'true');
    expect(auditRequests(view)[0]?.query.get('from')).toBeNull();
    // Di luar panel saringan (yang di HP bisa tertutup) + ekspor ditahan.
    expect(screen.getByRole('alert')).toHaveTextContent(copy.filters.rangeSummary);
    expect(screen.getByRole('button', { name: copy.export })).toBeDisabled();
  });

  it('gagal memuat (429): pesan server dengan tombol coba lagi', async () => {
    await openAudit('/pengaturan/audit', {
      [`GET ${API_ROUTES.audit.list}`]: () =>
        apiError(429, 'RATE_LIMITED', 'Terlalu sering memuat. Coba lagi sebentar lagi.', {
          retryAfter: 30,
        }),
    });
    expect(await screen.findByRole('heading', { name: copy.lockedTitle })).toBeVisible();
    expect(screen.getByText('Terlalu sering memuat. Coba lagi sebentar lagi.')).toBeVisible();
    expect(screen.getByRole('button', { name: t.common.retry })).toBeVisible();
  });

  it('CS tidak melihat menu Audit log dan dialihkan bila membuka alamatnya', async () => {
    const view = await renderApp('/pengaturan/audit', { session: fakeSession('cs') });
    await screen.findByRole('heading', { level: 1, name: t.nav.settings });
    expect(view.router.state.location.pathname).toBe('/pengaturan');
    expect(screen.queryByRole('link', { name: new RegExp(copy.title) })).toBeNull();
  });
});

describe('ekspor CSV', () => {
  const createObjectURL = vi.fn(() => 'blob:tes-audit');
  const revokeObjectURL = vi.fn();
  let clicked: HTMLAnchorElement[] = [];

  beforeEach(() => {
    clicked = [];
    createObjectURL.mockClear();
    Object.assign(URL, { createObjectURL, revokeObjectURL });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (
      this: HTMLAnchorElement,
    ) {
      clicked.push(this);
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  const csv = (headers: Record<string, string> = {}) =>
    new Response('﻿"Waktu (UTC)","Aksi"\r\n', {
      status: 200,
      headers: { 'content-type': 'text/csv; charset=utf-8', 'x-export-rows': '1', ...headers },
    });

  it('fetch → Blob → tautan unduhan bernama produk; saringan ikut; hasil diumumkan', async () => {
    const view = await openAudit('/pengaturan/audit?action=user.disabled', {
      [`GET ${API_ROUTES.audit.export}`]: () => csv(),
    });
    await screen.findByRole('heading', { name: copy.noMatchTitle });
    fireEvent.click(screen.getByRole('button', { name: copy.export }));
    expect(await screen.findByText(copy.exported(1))).toBeVisible();
    const request = view.api.requests.find((item) => item.path === API_ROUTES.audit.export);
    expect(request?.query.get('action')).toBe('user.disabled');
    // GET ber-efek-samping: wajib membawa token CSRF (review butir 6 R3).
    expect(request?.headers[CSRF_HEADER_NAME.toLowerCase()]).toBe('csrf-tes-1');
    expect(request?.query.get('cursor')).toBeNull();
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clicked).toHaveLength(1);
    expect(clicked[0]!.download).toMatch(
      new RegExp(`^audit-log-${fileSlug(defaultBranding.productName)}-\\d{8}\\.csv$`),
    );
    expect(clicked[0]!.href).toBe('blob:tes-audit');
    // Tanpa token di URL; tautannya sudah dilepas dari dokumen.
    expect(document.querySelector('a[download]')).toBeNull();
  });

  it('lebih dari 10.000 baris: peringatan untuk mempersempit rentang', async () => {
    await openAudit('/pengaturan/audit', {
      [`GET ${API_ROUTES.audit.export}`]: () =>
        csv({ 'x-export-rows': '10000', 'x-export-truncated': '1' }),
    });
    await screen.findByRole('heading', { name: copy.emptyTitle });
    fireEvent.click(screen.getByRole('button', { name: copy.export }));
    expect(await screen.findByText(copy.exportTruncated(10_000))).toBeVisible();
  });

  it('429: tombol terkunci dengan hitung mundur dan pesan server', async () => {
    await openAudit('/pengaturan/audit', {
      [`GET ${API_ROUTES.audit.export}`]: () =>
        apiError(429, 'RATE_LIMITED', 'Batas ekspor tercapai. Coba lagi dalam 1 jam.', {
          retryAfter: 3600,
        }),
    });
    await screen.findByRole('heading', { name: copy.emptyTitle });
    fireEvent.click(screen.getByRole('button', { name: copy.export }));
    expect(await screen.findByText(copy.exportLockedTitle)).toBeVisible();
    expect(screen.getByText('Batas ekspor tercapai. Coba lagi dalam 1 jam.')).toBeVisible();
    expect(screen.getByRole('button', { name: /Coba lagi dalam 60:00/ })).toBeDisabled();
    expect(createObjectURL).not.toHaveBeenCalled();
  });
});
