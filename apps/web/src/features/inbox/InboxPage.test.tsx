import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { defaultBrand } from '../../brand/brand';
import { t } from '../../i18n/id';
import { deviceKey } from '../../lib/device-storage';
import { media } from '../../lib/media';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';
import { INBOX_TABS, parseInboxSearch, parseInboxTab } from './inbox-search';

const mascot = defaultBrand.mascotName;

function list() {
  return within(screen.getByRole('region', { name: t.inbox.listLabel }));
}

function tab(name: string) {
  return list().getByRole('tab', { name });
}

describe('parameter URL inbox', () => {
  it('menerima tab yang dikenal dan mengabaikan sisanya', () => {
    expect(parseInboxTab('bot')).toBe('bot');
    expect(parseInboxTab('belum-dilayani')).toBe('belum-dilayani');
    expect(parseInboxTab('<script>')).toBe('semua');
    expect(parseInboxTab(undefined)).toBe('semua');
    expect(parseInboxTab(42)).toBe('semua');
  });

  it('tab bawaan tidak ditulis ke URL', () => {
    expect(parseInboxSearch({})).toEqual({});
    expect(parseInboxSearch({ tab: 'semua' })).toEqual({});
    expect(parseInboxSearch({ tab: 'selesai', lain: 'x' })).toEqual({ tab: 'selesai' });
    expect(parseInboxSearch({ tab: 'ngawur' })).toEqual({});
  });
});

describe('daftar chat', () => {
  it('menampilkan lima tab status dengan "Semua" terpilih', async () => {
    await renderApp('/inbox');

    const tabs = list().getAllByRole('tab');
    expect(tabs.map((element) => element.textContent)).toEqual(
      INBOX_TABS.map((id) => t.inbox.tabs[id]),
    );
    expect(tab(t.inbox.tabs.semua)).toHaveAttribute('aria-selected', 'true');
    expect(list().getByRole('tablist', { name: t.inbox.tabsLabel })).toBeInTheDocument();
  });

  it('keadaan kosong memakai teks produk dan nama maskot dari konfigurasi merek', async () => {
    await renderApp('/inbox');

    const panel = within(list().getByRole('tabpanel'));
    expect(panel.getByRole('heading', { name: t.inbox.empty.semua.title })).toBeVisible();
    expect(panel.getByText(t.inbox.empty.semua.body(mascot))).toBeVisible();
    expect(panel.getByText(new RegExp(mascot))).toBeVisible();
  });

  it('ganti tab mengubah URL dan teks keadaan kosong', async () => {
    const { router } = await renderApp('/inbox');

    fireEvent.mouseDown(tab(t.inbox.tabs['belum-dilayani']));

    await waitFor(() =>
      expect(tab(t.inbox.tabs['belum-dilayani'])).toHaveAttribute('aria-selected', 'true'),
    );
    expect(router.state.location.search).toEqual({ tab: 'belum-dilayani' });
    expect(
      list().getByRole('heading', { name: t.inbox.empty['belum-dilayani'].title }),
    ).toBeVisible();

    fireEvent.mouseDown(tab(t.inbox.tabs.semua));

    await waitFor(() => expect(tab(t.inbox.tabs.semua)).toHaveAttribute('aria-selected', 'true'));
    expect(router.state.location.search).toEqual({});
  });

  it('membuka tab dari URL, dan kembali ke "Semua" bila nilainya tak dikenal', async () => {
    const first = await renderApp('/inbox?tab=selesai');
    expect(tab(t.inbox.tabs.selesai)).toHaveAttribute('aria-selected', 'true');
    expect(list().getByRole('heading', { name: t.inbox.empty.selesai.title })).toBeVisible();
    first.unmount();

    await renderApp('/inbox?tab=tidak-ada');
    expect(tab(t.inbox.tabs.semua)).toHaveAttribute('aria-selected', 'true');
  });

  it('pencarian tanpa hasil menjelaskan apa yang dicari dan bisa dihapus', async () => {
    await renderApp('/inbox');

    const input = list().getByRole('searchbox', { name: t.inbox.searchLabel });
    fireEvent.change(input, { target: { value: '  Budi <b>  ' } });

    // Kata yang diketik tampil sebagai teks biasa (tidak ditafsirkan sebagai HTML).
    expect(
      list().getByRole('heading', { name: t.inbox.searchEmpty.title('Budi <b>') }),
    ).toBeVisible();
    expect(list().getByText(t.inbox.searchEmpty.body)).toBeVisible();

    const panel = within(list().getByRole('tabpanel'));
    fireEvent.click(panel.getByRole('button', { name: t.inbox.clearSearch }));

    expect(input).toHaveValue('');
    expect(list().getByRole('heading', { name: t.inbox.empty.semua.title })).toBeVisible();
  });
});

