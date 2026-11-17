/**
 * Tes penjaga review keamanan web — UI template Meta, kirim template, percakapan baru
 * (docs/security-reviews/2026-11-21-fase4-template-web.md). Semua `it` = regresi.
 */
import { API_ROUTES, apiPath, type MessageTemplate } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../i18n/id';
import { media } from '../lib/media';
import { fakeSession, json, type FakeHandler } from '../test/fake-api';
import { fakeChannelSummary, fakeConversation, fakeMessage } from '../test/fake-inbox';
import { fakeOtpTemplate, fakeTemplate } from '../test/fake-templates';
import { setMediaQuery } from '../test/match-media';
import { renderApp } from '../test/render-app';
import { expectSecretNowhere, secretSpies } from '../test/secret-nowhere';

const c = t.templates;
const k = t.inbox.compose;
const s = t.inbox.templateSend;
const OTP = '739104';
const HTML = '"><img src=x onerror="window.__xss=1">';
const HOUR = 3_600_000;

afterEach(() => {
  vi.restoreAllMocks();
});

function noInjection() {
  expect(document.querySelector('img[src="x"]')).toBeNull();
  expect(document.querySelector('[onerror]')).toBeNull();
  expect((window as { __xss?: number }).__xss).toBeUndefined();
}

/** Template dengan HTML di setiap isian teks + tombol URL berskema berbahaya. */
function hostileTemplate(): MessageTemplate {
  const base = fakeTemplate();
  return fakeTemplate({
    name: 'promo_jahat',
    status: 'REJECTED',
    rejectedReason: `ALASAN_BARU ${HTML}`,
    content: {
      ...base.content,
      header: { format: 'TEXT', text: `Judul ${HTML}` },
      body: { text: `Halo {{1}} ${HTML}`, examples: { '1': `Contoh ${HTML}` } },
      footer: { text: `Kaki ${HTML}` },
      buttons: [
        { type: 'URL', text: `Buka ${HTML}`.slice(0, 25), url: 'javascript:alert(1)//{{1}}' },
        { type: 'PHONE_NUMBER', text: 'Telepon', phoneNumber: '+6281200000000' },
      ] as never,
    },
  });
}

describe('review keamanan — isi template tampil sebagai teks', () => {
  it('daftar & editor: alasan penolakan Meta, isi, contoh, tombol → teks; tombol URL tidak jadi tautan', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const hostile = hostileTemplate();
    const routes: Record<string, FakeHandler> = {
      [`GET ${API_ROUTES.templates.list}`]: () => json({ templates: [hostile] }),
      [`GET ${apiPath(API_ROUTES.templates.template, { templateId: hostile.id })}`]: () =>
        json({ template: hostile }),
    };
    const view = await renderApp('/pengaturan/template', {
      inbox: { channels: [fakeChannelSummary()] },
      routes,
    });
    await screen.findByRole('list', { name: c.listLabel });
    noInjection();
    expect(document.body.textContent).toContain('ALASAN_BARU');

    await act(() =>
      view.router.navigate({
        to: '/pengaturan/template/$templateId',
        params: { templateId: hostile.id },
      }),
    );
    expect(await screen.findByDisplayValue('promo_jahat')).toBeInTheDocument();
    // Pratinjau gelembung memuat footer & judul sebagai teks.
    await waitFor(() => expect(document.body.textContent).toContain('Kaki '));
    noInjection();
    for (const anchor of Array.from(document.querySelectorAll('a[href]'))) {
      expect(anchor.getAttribute('href') ?? '').not.toMatch(/^\s*javascript:/i);
      expect(anchor.getAttribute('href') ?? '').not.toContain('{{1}}');
    }
  });

  it('CS & Teknisi dialihkan dari Pengaturan → Template', async () => {
    for (const role of ['cs', 'teknisi'] as const) {
      const view = await renderApp('/pengaturan/template', {
        session: fakeSession(role),
        inbox: { channels: [fakeChannelSummary()] },
        routes: { [`GET ${API_ROUTES.templates.list}`]: () => json({ templates: [] }) },
      });
      await waitFor(() =>
        expect(view.router.state.location.pathname).not.toBe('/pengaturan/template'),
      );
      view.unmount();
    }
  });
});

describe('review keamanan — kode OTP di dialog kirim template', () => {
  it('setelah terkirim: kode tidak di cache Query/mutasi, storage, console, DOM, atau isian', async () => {
    act(() => setMediaQuery(media.desktop, true));
    const watch = secretSpies();
    const otp = fakeOtpTemplate();
    const expired = fakeConversation({
      status: 'served',
      assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
      windowExpiresAt: new Date(Date.now() - HOUR).toISOString(),
    });
    const messagesPath = apiPath(API_ROUTES.inbox.messages, { conversationId: expired.id });
    const view = await renderApp(`/inbox?chat=${expired.id}`, {
      inbox: {
        conversations: [expired],
        messages: {
          [expired.id]: [
            fakeMessage({
              text: 'Halo kak',
              createdAt: new Date(Date.now() - 30 * HOUR).toISOString(),
            }),
          ],
        },
        channels: [fakeChannelSummary()],
      },
      routes: {
        [`GET ${API_ROUTES.templates.list}`]: () => json({ templates: [otp] }),
        // Server menyamarkan kode di teks pesan (review template S1).
        [`POST ${messagesPath}`]: () =>
          json(
            {
              message: fakeMessage({
                direction: 'outbound',
                senderKind: 'agent',
                type: 'template',
                text: 'Kode verifikasi: ••••••',
                status: 'pending',
              }),
            },
            { status: 202 },
          ),
      },
    });
    const chat = within(screen.getByRole('region', { name: t.inbox.chat.label }));
    await chat.findByText('Halo kak');
    fireEvent.click(chat.getByRole('button', { name: k.sendTemplate }));
    const dialog = within(await screen.findByRole('dialog', { name: s.title }));
    fireEvent.click(await dialog.findByRole('button', { name: /kode_verifikasi/ }));
    fireEvent.change(dialog.getByLabelText(s.otpCode), { target: { value: OTP } });
    fireEvent.click(dialog.getByRole('button', { name: s.send }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: s.title })).toBeNull());
    expect(
      view.api.requests.find((r) => r.method === 'POST' && r.path === messagesPath)?.body,
    ).toMatchObject({ parameters: { body: { '1': OTP } } });
    // Isi permintaan di atas hanya catatan server tiruan; aplikasi sendiri tidak menyimpan kodenya.
    expectSecretNowhere(view, OTP, watch);
  });
});
