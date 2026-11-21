import { randomInt } from 'node:crypto';
import { request, type APIRequestContext, type Browser, type Page } from '@playwright/test';
import { deliverWhatsAppWebhook } from '../../apps/api/src/testing/fake-meta-webhooks';
import { FAKE_META } from '../stack/fake-meta-data';
import { E2E_OWNER } from '../stack/env';
import { BASE_URL } from '../viewports';
import { expect, submitLogin } from './fixtures';
import { openWatchedPage } from './konteks';
import { e2eSql, type ExtraUser } from './pengguna';
import { totpAtStep, totpStep } from './two-factor';

/** Alat bersama tes inbox (`inbox-pesan`, `inbox-balas`): channel tes, webhook bertanda tangan. */

export interface OwnerApi {
  api: APIRequestContext;
  csrf: string;
  /** Konfirmasi identitas berikutnya (password + kode cadangan yang belum dipakai). */
  confirm: () => { password: string; code: string };
}

export interface Setup {
  appSecret: string;
  callbackUrl: string;
  phoneNumberId: string;
  channelName: string;
}

/**
 * Owner KEDUA khusus tes ini (pola `channel.spec`): konfirmasi identitas memakai kode cadangannya
 * sendiri, jadi tidak antre kode TOTP Owner utama yang dipakai bergantian oleh tes lain.
 * Mengembalikan konteks API yang sudah bersesi penuh.
 */
export async function ownerApi(): Promise<OwnerApi> {
  const email = `owner-inbox-${Date.now().toString(36)}-${randomInt(1000, 9999)}@majujaya.test`;
  const rows = await e2eSql(
    `insert into users (id, organization_id, email, name, password_hash, role, email_verified_at)
     select gen_random_uuid(), organization_id, $1, 'Dewi Inbox', password_hash, 'owner'::user_role, now()
     from users where email = $2
     returning id`,
    [email, E2E_OWNER.email],
  );
  if (rows.length !== 1) throw new Error('Owner E2E belum ada (alur-awal belum jalan?)');
  const password = E2E_OWNER.password;
  const api = await request.newContext({
    baseURL: BASE_URL,
    extraHTTPHeaders: { origin: BASE_URL },
    storageState: { cookies: [], origins: [] },
  });
  const login = (await (
    await api.post('/api/v1/auth/login', { data: { email, password } })
  ).json()) as { status: string; csrfToken: string };
  if (login.status !== 'two_factor_enrollment_required') {
    throw new Error(`Login Owner kedua: ${login.status}`);
  }
  const headers = { 'x-csrf-token': login.csrfToken };
  const enroll = await api.post('/api/v1/auth/2fa/enroll', { headers, data: {} });
  const { secret } = (await enroll.json()) as { secret: string };
  const confirm = await api.post('/api/v1/auth/2fa/enroll/confirm', {
    headers,
    data: { code: totpAtStep(secret, totpStep()) },
  });
  if (!confirm.ok())
    throw new Error(`Konfirmasi 2FA (${confirm.status()}): ${await confirm.text()}`);
  const { backupCodes } = (await confirm.json()) as { backupCodes: { codes: string[] } };
  const me = (await (await api.get('/api/v1/auth/me')).json()) as {
    status: string;
    csrfToken: string;
  };
  if (me.status !== 'authenticated') throw new Error(`Sesi Owner kedua: ${me.status}`);
  const codes = [...backupCodes.codes];
  return {
    api,
    csrf: me.csrfToken,
    confirm: () => ({ password, code: codes.shift() ?? '' }),
  };
}

/** Channel WhatsApp baru lewat API (konfirmasi identitas Owner kedua), dengan App Secret tes. */
export async function createChannel(label: string, phoneNumberId: string): Promise<Setup> {
  const channelName = `Inbox E2E ${label}`;
  const { api, csrf, confirm } = await ownerApi();
  try {
    const response = await api.post('/api/v1/settings/channels', {
      headers: { 'x-csrf-token': csrf },
      data: {
        type: 'whatsapp',
        name: channelName,
        phoneNumberId,
        wabaId: FAKE_META.wabaId,
        accessToken: FAKE_META.token,
        appSecret: FAKE_META.appSecret,
        confirmation: confirm(),
      },
    });
    if (!response.ok()) {
      throw new Error(`Buat channel (${response.status()}): ${await response.text()}`);
    }
    const body = (await response.json()) as { webhook: { callbackUrl: string } };
    return {
      appSecret: FAKE_META.appSecret,
      callbackUrl: body.webhook.callbackUrl,
      phoneNumberId,
      channelName,
    };
  } finally {
    await api.dispose();
  }
}

export function randomCustomer(name: string) {
  return { waId: `62812${randomInt(1_000_000, 9_999_999)}`, userId: null, name };
}

export async function deliver(setup: Setup, notification: unknown): Promise<void> {
  const response = await deliverWhatsAppWebhook(setup.callbackUrl, notification, setup.appSecret);
  expect(response.status, 'webhook diterima').toBe(200);
}

/** Nomor E.164 Indonesia seperti tampil di UI: +62 812-3456-7890. */
export function shownPhone(waId: string): string {
  const local = waId.slice(2);
  return `+62 ${local.slice(0, 3)}-${local.slice(3, 7)}-${local.slice(7)}`;
}

export async function conversationIdOf(waId: string): Promise<string> {
  const rows = await e2eSql<{ id: string }>(
    `select c.id from conversations c join contacts k on k.id = c.contact_id
     where k.phone = $1 order by c.created_at desc limit 1`,
    [`+${waId}`],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error('Percakapan belum dibuat worker');
  return id;
}

export function conversationRow(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Daftar chat' })
    .getByRole('button', { name: new RegExp(name) });
}

export async function signIn(browser: Browser, user: ExtraUser, hp: boolean) {
  const watched = await openWatchedPage(browser, { hp });
  watched.allow('/api/v1/auth/me', 401);
  await watched.page.goto('/masuk');
  await submitLogin(watched.page, user.email, user.password);
  await expect(watched.page).toHaveURL(/\/inbox/);
  return watched;
}
