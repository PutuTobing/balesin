import { API_ROUTES, type SecurityEvent, type SecuritySummaryResponse } from '@balesin/shared';
import { act, fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { queryKeys } from '../../lib/api/queries';
import { emptySecuritySummary, fakeSession, json } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { auditSearchFor, bannerSeenKey, unseenWarnings } from './banner-state';

const copy = t.securityBanner;
const OWNER_ID = fakeSession('owner').user.id;

function event(overrides: Partial<SecurityEvent> = {}): SecurityEvent {
  return {
    id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c11',
    kind: 'email_sender_changed',
    severity: 'warning',
    occurredAt: '2026-11-14T01:00:00.000Z',
    actor: {
      id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0005',
      name: 'Agus Pratama',
      email: 'agus@majujaya.co.id',
      role: 'admin',
    },
    subject: null,
    details: { previousHost: 'mail.lama.test', host: 'mail.baru.test' },
    ...overrides,
  };
}

function summary(events: SecurityEvent[]): SecuritySummaryResponse {
  const warnings = events.filter((item) => item.severity === 'warning');
  return {
    ...emptySecuritySummary,
    events,
    latestWarningAt: warnings[0]?.occurredAt ?? null,
  };
}

const WARNING = event();
const INFO = event({
  id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c12',
  kind: 'role_changed',
  severity: 'info',
  occurredAt: '2026-11-14T02:00:00.000Z',
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('status "sudah dilihat"', () => {
  it('hanya kejadian warning yang lebih baru dari waktu ditutup', () => {
    const data = summary([INFO, WARNING]);
    expect(unseenWarnings(data, 0)).toEqual([WARNING]);
    expect(unseenWarnings(data, Date.parse(WARNING.occurredAt))).toEqual([]);
    expect(unseenWarnings(summary([INFO]), 0)).toEqual([]);
  });

  it('tautan Audit log: satu jenis → saringan aksinya; mulai dari tanggal kejadian tertua', () => {
    const search = auditSearchFor([WARNING], emptySecuritySummary.since);
    expect(search.action).toBe('settings.email.updated');
    expect(search.from).toMatch(/^2026-11-1[34]$/);
    const mixed = auditSearchFor(
      [WARNING, event({ kind: 'account_locked', occurredAt: '2026-11-12T01:00:00.000Z' })],
      emptySecuritySummary.since,
    );
    expect(mixed.action).toBeUndefined();
  });
});

describe('banner peringatan keamanan', () => {
  it('Owner: tampil di halaman aplikasi, menyebut kejadian terbaru dan pelakunya', async () => {
    await renderApp('/inbox', { securitySummary: summary([INFO, WARNING]) });
    const banner = await screen.findByRole('region', { name: copy.title(1) });
    expect(banner).toHaveTextContent('Email pengirim diubah oleh selain Owner');
    expect(banner).toHaveTextContent(copy.by('Agus Pratama', 'Admin'));
    // Bukan wilayah alert (tampil sejak awal, tidak diumumkan berulang).
    expect(banner).not.toHaveAttribute('role', 'alert');
    expect(screen.getByRole('link', { name: copy.review })).toHaveAttribute(
      'href',
      expect.stringContaining('/pengaturan/audit?'),
    );
  });

  it('ditutup → disimpan per pengguna di localStorage, tidak tampil lagi; fokus ke konten', async () => {
    const view = await renderApp('/inbox', { securitySummary: summary([WARNING]) });
    fireEvent.click(await screen.findByRole('button', { name: copy.dismiss }));
    expect(screen.queryByRole('region', { name: copy.title(1) })).toBeNull();
    expect(window.localStorage.getItem(bannerSeenKey(OWNER_ID))).toBe(WARNING.occurredAt);
    expect(screen.getByRole('main')).toHaveFocus();
    view.unmount();
    await renderApp('/inbox', { securitySummary: summary([WARNING]) });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: copy.title(1) })).toBeNull();
  });

  it('localStorage menolak (mode privat): banner tetap bisa ditutup untuk kunjungan ini', async () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError');
    });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError');
    });
    await renderApp('/pengaturan', { securitySummary: summary([WARNING]) });
    fireEvent.click(await screen.findByRole('button', { name: copy.dismiss }));
    await waitFor(() => expect(screen.queryByRole('region', { name: copy.title(1) })).toBeNull());
  });

  it('kejadian baru setelah ditutup: tampil lagi', async () => {
    window.localStorage.setItem(bannerSeenKey(OWNER_ID), '2026-11-13T00:00:00.000Z');
    await renderApp('/inbox', { securitySummary: summary([WARNING]) });
    expect(await screen.findByRole('region', { name: copy.title(1) })).toBeVisible();
  });

  it('ringkasan tiba setelah halaman tampil: banner menunggu halaman berikutnya (tanpa lompatan)', async () => {
    let release: () => void = () => undefined;
    const arrived = new Promise<void>((resolve) => (release = resolve));
    const view = await renderApp('/inbox', {
      routes: {
        [`GET ${API_ROUTES.audit.securitySummary}`]: async () => {
          await arrived;
          return json(summary([WARNING]));
        },
      },
    });
    await screen.findByRole('heading', { level: 1 });
    release();
    await waitFor(() =>
      expect(view.queryClient.getQueryData(queryKeys.securitySummary)).toBeDefined(),
    );
    // Beri React waktu merender data baru: banner tetap tidak muncul di halaman ini.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)));
    expect(screen.queryByRole('region', { name: copy.title(1) })).toBeNull();
    await act(() => view.router.navigate({ to: '/kontak' }));
    expect(await screen.findByRole('region', { name: copy.title(1) })).toBeVisible();
  });

  it('perubahan channel oleh selain Owner: tautan ke Audit log tersaring jenis target Channel', async () => {
    const channel = event({
      kind: 'channel_changed',
      subject: null,
      details: { change: 'updated', name: 'CS Utama', actorRole: 'admin' },
    });
    expect(auditSearchFor([channel], emptySecuritySummary.since)).toMatchObject({
      targetType: 'channel',
    });
    await renderApp('/inbox', { securitySummary: summary([channel]) });
    const banner = await screen.findByRole('region', { name: copy.title(1) });
    expect(banner).toHaveTextContent('Channel diubah oleh selain Owner');
    expect(screen.getByRole('link', { name: copy.review })).toHaveAttribute(
      'href',
      expect.stringContaining('targetType=channel'),
    );
  });

  it('CS (tanpa audit.view): tidak memuat ringkasan dan tidak melihat banner', async () => {
    const view = await renderApp('/inbox', {
      session: fakeSession('cs'),
      securitySummary: summary([WARNING]),
    });
    await screen.findByRole('heading', { level: 1 });
    expect(screen.queryByRole('region', { name: copy.title(1) })).toBeNull();
    expect(view.api.requests.some((request) => request.path.endsWith('/security-summary'))).toBe(
      false,
    );
  });
});