describe('ruang chat dan panel detail', () => {
  const detailKey = deviceKey('inbox.detail');

  it('desktop: tiga panel tampil, detail terbuka secara bawaan', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox');

    const chat = within(screen.getByRole('region', { name: t.inbox.chat.label }));
    expect(chat.getByRole('heading', { name: t.inbox.chat.emptyTitle })).toBeVisible();

    const detail = within(screen.getByRole('complementary', { name: t.inbox.detail.label }));
    expect(detail.getByRole('heading', { name: t.inbox.detail.title })).toBeVisible();
    expect(detail.getByText(t.inbox.detail.emptyBody)).toBeVisible();
  });

  it('desktop: detail bisa disembunyikan, diingat, dan fokus mengikuti tombolnya', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox');

    fireEvent.click(screen.getByRole('button', { name: t.inbox.detail.hide }));

    expect(screen.queryByRole('complementary', { name: t.inbox.detail.label })).toBeNull();
    expect(window.localStorage.getItem(detailKey)).toBe('0');
    const show = screen.getByRole('button', { name: t.inbox.detail.show });
    expect(show).toHaveAttribute('aria-expanded', 'false');
    await waitFor(() => expect(show).toHaveFocus());

    fireEvent.click(show);

    expect(screen.getByRole('complementary', { name: t.inbox.detail.label })).toBeVisible();
    expect(window.localStorage.getItem(detailKey)).toBe('1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: t.inbox.detail.hide })).toHaveFocus(),
    );
  });

  it('desktop: klik mouse tidak memindahkan fokus (tooltip tidak ikut muncul)', async () => {
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox');

    fireEvent.click(screen.getByRole('button', { name: t.inbox.detail.hide }), { detail: 1 });

    const show = screen.getByRole('button', { name: t.inbox.detail.show });
    expect(show).toBeVisible();
    expect(show).not.toHaveFocus();
  });

  it('desktop: pilihan tersembunyi dipakai lagi saat inbox dibuka kembali', async () => {
    window.localStorage.setItem(detailKey, '0');
    act(() => setMediaQuery(media.desktop, true));
    await renderApp('/inbox');

    expect(screen.queryByRole('complementary', { name: t.inbox.detail.label })).toBeNull();
    expect(screen.getByRole('button', { name: t.inbox.detail.show })).toBeVisible();
  });

  it('tablet: detail tertutup secara bawaan, melayang saat dibuka, Escape menutup', async () => {
    await renderApp('/inbox');

    expect(screen.queryByRole('complementary', { name: t.inbox.detail.label })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: t.inbox.detail.show }));
    const detail = screen.getByRole('complementary', { name: t.inbox.detail.label });
    // Mode melayang tidak mengubah preferensi desktop yang tersimpan.
    expect(window.localStorage.getItem(detailKey)).toBeNull();

    fireEvent.keyDown(detail, { key: 'Escape' });
    expect(screen.queryByRole('complementary', { name: t.inbox.detail.label })).toBeNull();
  });
});
