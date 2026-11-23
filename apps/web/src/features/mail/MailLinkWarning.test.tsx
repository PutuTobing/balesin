import { screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { t } from '../../i18n/id';
import { renderApp } from '../../test/render-app';
import { parseMailLinkWarningSearch, safeLinkTarget } from './mail-link-warning';

const w = t.mail.linkWarning;
const path = (ke: string, tampil = 'bank.co.id') =>
  `/email/tautan?ke=${encodeURIComponent(ke)}&tampil=${encodeURIComponent(tampil)}`;

describe('peringatan tautan menipu (/email/tautan)', () => {
  it('hanya http/https yang jadi tujuan; skema lain & teks rusak ditolak', () => {
    expect(safeLinkTarget('https://bank-co-id.jahat.test/masuk')?.hostname).toBe(
      'bank-co-id.jahat.test',
    );
    expect(safeLinkTarget('http://contoh.test/')?.protocol).toBe('http:');
    for (const bad of [
      'javascript:alert(1)',
      'JaVaScRiPt:alert(1)',
      'data:text/html,<script>alert(1)</script>',
      'file:///etc/passwd',
      'blob:https://contoh.test/x',
      'vbscript:msgbox(1)',
      '//jahat.test/x',
      'bukan url',
      '',
      undefined,
    ]) {
      expect(safeLinkTarget(bad), String(bad)).toBeNull();
    }
    expect(parseMailLinkWarningSearch({ ke: 1, tampil: ['x'] })).toEqual({});
    expect(parseMailLinkWarningSearch({ ke: 'x'.repeat(5000) })).toEqual({});
  });

  it('menampilkan URL lengkap + domain asli sebagai teks, tanpa pengalihan; "Tetap buka" tab baru tanpa opener', async () => {
    const { router } = await renderApp(path('https://bank-co-id.jahat.test/masuk?x=1'));
    expect(await screen.findByRole('heading', { level: 1, name: w.title })).toBeVisible();
    expect(screen.getByText('bank-co-id.jahat.test')).toBeVisible();
    expect(screen.getByText('https://bank-co-id.jahat.test/masuk?x=1')).toBeVisible();
    expect(screen.getByText('bank.co.id')).toBeVisible();
    const open = screen.getByRole('link', { name: w.open });
    expect(open).toHaveAttribute('href', 'https://bank-co-id.jahat.test/masuk?x=1');
    expect(open).toHaveAttribute('target', '_blank');
    expect(open).toHaveAttribute('rel', 'noopener noreferrer');
    expect(screen.getByRole('link', { name: w.back })).toHaveAttribute('href', '/email');
    // Tidak ada pengalihan otomatis.
    expect(router.state.location.pathname).toBe('/email/tautan');
  });

  it('ke = javascript: → tidak ada tautan keluar sama sekali', async () => {
    await renderApp(path('javascript:alert(document.cookie)'));
    expect(await screen.findByRole('heading', { level: 1, name: w.invalidTitle })).toBeVisible();
    expect(screen.queryByRole('link', { name: w.open })).toBeNull();
    for (const link of screen.getAllByRole('link')) {
      expect(link.getAttribute('href') ?? '').not.toMatch(/^javascript:/i);
    }
  });
});
