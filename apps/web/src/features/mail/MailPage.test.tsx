import { API_ROUTES } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { fakeSession, json } from '../../test/fake-api';
import { MAIL_IDS, fakeMailAccount, fakeSidebar } from '../../test/fake-mail';
import { FakeSocket } from '../../test/fake-socket';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const m = t.mail;

const cs = fakeMailAccount();
const billing = fakeMailAccount({
  id: MAIL_IDS.billing,
  displayName: 'Billing',
  emailAddress: 'billing@majujaya.co.id',
  color: 'tagTeal',
  sync: { ...cs.sync, state: 'auth_failed', lastErrorCode: 'imap_auth_failed' },
});
const personal = fakeMailAccount({
  id: MAIL_IDS.personal,
  kind: 'personal',
  displayName: 'Pribadi Rina',
  emailAddress: 'rina@surel.id',
  color: 'tagPurple',
  owner: { id: fakeSession().user.id, name: 'Rina Kartika', active: true },
});

function withAccounts(accounts = [cs, billing, personal]) {
  return {
    routes: {
      [`GET ${API_ROUTES.mail.accounts}`]: () =>
        json({ accounts, canConnectPersonal: true, canManageShared: true }),
      [`GET ${API_ROUTES.mail.sidebar}`]: () => json(fakeSidebar(accounts)),
    },
  };
}

function folders() {
  return within(screen.getByRole('complementary', { name: m.foldersLabel }));
}

