import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  API_ROUTES,
  AUTO_MESSAGE_DEFAULT_TEXTS,
  EMAIL_SENDER_VERIFICATION_LABELS,
  apiPath,
  channelTypeInfos,
  type TelegramChannel,
  type WorkspaceSettings,
} from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../i18n/id';
import { media } from '../lib/media';
import { json, type FakeHandler } from '../test/fake-api';
import { fakeConversation, fakeMessage } from '../test/fake-inbox';
import { confirmIdentity, TEST_CODE, TEST_PASSWORD } from '../test/identity';
import { setMediaQuery } from '../test/match-media';
import { renderApp } from '../test/render-app';
import { expectSecretNowhere, secretSpies } from '../test/secret-nowhere';
import { summaryIdentity, untrustedNameLabel } from './inbox/contact-identity';

/**
 * Penjaga review keamanan web: channel Telegram/Email/Meta, inbox multi-channel, jam kerja &
 * pesan otomatis, saklar "Tersedia" (docs/security-reviews/2026-11-23-web-kanal-jam-kerja.md).
 * `it.fails` = temuan yang belum diperbaiki (ubah jadi `it` setelah diperbaiki).
 */

const c = t.connections;
const R = API_ROUTES.channelConnections;
const NOW = '2026-11-18T03:00:00.000Z';
const TOKEN = '1234567890:AAH-rahasia-token-bot-telegram-uji';
const NEW_TOKEN = '1234567890:AAH-token-PENGGANTI-yang-bocor-xyz';
const IMAP_PASSWORD = 'imap-RAHASIA-9f8e7d';
const SMTP_PASSWORD = 'smtp-RAHASIA-1a2b3c';

const TELEGRAM: TelegramChannel = {
  enabled: true,
  disabledAt: null,
  status: 'connected',
  lastTest: null,
  credentialsUpdatedAt: NOW,
  createdAt: NOW,
  updatedAt: NOW,
  id: '6f1c2a90-2222-4c4c-9a9a-0000000000a1',
  type: 'telegram',
  name: 'Bot CS',
  botUsername: 'majujaya_bot',
  botId: '1234567890',
  botTokenHint: '••••ghij',
  webhook: {
    url: 'https://balesin.contoh.id/webhooks/telegram/x',
    registeredAt: NOW,
    warning: null,
  },
};

function connectionRoutes(channels: unknown[], extra: Record<string, FakeHandler> = {}) {
  return {
    routes: {
      [`GET ${R.list}`]: () =>
        json({ channels, types: channelTypeInfos(), canStoreSecrets: true, maxChannels: 20 }),
      ...extra,
    },
  };
}

