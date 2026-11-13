import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { defaultBrand } from '../../brand/brand';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { navActiveState, navItems } from './nav-items';

const product = defaultBrand.productName;

function mainNav() {
  return within(screen.getByRole('navigation', { name: t.nav.label }));
}

function navLink(name: string) {
  return mainNav().getByRole('link', { name });
}

describe('navigasi kerangka aplikasi', () => {
  it('membuka Inbox sebagai halaman awal', async () => {
    const { router } = await renderApp('/');

    expect(await screen.findByRole('heading', { level: 1, name: t.inbox.title })).toBeVisible();
    expect(router.state.location.pathname).toBe('/inbox');
    expect(navLink(t.nav.inbox)).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe(`${t.inbox.title} · ${product}`);
  });

  it('menampilkan semua menu utama dengan label yang terbaca', async () => {
    await renderApp('/inbox');

    for (const item of navItems) {
      expect(navLink(item.label)).toHaveAttribute('href', item.to);
    }
    // Tombol ikon tanpa teks tetap punya nama aksesibel.
    expect(mainNav().getByRole('button', { name: t.theme.change })).toBeInTheDocument();
    expect(mainNav().getByRole('link', { name: t.nav.home(product) })).toHaveAttribute(
      'href',
      '/inbox',
    );
  });

  it.each([
    { label: t.nav.contacts, path: '/kontak', emptyTitle: t.contacts.emptyTitle },
    { label: t.nav.broadcast, path: '/broadcast', emptyTitle: t.broadcast.emptyTitle },
    { label: t.nav.tickets, path: '/tiket', emptyTitle: t.tickets.emptyTitle },
    { label: t.nav.reports, path: '/laporan', emptyTitle: t.reports.emptyTitle },
  ])('pindah ke $label dan menandainya aktif', async ({ label, path, emptyTitle }) => {
    const { router } = await renderApp('/inbox');

    fireEvent.click(navLink(label));

    expect(await screen.findByRole('heading', { level: 1, name: label })).toBeVisible();
    expect(screen.getByRole('heading', { level: 2, name: emptyTitle })).toBeVisible();
    expect(router.state.location.pathname).toBe(path);
    expect(navLink(label)).toHaveAttribute('aria-current', 'page');
    expect(navLink(t.nav.inbox)).not.toHaveAttribute('aria-current');
    expect(document.title).toBe(`${label} · ${product}`);
  });

  it('memindahkan fokus ke konten setelah pindah halaman', async () => {
    await renderApp('/inbox');

    fireEvent.click(navLink(t.nav.contacts));
    await screen.findByRole('heading', { level: 1, name: t.nav.contacts });

    await waitFor(() => expect(screen.getByRole('main')).toHaveFocus());
  });

  it('tautan "Lewati ke konten" memfokuskan konten', async () => {
    await renderApp('/inbox');

    fireEvent.click(screen.getByRole('link', { name: t.common.skipToContent }));

    expect(screen.getByRole('main')).toHaveFocus();
  });

  it('di HP, "Lainnya" ditandai saat membuka menu di bawahnya', async () => {
    await renderApp('/tiket');
    await screen.findByRole('heading', { level: 1, name: t.nav.tickets });

    expect(navLink(t.nav.tickets)).toHaveAttribute('aria-current', 'page');
    // Bukan halaman yang sedang dibuka, tetapi induknya.
    expect(navLink(t.nav.more)).toHaveAttribute('aria-current', 'true');
    expect(navLink(t.nav.inbox)).not.toHaveAttribute('aria-current');
  });

  it.each([
    { path: '/tiket', title: t.nav.tickets },
    { path: '/laporan', title: t.nav.reports },
    { path: '/pengaturan', title: t.nav.settings },
  ])('di HP, $title punya tombol kembali ke Lainnya', async ({ path, title }) => {
    act(() => setMediaQuery(media.hp, true));
    await renderApp(path);
    await screen.findByRole('heading', { level: 1, name: title });

    const back = within(screen.getByRole('main')).getByRole('link', {
      name: t.common.backTo(t.nav.more),
    });
    expect(back).toHaveAttribute('href', '/lainnya');

    fireEvent.click(back);
    expect(await screen.findByRole('heading', { level: 1, name: t.nav.more })).toBeVisible();
  });

  it('di HP, layar Lainnya menautkan ke Tiket, Laporan, dan Pengaturan', async () => {
    act(() => setMediaQuery(media.hp, true));
    await renderApp('/lainnya');

    const menu = within(await screen.findByRole('navigation', { name: t.more.menuLabel }));
    expect(menu.getByRole('link', { name: t.nav.tickets })).toHaveAttribute('href', '/tiket');
    expect(menu.getByRole('link', { name: t.nav.reports })).toHaveAttribute('href', '/laporan');
    expect(menu.getByRole('link', { name: t.nav.settings })).toHaveAttribute('href', '/pengaturan');
    expect(navLink(t.nav.more)).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText(t.common.version(product, __APP_VERSION__))).toBeVisible();
  });

  it('di layar lebar, /lainnya dialihkan ke Pengaturan (menunya sudah ada di rail)', async () => {
    const { router } = await renderApp('/lainnya');

    expect(await screen.findByRole('heading', { level: 1, name: t.nav.settings })).toBeVisible();
    expect(router.state.location.pathname).toBe('/pengaturan');
    expect(screen.queryByRole('navigation', { name: t.more.menuLabel })).toBeNull();
    expect(navLink(t.nav.settings)).toHaveAttribute('aria-current', 'page');
  });

  it('layar Lainnya ikut dialihkan saat jendela dilebarkan', async () => {
    act(() => setMediaQuery(media.hp, true));
    const { router } = await renderApp('/lainnya');
    await screen.findByRole('navigation', { name: t.more.menuLabel });

    act(() => setMediaQuery(media.hp, false));

    expect(await screen.findByRole('heading', { level: 1, name: t.nav.settings })).toBeVisible();
    expect(router.state.location.pathname).toBe('/pengaturan');
  });
});