describe('menu Email', () => {
  it('tampil di rail untuk Owner dan membuka keadaan kosong "Hubungkan akun email pertamamu"', async () => {
    const { router } = await renderApp('/inbox');
    const nav = within(screen.getByRole('navigation', { name: t.nav.label }));
    fireEvent.click(nav.getByRole('link', { name: t.nav.mail }));

    expect(await screen.findByRole('heading', { level: 1, name: m.empty.title })).toBeVisible();
    expect(router.state.location.pathname).toBe('/email');
    expect(nav.getByRole('link', { name: t.nav.mail })).toHaveAttribute('aria-current', 'page');
    // Ajakan utama membuka wizard di Pengaturan → Akun email.
    expect(screen.getByRole('link', { name: m.empty.action })).toHaveAttribute(
      'href',
      '/pengaturan/akun-email?tambah=baru',
    );
    // Kartu penyedia: cPanel bisa dipilih; Microsoft 365 "Segera hadir" (bukan tautan).
    const providers = within(screen.getByRole('list', { name: m.empty.providersLabel }));
    expect(providers.getByRole('link', { name: /cPanel/ })).toHaveAttribute(
      'href',
      '/pengaturan/akun-email?tambah=cpanel',
    );
    expect(providers.queryByRole('link', { name: /Microsoft 365/ })).toBeNull();
    expect(providers.getAllByText(m.wizard.soon)).toHaveLength(3);
    expect(screen.getByText(m.empty.noteManager)).toBeVisible();
    expect(document.title).toContain(m.title);
  });

  it('CS: catatan bahwa akun bersama dihubungkan Owner/Admin', async () => {
    await renderApp('/email', { session: fakeSession('cs') });
    expect(await screen.findByText(m.empty.notePersonalOnly)).toBeVisible();
  });

  it('Teknisi tanpa akun (navigation.mail = false): menu tidak tampil, alamat dialihkan ke Inbox', async () => {
    const { router } = await renderApp('/email', { session: fakeSession('teknisi') });
    await waitFor(() => expect(router.state.location.pathname).toBe('/inbox'));
    const nav = within(screen.getByRole('navigation', { name: t.nav.label }));
    expect(nav.queryByRole('link', { name: t.nav.mail })).toBeNull();
  });

  it('kolom folder: gabungan + per akun (folder, jumlah, akun pribadi, perlu perhatian)', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/email', withAccounts());

    expect(await screen.findByRole('heading', { level: 1, name: m.views.inboxes })).toBeVisible();
    expect(screen.getByText(m.summary(14, 3))).toBeVisible();
    const column = folders();
    expect(column.getByRole('link', { name: new RegExp(m.views.inboxes) })).toHaveAttribute(
      'aria-current',
      'page',
    );
    expect(
      column.getByRole('link', { name: /Semua kotak masuk\s*14\s*belum dibaca/ }),
    ).toBeVisible();
    // Akun bersama CS: folder berperan dengan nama Indonesia + folder sendiri.
    expect(
      column.getByRole('button', { name: m.toggleAccount('CS Maju Jaya', [m.unreadLabel(6)]) }),
    ).toHaveAttribute('aria-expanded', 'true');
    expect(
      column.getByRole('button', {
        name: m.toggleAccount('Pribadi Rina', [m.personalNote, m.unreadLabel(8)]),
      }),
    ).toBeInTheDocument();
    expect(column.getByRole('link', { name: /Kotak masuk/ })).toBeInTheDocument();
    expect(column.getByRole('link', { name: /Vendor/ })).toBeInTheDocument();
    // Password Billing ditolak → penanda perlu perhatian + kaki kolom.
    expect(
      column.getByRole('button', {
        name: m.toggleAccount('Billing', [m.attentionNote, m.unreadLabel(8)]),
      }),
    ).toBeInTheDocument();
    expect(column.getByRole('link', { name: m.footer.attention(1) })).toHaveAttribute(
      'href',
      '/pengaturan/akun-email',
    );
  });

  it('memilih folder: judul daftar & ringkasan ikut folder itu; akun bisa dilipat', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { router } = await renderApp('/email', withAccounts());
    await screen.findByRole('heading', { level: 1, name: m.views.inboxes });
    const column = screen.getByRole('complementary', { name: m.foldersLabel });

    fireEvent.click(within(column).getByRole('link', { name: /Vendor/ }));
    expect(await screen.findByRole('heading', { level: 1, name: 'Vendor' })).toBeVisible();
    expect(router.state.location.search).toEqual({ f: MAIL_IDS.csVendor });
    expect(screen.getByText(`CS Maju Jaya · ${m.folderSummary(2, 1200)}`)).toBeVisible();
    // Hanya satu item aktif (review 9A-baca H1: router membandingkan search secara parsial).
    const current = column.querySelectorAll('[aria-current="page"]');
    expect(current).toHaveLength(1);
    expect(current[0]).toHaveTextContent('Vendor');

    const toggle = within(column).getByRole('button', {
      name: m.toggleAccount('CS Maju Jaya', [m.unreadLabel(6)]),
    });
    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-expanded', 'false');
  });

  it('HP: kolom folder jadi laci (tombol buka, tutup, Escape)', async () => {
    act(() => setMediaQuery(media.hp, true));
    await renderApp('/email', withAccounts());
    const open = await screen.findByRole('button', { name: m.openFolders });
    expect(open).toHaveAttribute('aria-expanded', 'false');

    fireEvent.click(open);
    expect(open).toHaveAttribute('aria-expanded', 'true');
    const close = screen.getAllByRole('button', { name: m.closeFolders })[0];
    if (!close) throw new Error('tombol tutup tidak ada');
    fireEvent.keyDown(window, { key: 'Escape' });
    await waitFor(() => expect(open).toHaveAttribute('aria-expanded', 'false'));
  });

  it('sinkron awal berjalan: progres tampil, lalu event WS memperbarui status', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const syncing = fakeMailAccount({
      sync: { ...cs.sync, state: 'initial_sync', initialProgress: { done: 120, total: 640 } },
    });
    await renderApp('/email', withAccounts([syncing]));
    expect(await screen.findByText(m.list.initialBody(120, 640))).toBeVisible();
    expect(screen.getByText(m.footer.syncing)).toBeVisible();

    act(() =>
      FakeSocket.latest()?.receive({
        type: 'mail.account.status',
        accountId: MAIL_IDS.cs,
        syncState: 'ready',
        lastSyncedAt: new Date().toISOString(),
        errorCode: null,
        initialProgress: null,
      }),
    );
    expect(await screen.findByText(m.footer.synced(m.time.justNow))).toBeVisible();
    expect(await screen.findByText(m.list.empty.inboxes.title)).toBeVisible();
  });

  it('mail.access.changed → sesi dimuat ulang (menu Email bisa berubah)', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const { api } = await renderApp('/email', withAccounts());
    await screen.findByRole('heading', { level: 1, name: m.views.inboxes });
    const before = api.requests.filter((request) => request.path === API_ROUTES.auth.me).length;
    act(() => FakeSocket.latest()?.receive({ type: 'mail.access.changed' }));
    await waitFor(() =>
      expect(
        api.requests.filter((request) => request.path === API_ROUTES.auth.me).length,
      ).toBeGreaterThan(before),
    );
  });
});
