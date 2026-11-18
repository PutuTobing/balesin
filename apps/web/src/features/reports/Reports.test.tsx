import { REPORT_ROUTES, type ReportPerformance } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, emptyReport, fakeSession, json } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { ApiError } from '../../lib/api/client';
import {
  formatDuration,
  niceScale,
  presetRange,
  rangeError,
  recentMonths,
  retryReport,
} from './report-logic';

const r = t.reports;
const c = t.csat;

function fullReport(): ReportPerformance {
  const base = emptyReport(
    { method: 'GET', path: '', headers: {}, body: undefined, query: new URLSearchParams() },
    'owner',
  );
  return {
    ...base,
    summary: {
      conversations: 40,
      customerInitiated: 36,
      resolved: 30,
      resolvedByBotOnly: 6,
      handledByHuman: 28,
      handoffs: 9,
      firstResponse: { count: 28, averageSeconds: 210, medianSeconds: 95, p90Seconds: 600 },
      wait: { count: 9, averageSeconds: 60, medianSeconds: 45, p90Seconds: 120 },
      resolution: { count: 30, averageSeconds: 4000, medianSeconds: 3600, p90Seconds: 9000 },
    },
    trends: {
      daily: [
        { date: '2026-11-17', conversations: 20, resolved: 15, averageFirstResponseSeconds: 100 },
        { date: '2026-11-18', conversations: 20, resolved: 15, averageFirstResponseSeconds: null },
      ],
      hourly: Array.from({ length: 24 }, (_, hour) => ({ hour, conversations: hour % 5 })),
    },
    agents: [
      {
        user: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0a02', name: 'Agus Saputra', role: 'cs' },
        conversationsHandled: 20,
        resolved: 18,
        messagesSent: 140,
        firstResponse: { count: 20, averageSeconds: 100, medianSeconds: 80, p90Seconds: 300 },
        csat: {
          sent: 10,
          responses: 8,
          average: 4.5,
          distribution: { '1': 0, '2': 0, '3': 1, '4': 2, '5': 5 },
          responseRate: 80,
        },
      },
    ],
    csat: {
      sent: 10,
      responses: 8,
      average: 4.5,
      distribution: { '1': 0, '2': 0, '3': 1, '4': 2, '5': 5 },
      responseRate: 80,
    },
  };
}

describe('logika laporan', () => {
  it('rentang preset di zona organisasi & batas 92 hari', () => {
    expect(presetRange('7', '2026-11-18')).toEqual({ from: '2026-11-12', to: '2026-11-18' });
    expect(presetRange('bulan-lalu', '2026-03-10')).toEqual({
      from: '2026-02-01',
      to: '2026-02-28',
    });
    expect(rangeError({ from: '2026-01-01', to: '2026-04-03' })).toBe(r.rangeTooLong(92));
    expect(rangeError({ from: '2026-01-01', to: '2026-04-02' })).toBeNull();
    expect(rangeError({ from: '2026-02-01', to: '2026-01-01' })).toBe(r.rangeOrder);
    expect(recentMonths('2026-01-15', 3)).toEqual(['2026-01', '2025-12', '2025-11']);
  });

  it('429 singkat (laporan lain berjalan) diulang otomatis; batas per menit & 503 tidak', () => {
    const limited = (seconds: number) =>
      new ApiError({ status: 429, code: 'RATE_LIMITED', message: 'x', retryAfterSeconds: seconds });
    expect(retryReport(0, limited(5))).toBe(true);
    expect(retryReport(2, limited(5))).toBe(false);
    expect(retryReport(0, limited(40))).toBe(false);
    expect(
      retryReport(0, new ApiError({ status: 503, code: 'SERVICE_UNAVAILABLE', message: 'x' })),
    ).toBe(false);
  });

  it('durasi & skala sumbu', () => {
    expect(formatDuration(45)).toBe('45 dtk');
    expect(formatDuration(95)).toBe('1 mnt 35 dtk');
    expect(formatDuration(3600)).toBe('1 j');
    expect(formatDuration(null)).toBe('—');
    expect(niceScale(37)).toEqual({ top: 40, step: 10 });
    expect(niceScale(0)).toEqual({ top: 4, step: 1 });
  });
});