describe('halaman tidak ditemukan', () => {
  it('menampilkan 404 di dalam kerangka, dengan jalan kembali', async () => {
    await renderApp('/halaman-yang-tidak-ada');

    expect(await screen.findByRole('heading', { name: t.notFound.title })).toBeVisible();
    expect(screen.getByText('/halaman-yang-tidak-ada')).toBeVisible();
    expect(document.title).toBe(`${t.notFound.title} · ${product}`);

    // Navigasi tetap ada, tidak ada menu yang ditandai aktif.
    expect(mainNav().queryByRole('link', { current: 'page' })).toBeNull();

    fireEvent.click(
      within(screen.getByRole('main')).getByRole('link', { name: t.common.backToInbox }),
    );
    expect(await screen.findByRole('heading', { level: 1, name: t.inbox.title })).toBeVisible();
  });
});

describe('layar gagal', () => {
  it('menjelaskan masalah, menawarkan coba lagi, dan navigasi tetap bisa dipakai', async () => {
    // React mencatat galat yang ditangkap batas error; itu memang yang diuji.
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await renderApp('/pratinjau/gagal');

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByRole('heading', { name: t.error.title })).toBeVisible();
    expect(within(alert).getByText(t.error.body)).toBeVisible();
    expect(within(alert).getByRole('button', { name: t.common.retry })).toBeEnabled();
    expect(within(alert).getByText(t.error.details)).toBeInTheDocument();
    // Pesan teknis tampil sebagai teks biasa.
    expect(within(alert).getByText('Failed to fetch')).toBeInTheDocument();

    fireEvent.click(within(alert).getByRole('link', { name: t.common.backToInbox }));
    expect(await screen.findByRole('heading', { level: 1, name: t.inbox.title })).toBeVisible();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('"Coba lagi" merender ulang halaman yang gagal', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const { router } = await renderApp('/pratinjau/gagal');
    const invalidate = vi.spyOn(router, 'invalidate');

    fireEvent.click(await screen.findByRole('button', { name: t.common.retry }));

    await waitFor(() => expect(invalidate).toHaveBeenCalledTimes(1));
    // Halaman pratinjau selalu gagal, jadi layar gagal muncul lagi setelah dicoba ulang.
    expect(await screen.findByRole('alert')).toBeVisible();
  });
});

describe('keadaan memuat halaman', () => {
  it('judul dan navigasi sudah tampil; hanya isi halaman yang berupa kerangka', async () => {
    await renderApp('/kontak/pratinjau-memuat');

    // Judul diketahui dari rute, jadi tampil sebagai judul asli, bukan balok.
    expect(await screen.findByRole('heading', { level: 1, name: t.nav.contacts })).toBeVisible();
    expect(navLink(t.nav.contacts)).toHaveAttribute('aria-current', 'page');
    expect(document.title).toBe(`${t.nav.contacts} · ${product}`);

    const status = screen.getByRole('status');
    expect(status).toHaveAttribute('aria-busy', 'true');
    expect(status).toHaveTextContent(t.common.loading);
    expect(within(status).queryByRole('heading')).toBeNull();
  });
});

describe('navActiveState', () => {
  const byId = (id: string) => {
    const item = navItems.find((candidate) => candidate.id === id);
    if (!item) throw new Error(`Item navigasi ${id} tidak ada`);
    return item;
  };

  it('menandai halaman yang cocok, termasuk sub-alamatnya', () => {
    expect(navActiveState(byId('inbox'), '/inbox')).toBe('page');
    expect(navActiveState(byId('inbox'), '/inbox/abc')).toBe('page');
    expect(navActiveState(byId('inbox'), '/inboxes')).toBeNull();
    expect(navActiveState(byId('contacts'), '/inbox')).toBeNull();
  });

  it('"Lainnya" aktif sebagai induk untuk Tiket, Laporan, Pengaturan', () => {
    const more = byId('more');
    expect(navActiveState(more, '/lainnya')).toBe('page');
    expect(navActiveState(more, '/tiket')).toBe('section');
    expect(navActiveState(more, '/laporan')).toBe('section');
    expect(navActiveState(more, '/pengaturan')).toBe('section');
    expect(navActiveState(more, '/inbox')).toBeNull();
    expect(navActiveState(more, '/kontak')).toBeNull();
  });

  it('navigasi bawah HP berisi tepat Inbox, Kontak, Broadcast, Lainnya', () => {
    const bottom = navItems.filter(
      (item) => item.placement === 'primary' || item.placement === 'more',
    );
    expect(bottom.map((item) => item.label)).toEqual([
      t.nav.inbox,
      t.nav.contacts,
      t.nav.broadcast,
      t.nav.more,
    ]);
  });
});