describe('Channel Telegram/Email/Meta — rahasia', () => {
  it('membuat Telegram: token & password konfirmasi tidak ada di cache, storage, console, DOM', async () => {
    const spies = secretSpies();
    let body: Record<string, unknown> | null = null;
    const view = await renderApp(
      '/pengaturan/channel/baru/telegram',
      connectionRoutes([], {
        [`POST ${R.list}`]: (request) => {
          body = request.body as Record<string, unknown>;
          return json({ channel: TELEGRAM, webhook: null }, { status: 201 });
        },
        [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
          json({ channel: TELEGRAM }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(c.name), { target: { value: 'Bot CS' } });
    const token = screen.getByLabelText(c.botToken);
    fireEvent.change(token, { target: { value: TOKEN } });
    expect(token.getAttribute('value')).toBeNull();
    expect(token.getAttribute('autocomplete')).toBe('new-password');
    fireEvent.click(screen.getByRole('button', { name: c.create }));
    await confirmIdentity(c.confirmTitle('Telegram'), c.create);
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({ botToken: TOKEN });
    expect(await screen.findByText(c.created)).toBeVisible();
    expectSecretNowhere(view, TOKEN, spies);
    expectSecretNowhere(view, TEST_PASSWORD, spies);
  });

  it('membuat Email: password IMAP & SMTP kustom tidak tertinggal di mana pun; SMTP tanpa TLS tidak ditawarkan', async () => {
    const spies = secretSpies();
    let body: Record<string, unknown> | null = null;
    const view = await renderApp(
      '/pengaturan/channel/baru/email',
      connectionRoutes([], {
        [`POST ${R.list}`]: (request) => {
          body = request.body as Record<string, unknown>;
          return json({ channel: TELEGRAM, webhook: null }, { status: 201 });
        },
        [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
          json({ channel: TELEGRAM }),
      }),
    );
    fireEvent.change(await screen.findByLabelText(c.name), { target: { value: 'Email CS' } });
    fireEvent.change(screen.getByLabelText(c.emailAddress), {
      target: { value: 'cs@majujaya.co.id' },
    });
    fireEvent.change(screen.getByLabelText(c.fromName), { target: { value: 'CS Maju Jaya' } });
    fireEvent.change(screen.getByLabelText(c.imapHost), {
      target: { value: 'mail.majujaya.co.id' },
    });
    fireEvent.change(screen.getAllByLabelText(c.username)[0]!, {
      target: { value: 'cs@majujaya.co.id' },
    });
    fireEvent.change(screen.getAllByLabelText(c.password)[0]!, {
      target: { value: IMAP_PASSWORD },
    });
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(c.smtpCustom) }));
    const smtpSecurity = screen.getAllByLabelText(c.security)[1] as HTMLSelectElement;
    expect(Array.from(smtpSecurity.options).map((option) => option.value)).not.toContain('none');
    fireEvent.change(screen.getByLabelText(c.smtpHost), {
      target: { value: 'smtp.majujaya.co.id' },
    });
    fireEvent.change(screen.getAllByLabelText(c.username)[1]!, {
      target: { value: 'cs@majujaya.co.id' },
    });
    fireEvent.change(screen.getAllByLabelText(c.password)[1]!, {
      target: { value: SMTP_PASSWORD },
    });
    fireEvent.click(screen.getByRole('button', { name: c.create }));
    await confirmIdentity(c.confirmTitle('Email'), c.create);
    await waitFor(() => expect(body).not.toBeNull());
    expect(body).toMatchObject({
      imap: { password: IMAP_PASSWORD },
      smtp: { mode: 'custom', password: SMTP_PASSWORD },
    });
    await screen.findByText(c.created);
    for (const secret of [IMAP_PASSWORD, SMTP_PASSWORD, TEST_PASSWORD]) {
      expectSecretNowhere(view, secret, spies);
    }
  });

  // W1 (Sedang): `EditDialog` menutup `<Dialog open={!confirming}>` saat `IdentityDialog` terbuka;
  // `Dialog` melepas isinya bila tertutup, jadi `SecretField` ikut dilepas (callback ref → null).
  // `send(confirmation)` membangun ulang body dari ref yang sudah null → rahasia baru HILANG diam-diam:
  // ganti token/password/app secret (mis. rotasi setelah bocor) tidak pernah terkirim. Diuji: setelah
  // konfirmasi TIDAK ADA permintaan PATCH sama sekali (body kosong → dialog ditutup diam-diam).
  it.fails(
    'W1: mengganti token Telegram lewat "Ubah" + konfirmasi identitas benar-benar mengirim token baru',
    async () => {
      let patched: Record<string, unknown> | null = null;
      await renderApp(
        `/pengaturan/channel/lain/${TELEGRAM.id}`,
        connectionRoutes([TELEGRAM], {
          [`GET ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: () =>
            json({ channel: TELEGRAM }),
          [`PATCH ${apiPath(R.channel, { channelId: TELEGRAM.id })}`]: (request) => {
            patched = request.body as Record<string, unknown>;
            return json({ channel: TELEGRAM });
          },
        }),
      );
      fireEvent.click(await screen.findByRole('button', { name: c.edit }));
      const dialog = await screen.findByRole('dialog', { name: c.editTitle });
      fireEvent.change(within(dialog).getByLabelText(c.botToken), {
        target: { value: NEW_TOKEN },
      });
      fireEvent.click(within(dialog).getByRole('button', { name: c.save }));
      await confirmIdentity(c.editConfirmTitle, c.save);
      await waitFor(() => expect(patched).not.toBeNull());
      expect(patched).toMatchObject({
        botToken: NEW_TOKEN,
        confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
      });
    },
  );
});

// ── Pesan otomatis (jam kerja) ────────────────────────────────────────────────────────────────
const W = API_ROUTES.workspace;
const w = t.workspace;
const SETTINGS: WorkspaceSettings = {
  timezone: 'Asia/Makassar',
  teamHours: { mode: 'always' },
  holidays: [],
  withinTeamHoursNow: true,
  allocation: { mode: 'manual', maxOpenPerAgent: null },
  autoMessages: {
    greeting: { enabled: false, text: AUTO_MESSAGE_DEFAULT_TEXTS.greeting },
    away: { enabled: false, text: AUTO_MESSAGE_DEFAULT_TEXTS.away },
    assigned: { enabled: false, text: AUTO_MESSAGE_DEFAULT_TEXTS.assigned },
  },
  updatedAt: null,
};

async function enableGreetingWithIdentity() {
  const bodies: unknown[] = [];
  const view = await renderApp('/pengaturan/jam-kerja', {
    routes: {
      [`GET ${W.settings}`]: () => json({ settings: SETTINGS }),
      [`GET ${W.agents}`]: () => json({ agents: [] }),
      [`PUT ${W.settings}`]: (request) => {
        bodies.push(request.body);
        return json({ settings: SETTINGS });
      },
    },
  });
  const section = within(await screen.findByRole('form', { name: w.autoTitle }));
  fireEvent.click(section.getByLabelText(w.autoEnabled(w.autoLabels.greeting ?? '')));
  fireEvent.click(section.getByRole('button', { name: w.save }));
  const identity = await screen.findByRole('dialog', { name: w.autoConfirmTitle });
  return { view, bodies, identity };
}

describe('Pesan otomatis — konfirmasi identitas', () => {
  it('dialog identitas di luar <form>; password & kode tidak pernah masuk URL', async () => {
    const { view, bodies, identity } = await enableGreetingWithIdentity();
    expect(identity.querySelector('form')).not.toBeNull(); // form milik dialog sendiri
    expect(identity.closest('form')).toBeNull();
    expect(document.querySelector('form form')).toBeNull();
    await confirmIdentity(w.autoConfirmTitle, w.autoConfirm);
    await waitFor(() => expect(bodies).toHaveLength(1));
    const location = view.router.state.location;
    expect(JSON.stringify([location.href, location.search, window.location.href])).not.toContain(
      TEST_PASSWORD,
    );
    expect(window.location.search).not.toContain(TEST_CODE);
  });

  // W2 (Rendah): `useSaveWorkspace` = `useMutation`, dan `send()` memanggil
  // `save.mutateAsync({ autoMessages, confirmation })` → password akun + kode 2FA tersimpan di
  // `mutation.state.variables` (cache mutasi) selama halaman terbuka + gcTime. Pola lain di web
  // memanggil `endpoints.*` langsung untuk permintaan berkonfirmasi.
  it.fails('W2: password konfirmasi tidak tertinggal di cache mutasi', async () => {
    const { view, bodies } = await enableGreetingWithIdentity();
    await confirmIdentity(w.autoConfirmTitle, w.autoConfirm);
    await waitFor(() => expect(bodies).toHaveLength(1));
    const variables = view.queryClient
      .getMutationCache()
      .getAll()
      .map((mutation) => mutation.state.variables);
    expect(JSON.stringify(variables)).not.toContain(TEST_PASSWORD);
  });
});

// ── Inbox multi-channel ────────────────────────────────────────────────────────────────────────
const EMAIL_CHANNEL = {
  id: '6f1c2a90-1111-4c4c-9a9a-0000000000c2',
  name: 'Email CS',
  type: 'email' as const,
};

const XSS_HTML = [
  '<p id="isi-email">Halo</p>',
  '<script>window.__balesinXss = 1</script>',
  '<img src="x" onerror="window.__balesinXss = 2">',
  '<a href="javascript:window.__balesinXss=3">klik</a>',
  '<base href="https://penyerang.contoh/">',
  '<meta http-equiv="refresh" content="0;url=https://penyerang.contoh/">',
  '<form action="https://penyerang.contoh/"><input name="password"></form>',
  '<iframe src="https://penyerang.contoh/"></iframe>',
  '<svg onload="window.__balesinXss=4"></svg>',
].join('');

describe('Email di inbox', () => {
  async function openEmail(email: Record<string, unknown>, html = XSS_HTML) {
    const conversation = fakeConversation({
      channel: EMAIL_CHANNEL,
      windowApplies: false,
      windowExpiresAt: null,
      contact: {
        id: 'd0000000-0000-4000-8000-0000000000c9',
        number: 21,
        displayName: 'Rudi',
        nameSource: 'channel',
        phone: null,
        waUsername: null,
        channelHandle: 'rudi@contoh.id',
      },
    });
    const message = fakeMessage({
      text: 'Isi teks email',
      email: { subject: null, hasHtml: true, authWarning: false, skippedAttachments: 0, ...email },
      createdAt: new Date(Date.now() - 60_000).toISOString(),
    });
    act(() => setMediaQuery(media.desktop, true));
    await renderApp(`/inbox?chat=${conversation.id}`, {
      inbox: {
        conversations: [conversation],
        messages: { [conversation.id]: [message] },
      },
      routes: {
        [`GET ${apiPath(API_ROUTES.inbox.emailHtml, { messageId: message.id })}`]: () =>
          json({ html }),
      },
    });
    const chat = within(screen.getByRole('region', { name: t.inbox.chat.label }));
    await chat.findByText('Isi teks email');
    return chat;
  }

  it('HTML email (vektor XSS) hanya di iframe sandbox="" tanpa izin apa pun; tidak menyentuh dokumen aplikasi', async () => {
    const scriptsBefore = document.querySelectorAll('script').length;
    const chat = await openEmail({ senderVerification: 'pass' });
    fireEvent.click(chat.getByRole('button', { name: t.inbox.email.viewHtml }));
    const dialog = await screen.findByRole('dialog', { name: t.inbox.email.htmlTitle });
    const frame = await within(dialog).findByTitle(t.inbox.email.htmlFrameTitle);
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame.hasAttribute('allow')).toBe(false);
    expect(frame.hasAttribute('src')).toBe(false);
    expect(frame.getAttribute('referrerpolicy')).toBe('no-referrer');
    expect(frame.getAttribute('srcdoc')).toBe(XSS_HTML);
    // Tidak ada satu pun elemen kiriman email yang masuk ke dokumen aplikasi.
    expect(document.getElementById('isi-email')).toBeNull();
    expect(document.querySelectorAll('script').length).toBe(scriptsBefore);
    expect(document.querySelector('base, meta[http-equiv], img[src="x"], svg[onload]')).toBeNull();
    expect(document.querySelector('form[action^="https://penyerang"]')).toBeNull();
    expect((window as { __balesinXss?: number }).__balesinXss).toBeUndefined();
    // Satu-satunya iframe di halaman = bingkai sandbox ini.
    expect(document.querySelectorAll('iframe')).toHaveLength(1);
  });

  it('subjek berisi HTML dirender sebagai teks', async () => {
    const subject = '<img src=x onerror="window.__balesinXss=9">Tagihan';
    const chat = await openEmail({ subject });
    expect(chat.getByText(subject)).toBeVisible();
    expect(document.querySelector('img[src="x"]')).toBeNull();
  });

  it('verifikasi pengirim gagal = peringatan keras', async () => {
    const chat = await openEmail({ senderVerification: 'fail', authWarning: true });
    expect(chat.getByText(EMAIL_SENDER_VERIFICATION_LABELS.fail)).toBeVisible();
  });

  it('tanpa hasil verifikasi dari server = netral, bukan "terverifikasi"', async () => {
    const chat = await openEmail({ senderVerification: undefined, authWarning: false });
    expect(chat.getByText(EMAIL_SENDER_VERIFICATION_LABELS.unverified)).toBeVisible();
    expect(chat.queryByText(EMAIL_SENDER_VERIFICATION_LABELS.pass)).toBeNull();
  });
});

describe('Nama dari channel tidak tepercaya', () => {
  it('nama profil Telegram yang meniru tim tetap diberi label + handle asli', () => {
    const identity = summaryIdentity({
      id: 'd0000000-0000-4000-8000-0000000000d1',
      number: 31,
      displayName: 'Admin Resmi Maju Jaya',
      nameSource: 'channel',
      phone: null,
      waUsername: null,
      channelHandle: '@penipu_123',
    });
    expect(identity.name).toBe('Admin Resmi Maju Jaya');
    expect(identity.handle).toBe('@penipu_123');
    expect(untrustedNameLabel(identity, 'telegram')).toBe(t.inbox.item.fromChannel('Telegram'));
  });
});

// ── Pola kode di seluruh apps/web ─────────────────────────────────────────────────────────────
const SRC = join(import.meta.dirname, '..');

function sourceFiles(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return path.endsWith('.tsx') && !path.includes('.test.') ? [path] : [];
  });
}

const stripComments = (source: string) => {
  const blank = (text: string) => text.replace(/[^\n]/g, ' ');
  return source.replace(/\/\*[\s\S]*?\*\//g, blank).replace(/\/\/[^\n]*/g, blank);
};

describe('pola di seluruh apps/web', () => {
  it('komponen yang merender <form> (mis. IdentityDialog) tidak ditaruh di dalam <form> lain', () => {
    const files = sourceFiles(SRC);
    const formComponents = new Set<string>();
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      if (!/<form\b/.test(source)) continue;
      for (const match of source.matchAll(/export function (\w+)/g)) formComponents.add(match[1]!);
    }
    expect(formComponents.has('IdentityDialog')).toBe(true);
    const nested: string[] = [];
    for (const file of files) {
      const source = stripComments(readFileSync(file, 'utf8'));
      let depth = 0;
      for (const token of source.matchAll(/<form\b|<\/form>|<([A-Z]\w*)\b/g)) {
        if (token[0] === '<form') depth++;
        else if (token[0] === '</form>') depth = Math.max(0, depth - 1);
        else if (depth > 0 && token[1] && formComponents.has(token[1])) {
          const line = source.slice(0, token.index).split('\n').length;
          nested.push(`${file.slice(SRC.length)}:${String(line)} <${token[1]}>`);
        }
      }
    }
    expect(nested).toEqual([]);
  });

  it('HTML dari luar tidak pernah lewat dangerouslySetInnerHTML; iframe srcDoc selalu sandbox', () => {
    for (const file of sourceFiles(SRC)) {
      const source = stripComments(readFileSync(file, 'utf8'));
      expect(source, file).not.toMatch(/dangerouslySetInnerHTML/);
      for (const frame of source.matchAll(/<iframe\b[\s\S]*?\/>/g)) {
        if (/srcDoc=/.test(frame[0])) expect(frame[0], file).toMatch(/\bsandbox=/);
        expect(frame[0], file).not.toMatch(/allow-scripts|allow-same-origin/);
      }
    }
  });

  it('zod jitless dipasang paling awal di main.tsx (CSP tanpa unsafe-eval)', () => {
    const main = readFileSync(join(SRC, 'main.tsx'), 'utf8');
    const firstImport = /^import\s+(?:[^'"]+from\s+)?['"]([^'"]+)['"]/m.exec(main)?.[1];
    expect(firstImport).toBe('./zod-config');
  });
});