describe('laporan kinerja', () => {
  it('Owner: ringkasan, grafik + tabel alternatif, per agen', async () => {
    await renderApp('/laporan', {
      routes: { [`GET ${REPORT_ROUTES.performance}`]: () => json({ report: fullReport() }) },
    });
    expect((await screen.findAllByText(`${r.firstResponse} (${r.median})`))[0]).toBeVisible();
    expect(screen.getByText('1 mnt 35 dtk')).toBeVisible();
    expect(screen.getByRole('img', { name: r.dailyTitle })).toBeInTheDocument();
    const daily = screen.getByRole('region', { name: r.dailyTitle });
    fireEvent.click(within(daily).getByRole('button', { name: r.showTable }));
    expect(within(daily).getByRole('table')).toBeVisible();
    expect(screen.getByRole('button', { name: r.tabCosts })).toBeVisible();
    const agents = screen.getByRole('region', { name: r.agentsTitle });
    expect(within(agents).getByRole('rowheader', { name: 'Agus Saputra' })).toBeVisible();
  });

  it('CS: "Kinerja saya" tanpa tab biaya', async () => {
    await renderApp('/laporan', { session: fakeSession('cs') });
    expect(await screen.findByText(r.ownIntro)).toBeVisible();
    expect(screen.queryByRole('button', { name: r.tabCosts })).toBeNull();
    expect(screen.queryByRole('region', { name: r.dailyTitle })).toBeNull();
  });

  it('503 terlalu berat → saran persempit rentang', async () => {
    await renderApp('/laporan', {
      routes: {
        [`GET ${REPORT_ROUTES.performance}`]: () =>
          apiError(503, 'SERVICE_UNAVAILABLE', 'Laporan terlalu berat. Persempit rentang.'),
      },
    });
    expect(await screen.findByText(r.heavyTitle)).toBeVisible();
  });

  it('429 → tombol coba lagi terkunci dengan hitung mundur', async () => {
    await renderApp('/laporan', {
      routes: {
        [`GET ${REPORT_ROUTES.performance}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Terlalu sering.', { retryAfter: 30 }),
      },
    });
    expect(await screen.findByText(r.limitedTitle)).toBeVisible();
    expect(screen.getByRole('button', { name: /Coba lagi \(0:/ })).toBeDisabled();
  });

  it('rentang kustom lebih dari 92 hari ditolak sebelum dikirim', async () => {
    await renderApp('/laporan');
    fireEvent.change(await screen.findByLabelText(r.rangeLabel), { target: { value: 'kustom' } });
    fireEvent.change(screen.getByLabelText(r.from), { target: { value: '2026-01-01' } });
    fireEvent.change(screen.getByLabelText(r.to), { target: { value: '2026-06-01' } });
    fireEvent.click(screen.getByRole('button', { name: r.apply }));
    expect(await screen.findByText(r.rangeTooLong(92))).toBeVisible();
  });

  describe('ekspor', () => {
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => 'blob:laporan');
      URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => vi.restoreAllMocks());

    it('CSV per agen: GET ber-CSRF', async () => {
      let headers: Record<string, string> = {};
      let kind: string | null = null;
      await renderApp('/laporan', {
        routes: {
          [`GET ${REPORT_ROUTES.performance}`]: () => json({ report: fullReport() }),
          [`GET ${REPORT_ROUTES.exportCsv}`]: (request) => {
            headers = request.headers;
            kind = request.query.get('kind');
            return new Response('agen\n', { headers: { 'content-type': 'text/csv' } });
          },
        },
      });
      fireEvent.click(await screen.findByRole('button', { name: r.exportLabel(r.agentsTitle) }));
      expect(await screen.findByText(r.exported)).toBeVisible();
      expect(kind).toBe('agents');
      expect(headers['x-csrf-token']).toBe('csrf-tes-1');
    });
  });
});

describe('biaya Meta', () => {
  it('perkiraan + sumber tarif + kategori template', async () => {
    await renderApp('/laporan', {
      routes: {
        [`GET ${REPORT_ROUTES.costs}`]: () =>
          json({
            costs: {
              month: '2026-11',
              timezone: 'Asia/Jakarta',
              currency: 'IDR',
              rateSource: 'Tarif bawaan Indonesia',
              total: 125_000,
              unknownRate: 3,
              computedAt: '2026-11-18T03:00:00.000Z',
              channels: [
                {
                  channel: { id: '6f1c2a90-1111-4c4c-9a9a-000000000001', name: 'CS Utama' },
                  serviceConversations: 1200,
                  freeQuota: 1000,
                  freeRemaining: 0,
                  billableService: 200,
                  serviceCost: 25_000,
                  templates: {
                    MARKETING: { sent: 100, billable: 90, free: 0, cost: 60_000 },
                    UTILITY: { sent: 200, billable: 180, free: 20, cost: 40_000 },
                    AUTHENTICATION: { sent: 0, billable: 0, free: 0, cost: 0 },
                  },
                  total: 125_000,
                },
              ],
            },
          }),
      },
    });
    fireEvent.click(await screen.findByRole('button', { name: r.tabCosts }));
    expect(await screen.findByText(r.rateSource('Tarif bawaan Indonesia'))).toBeVisible();
    expect(screen.getAllByText(r.estimateBadge).length).toBeGreaterThan(0);
    expect(screen.getByText(r.unknownRate(3))).toBeVisible();
    expect(screen.getByRole('rowheader', { name: 'Marketing' })).toBeVisible();
  });
});

describe('Pengaturan → CSAT', () => {
  const settings = {
    enabled: false,
    question: 'Bagaimana pelayanan kami hari ini?',
    thanks: 'Terima kasih!',
    minIntervalHours: 24,
    updatedAt: null,
  };

  it('tautan di teks ditolak sebelum dikirim; simpan menyalakan survei', async () => {
    let saved: unknown = null;
    await renderApp('/pengaturan/csat', {
      routes: {
        [`GET ${REPORT_ROUTES.csatSettings}`]: () => json({ csat: settings }),
        [`PUT ${REPORT_ROUTES.csatSettings}`]: (request) => {
          saved = request.body;
          return json({
            csat: { ...settings, enabled: true, updatedAt: '2026-11-18T03:00:00.000Z' },
          });
        },
      },
    });
    const question = await screen.findByLabelText(c.question);
    fireEvent.change(question, { target: { value: 'Isi survei di https://contoh.id' } });
    fireEvent.click(screen.getByRole('button', { name: c.save }));
    expect(await screen.findByText('Pertanyaan tidak boleh memuat tautan.')).toBeVisible();
    expect(saved).toBeNull();
    fireEvent.change(question, { target: { value: 'Bagaimana pelayanan kami?' } });
    fireEvent.click(screen.getByLabelText(c.enabled));
    fireEvent.click(screen.getByRole('button', { name: c.save }));
    await waitFor(() =>
      expect(saved).toEqual({
        enabled: true,
        question: 'Bagaimana pelayanan kami?',
        thanks: 'Terima kasih!',
        minIntervalHours: 24,
      }),
    );
    expect(await screen.findByText(c.saved)).toBeVisible();
  });
});
