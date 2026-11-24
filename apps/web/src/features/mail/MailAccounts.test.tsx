import {
  API_ROUTES,
  MAIL_VERIFICATION_UNAVAILABLE_MESSAGES,
  apiPath,
  type CreateMailAccountInput,
  type MailIdentity,
} from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import {
  COMPOSE_IDS,
  MAIL_IDS,
  fakeMailAccount,
  fakeMailIdentity,
  fakeRedactedAccount,
  fakeTestResult,
} from '../../test/fake-mail';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { expectSecretNowhere, secretSpies } from '../../test/secret-nowhere';

const m = t.mail;
const c = t.mail.accounts;
const w = t.mail.wizard;
const i = t.mail.identities;
const SECRET = 'Sandi-Rahasia-Akun-Email-77';

const cs = fakeMailAccount();
const billing = fakeMailAccount({
  id: MAIL_IDS.billing,
  displayName: 'Billing',
  emailAddress: 'billing@majujaya.co.id',
  color: 'tagTeal',
  sync: {
    ...cs.sync,
    state: 'auth_failed',
    lastErrorCode: 'imap_auth_failed',
    lastErrorMessage: 'Password akun email billing@majujaya.co.id ditolak.',
  },
});

const DEPARTMENT = {
  id: '5d0e0000-0000-4000-8000-000000000001',
  name: 'Layanan Pelanggan',
  description: null,
  memberCount: 5,
};

function settingsList(
  accounts: unknown[],
  flags = { canConnectPersonal: true, canManageShared: true },
): FakeHandler {
  return () => json({ accounts, ...flags });
}

function dialog() {
  return within(screen.getByRole('dialog', { name: w.title }));
}

async function openWizard() {
  fireEvent.click(await screen.findByRole('button', { name: c.connect }));
  return within(await screen.findByRole('dialog', { name: w.title }));
}

describe('Pengaturan → Akun email', () => {
  it('daftar akun: status sinkron, galat, akun pribadi orang lain (metadata), pengaturan email', async () => {
    await renderApp('/pengaturan/akun-email', {
      routes: {
        [`GET ${API_ROUTES.mail.settingsAccounts}`]: settingsList([
          cs,
          billing,
          fakeRedactedAccount(),
        ]),
      },
    });

    expect(await screen.findByRole('heading', { level: 1, name: c.title })).toBeVisible();
    expect(screen.getByRole('link', { name: 'CS Maju Jaya' })).toHaveAttribute(
      'href',
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
    );
    expect(screen.getAllByText(m.syncStates.ready ?? '').length).toBeGreaterThan(0);
    expect(screen.getByText(m.syncStates.auth_failed ?? '')).toBeVisible();
    // Daftar hanya lencana + tautan (pesan lengkap di halaman akun, review 9A P5); tautan membuka
    // dialog Ubah server lewat `?ubah=server` (P4).
    expect(screen.queryByText('Password akun email billing@majujaya.co.id ditolak.')).toBeNull();
    expect(screen.getByRole('link', { name: c.fixPassword })).toHaveAttribute(
      'href',
      `/pengaturan/akun-email/${MAIL_IDS.billing}?ubah=server`,
    );
    // Akun pribadi orang lain: hanya metadata, tanpa tautan ke isinya.
    expect(screen.getByText(c.personalOf('Dimas Saputra'))).toBeVisible();
    expect(screen.queryByRole('link', { name: 'Kantor Dimas' })).toBeNull();
    expect(screen.getByText(c.redactedNote)).toBeVisible();
    // Owner: pengaturan retensi & jendela sinkron.
    expect(await screen.findByRole('heading', { name: m.settings.title })).toBeVisible();
    expect(screen.getByLabelText(m.settings.retention)).toHaveValue('90');
  });

  it('kosong: ajakan menghubungkan akun; CS hanya akun pribadi, tanpa pengaturan organisasi', async () => {
    await renderApp('/pengaturan/akun-email', { session: fakeSession('cs') });
    expect(await screen.findByRole('heading', { name: c.emptyTitle })).toBeVisible();
    expect(screen.getByText(c.emptyBodyPersonal)).toBeVisible();
    expect(screen.queryByRole('heading', { name: m.settings.title })).toBeNull();
  });

  it('Sinkron sekarang & Jeda dari menu akun', async () => {
    const paused = fakeMailAccount({ sync: { ...cs.sync, state: 'paused' } });
    const { api } = await renderApp('/pengaturan/akun-email', {
      routes: {
        [`GET ${API_ROUTES.mail.settingsAccounts}`]: settingsList([cs]),
        [`POST ${apiPath(API_ROUTES.mail.accountSync, { accountId: MAIL_IDS.cs })}`]: () =>
          json({ queued: true }, { status: 202 }),
        [`POST ${apiPath(API_ROUTES.mail.accountPause, { accountId: MAIL_IDS.cs })}`]: () =>
          json({ account: paused }),
      },
    });
    const trigger = await screen.findByRole('button', { name: c.actionsFor('CS Maju Jaya') });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: c.syncNow }),
    );
    expect(await screen.findByText(c.done.syncQueued('CS Maju Jaya'))).toBeVisible();

    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: c.pause }),
    );
    expect(await screen.findByText(c.done.paused('CS Maju Jaya'))).toBeVisible();
    expect(screen.getByText(m.syncStates.paused ?? '')).toBeVisible();
    expect(api.requests.filter((request) => request.method === 'POST')).toHaveLength(2);
  });

  it('Putuskan: konfirmasi identitas (bahaya) → DELETE + pesan', async () => {
    let deleted = false;
    const { api } = await renderApp('/pengaturan/akun-email', {
      routes: {
        [`GET ${API_ROUTES.mail.settingsAccounts}`]: () =>
          json({
            accounts: deleted ? [] : [cs],
            canConnectPersonal: true,
            canManageShared: true,
          }),
        [`DELETE ${apiPath(API_ROUTES.mail.account, { accountId: MAIL_IDS.cs })}`]: () => {
          deleted = true;
          return json({ deleting: true }, { status: 202 });
        },
      },
    });
    const trigger = await screen.findByRole('button', { name: c.actionsFor('CS Maju Jaya') });
    fireEvent.keyDown(trigger, { key: 'Enter' });
    fireEvent.click(
      within(await screen.findByRole('menu')).getByRole('menuitem', { name: c.disconnect }),
    );
    await confirmIdentity(c.disconnectTitle('CS Maju Jaya'), c.disconnectConfirm);
    expect(await screen.findByText(c.done.disconnected('CS Maju Jaya'))).toBeVisible();
    const request = api.requests.find((item) => item.method === 'DELETE');
    expect(request?.body).toEqual({ confirmation: { password: TEST_PASSWORD, code: TEST_CODE } });
  });
});

describe('wizard Hubungkan akun email', () => {
  function wizardRoutes(overrides: Record<string, FakeHandler> = {}) {
    let testCalls = 0;
    return {
      routes: {
        [`GET ${API_ROUTES.mail.settingsAccounts}`]: settingsList([cs]),
        [`POST ${API_ROUTES.mail.detect}`]: () =>
          json({
            domain: 'majujaya.co.id',
            suggestions: [
              {
                source: 'mx',
                provider: 'cpanel',
                imap: { host: 'mail.majujaya.co.id', port: 993, security: 'ssl' },
                smtp: { host: 'mail.majujaya.co.id', port: 465, security: 'ssl' },
                username: 'address',
                description: 'Server email hosting cPanel terdeteksi dari MX domain ini.',
              },
            ],
          }),
        // Tes pertama: SMTP ditolak; berikutnya lolos.
        [`POST ${API_ROUTES.mail.test}`]: () => json(fakeTestResult((testCalls += 1) > 1)),
        [`GET ${API_ROUTES.departments.list}`]: () => json({ departments: [DEPARTMENT] }),
        ...overrides,
      },
    };
  }

  async function toTestStep() {
    const wizard = await openWizard();
    fireEvent.change(wizard.getByLabelText(w.emailLabel), {
      target: { value: 'billing@majujaya.co.id' },
    });
    fireEvent.click(wizard.getByRole('button', { name: w.next }));
    // Langkah 2: server terisi dari deteksi.
    expect(await wizard.findByText(w.detectedTitle('majujaya.co.id'))).toBeVisible();
    expect(wizard.getAllByLabelText(w.host)[0]).toHaveValue('mail.majujaya.co.id');
    expect(wizard.getByLabelText(w.displayName)).toHaveValue('Billing');
    expect(wizard.getByLabelText(w.username)).toHaveValue('billing@majujaya.co.id');
    return wizard;
  }

  it('akun bersama: deteksi → tes gagal (SMTP) → tes ulang lolos → akses → konfirmasi identitas', async () => {
    const created = fakeMailAccount({
      id: MAIL_IDS.billing,
      displayName: 'Billing',
      emailAddress: 'billing@majujaya.co.id',
      sync: { ...cs.sync, state: 'initial_sync' },
    });
    const spies = secretSpies();
    // Alamat utama akun baru: belum diverifikasi → wizard memulai verifikasi sendiri (9B §3.4).
    let primary: MailIdentity = fakeMailIdentity({
      id: COMPOSE_IDS.identityBilling,
      accountId: MAIL_IDS.billing,
      address: 'billing@majujaya.co.id',
      displayName: 'Billing',
      verification: {
        state: 'unverified',
        verifiedAt: null,
        method: null,
        pending: null,
        available: true,
        unavailableReason: null,
      },
    });
    const pendingVerification = {
      ...primary.verification,
      state: 'pending' as const,
      pending: {
        sentAt: new Date().toISOString(),
        expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
        attemptsLeft: 5,
        autoCheckUntil: null,
      },
    };
    const verificationPath = apiPath(API_ROUTES.mail.identityVerification, {
      identityId: primary.id,
    });
    const confirmPath = apiPath(API_ROUTES.mail.identityVerificationConfirm, {
      identityId: primary.id,
    });
    const view = await renderApp(
      '/pengaturan/akun-email',
      wizardRoutes({
        [`POST ${API_ROUTES.mail.accounts}`]: () => json({ account: created }, { status: 201 }),
        [`GET ${apiPath(API_ROUTES.mail.accountIdentities, { accountId: MAIL_IDS.billing })}`]:
          () => json({ identities: [primary] }),
        [`POST ${verificationPath}`]: () => {
          primary = { ...primary, verification: pendingVerification };
          return json({ verification: pendingVerification }, { status: 202 });
        },
        [`POST ${confirmPath}`]: () => {
          primary = {
            ...primary,
            verification: {
              ...pendingVerification,
              state: 'verified',
              verifiedAt: new Date().toISOString(),
              method: 'code',
              pending: null,
            },
            canSend: true,
            cannotSendReason: null,
          };
          return json({ identity: primary });
        },
      }),
    );
    const wizard = await toTestStep();

    // Tanpa password: galat di langkah yang sama.
    fireEvent.click(wizard.getByRole('button', { name: w.test }));
    expect(await wizard.findByText(w.passwordRequired)).toBeVisible();

    fireEvent.change(wizard.getByLabelText(w.password), { target: { value: SECRET } });
    fireEvent.click(wizard.getByRole('button', { name: w.test }));
    // Langkah 3: Masuk lolos, Keluar ditolak dengan sebab Indonesia.
    expect(await wizard.findByText(w.outgoingFailed)).toBeVisible();
    expect(wizard.getByText(w.incomingOk)).toBeVisible();
    expect(
      wizard.getByText('Username atau password SMTP ditolak server. Periksa lagi keduanya.'),
    ).toBeVisible();
    const testRequest = view.api.requests.find((item) => item.path === API_ROUTES.mail.test);
    expect(testRequest?.body).toMatchObject({
      emailAddress: 'billing@majujaya.co.id',
      imap: { host: 'mail.majujaya.co.id', port: 993, security: 'ssl', password: SECRET },
      smtp: { sameCredentials: true },
      targets: ['incoming', 'outgoing'],
    });

    fireEvent.click(wizard.getByRole('button', { name: w.retest }));
    expect(await wizard.findByText(w.outgoingOk)).toBeVisible();
    expect(wizard.getByText(w.syncNotice(m.windows['90'] ?? '', 640))).toBeVisible();
    fireEvent.click(wizard.getByRole('button', { name: w.next }));

    // Langkah 4: akun bersama (bawaan Owner), beri akses ke departemen.
    expect(wizard.getByRole('radio', { name: new RegExp(w.sharedTitle) })).toBeChecked();
    fireEvent.click(wizard.getByRole('button', { name: m.access.add }));
    fireEvent.click(
      await wizard.findByRole('button', { name: m.access.addPrincipal('Layanan Pelanggan') }),
    );
    const level = wizard.getByLabelText(m.access.levelFor('Layanan Pelanggan'));
    expect(level).toHaveValue('send');
    fireEvent.change(level, { target: { value: 'read' } });
    fireEvent.click(wizard.getByRole('radio', { name: m.colors.tagTeal }));

    fireEvent.click(wizard.getByRole('button', { name: w.save }));
    await confirmIdentity(w.confirmTitle, w.save);

    // Langkah 5: akun tersimpan, email verifikasi alamat utama langsung dikirim (sekali).
    expect(await dialog().findByText(w.createdTitle('Billing'))).toBeVisible();
    expect(
      await dialog().findByRole('heading', { name: w.verifyTitle('billing@majujaya.co.id') }),
    ).toBeVisible();
    const code = await dialog().findByLabelText(i.codeLabel('billing@majujaya.co.id'));
    expect(
      view.api.requests.filter((item) => item.method === 'POST' && item.path === verificationPath),
    ).toHaveLength(1);
    // Tidak bisa kembali ke langkah sebelumnya (akun sudah ada).
    expect(dialog().queryByRole('button', { name: w.back })).toBeNull();
    fireEvent.change(code, { target: { value: '482913' } });
    fireEvent.click(dialog().getByRole('button', { name: i.confirmCode }));
    expect(await dialog().findByText(w.verifiedTitle)).toBeVisible();
    expect(
      view.api.requests.find((item) => item.method === 'POST' && item.path === confirmPath)?.body,
    ).toEqual({ code: '482913' });

    fireEvent.click(dialog().getByRole('button', { name: w.finish }));
    expect(await screen.findByText(c.done.created('Billing'))).toBeVisible();
    await waitFor(() => expect(screen.queryByRole('dialog', { name: w.title })).toBeNull());

    const createRequest = view.api.requests.find(
      (item) => item.method === 'POST' && item.path === API_ROUTES.mail.accounts,
    );
    const body = createRequest?.body as CreateMailAccountInput & { confirmation: unknown };
    expect(body).toMatchObject({
      kind: 'shared',
      provider: 'cpanel',
      displayName: 'Billing',
      emailAddress: 'billing@majujaya.co.id',
      color: 'tagTeal',
      syncWindowDays: 90,
      imap: { password: SECRET },
      access: [{ principalType: 'department', departmentId: DEPARTMENT.id, level: 'read' }],
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    // Password akun hanya ada di permintaan: tidak di cache, storage, DOM, atau isian.
    expectSecretNowhere(view, SECRET, spies);
  });

  it('server menolak saat menyimpan (502): kembali ke langkah Tes koneksi dengan sebabnya', async () => {
    await renderApp(
      '/pengaturan/akun-email',
      wizardRoutes({
        [`POST ${API_ROUTES.mail.test}`]: () => json(fakeTestResult(true)),
        [`POST ${API_ROUTES.mail.accounts}`]: () =>
          json(
            {
              error: {
                code: 'CHANNEL_REQUEST_FAILED',
                message: 'Tes koneksi gagal.',
                details: [
                  {
                    field: 'imap',
                    reason: 'imap_auth_failed',
                    message: 'Username atau password akun email ditolak server.',
                  },
                ],
                requestId: 'req-tes',
              },
            },
            { status: 502 },
          ),
      }),
    );
    const wizard = await toTestStep();
    fireEvent.change(wizard.getByLabelText(w.password), { target: { value: SECRET } });
    fireEvent.click(wizard.getByRole('button', { name: w.test }));
    fireEvent.click(await wizard.findByRole('button', { name: w.next }));
    fireEvent.click(wizard.getByRole('button', { name: w.save }));
    await confirmIdentity(w.confirmTitle, w.save);

    expect(await dialog().findByText(w.incomingFailed)).toBeVisible();
    expect(dialog().getByText('Username atau password akun email ditolak server.')).toBeVisible();
    expect(dialog().getByRole('button', { name: w.retest })).toBeVisible();
  });

  it('alamat sudah jadi Channel Email Inbox (409): kembali ke langkah 1 dengan pesannya', async () => {
    const message =
      'Alamat ini sudah dipakai sebagai Channel Email di Inbox. Satu alamat hanya bisa dipakai di Inbox atau di menu Email.';
    await renderApp(
      '/pengaturan/akun-email',
      wizardRoutes({
        [`POST ${API_ROUTES.mail.test}`]: () => json(fakeTestResult(true)),
        [`POST ${API_ROUTES.mail.accounts}`]: () =>
          json(
            {
              error: {
                code: 'CONFLICT',
                message,
                details: [{ field: 'emailAddress', reason: 'address_is_inbox_channel', message }],
                requestId: 'req-tes',
              },
            },
            { status: 409 },
          ),
      }),
    );
    const wizard = await toTestStep();
    fireEvent.change(wizard.getByLabelText(w.password), { target: { value: SECRET } });
    fireEvent.click(wizard.getByRole('button', { name: w.test }));
    fireEvent.click(await wizard.findByRole('button', { name: w.next }));
    fireEvent.click(wizard.getByRole('button', { name: w.save }));
    await confirmIdentity(w.confirmTitle, w.save);

    expect(await dialog().findByText(message)).toBeVisible();
    expect(dialog().getByLabelText(w.emailLabel)).toHaveAttribute('aria-invalid', 'true');
  });

  it('CS: akun pribadi tanpa konfirmasi identitas; penyedia "Segera hadir" tidak bisa dipilih', async () => {
    const created = fakeMailAccount({
      id: MAIL_IDS.personal,
      kind: 'personal',
      displayName: 'Rina',
      emailAddress: 'rina@majujaya.co.id',
    });
    const personalIdentity = fakeMailIdentity({
      id: COMPOSE_IDS.identityBilling,
      accountId: MAIL_IDS.personal,
      address: 'rina@majujaya.co.id',
      displayName: 'Rina',
      approval: { state: 'pending', decidedAt: null },
      verification: {
        state: 'unverified',
        verifiedAt: null,
        method: null,
        pending: null,
        available: false,
        unavailableReason: 'approval_pending',
      },
    });
    const view = await renderApp('/pengaturan/akun-email?tambah=imap', {
      session: fakeSession('cs'),
      routes: {
        [`GET ${apiPath(API_ROUTES.mail.accountIdentities, { accountId: MAIL_IDS.personal })}`]:
          () => json({ identities: [personalIdentity] }),
        [`GET ${API_ROUTES.mail.settingsAccounts}`]: settingsList([], {
          canConnectPersonal: true,
          canManageShared: false,
        }),
        [`POST ${API_ROUTES.mail.detect}`]: () =>
          json({ domain: 'majujaya.co.id', suggestions: [] }),
        [`POST ${API_ROUTES.mail.test}`]: () => json(fakeTestResult(true)),
        [`POST ${API_ROUTES.mail.accounts}`]: () => json({ account: created }, { status: 201 }),
      },
    });
    const wizard = within(await screen.findByRole('dialog', { name: w.title }));
    expect(wizard.getByRole('radio', { name: /IMAP lain/ })).toBeChecked();
    expect(wizard.getByRole('radio', { name: /Microsoft 365/ })).toBeDisabled();

    fireEvent.change(wizard.getByLabelText(w.emailLabel), {
      target: { value: 'rina@majujaya.co.id' },
    });
    fireEvent.click(wizard.getByRole('button', { name: w.next }));
    expect(await wizard.findByText(w.notDetectedTitle)).toBeVisible();
    // IMAP lain tanpa saran: host diisi sendiri.
    const [imapHost, smtpHost] = wizard.getAllByLabelText(w.host);
    if (!imapHost || !smtpHost) throw new Error('isian host tidak ada');
    fireEvent.change(imapHost, { target: { value: 'imap.majujaya.co.id' } });
    fireEvent.change(smtpHost, { target: { value: 'smtp.majujaya.co.id' } });
    fireEvent.change(wizard.getByLabelText(w.password), { target: { value: SECRET } });
    fireEvent.click(wizard.getByRole('button', { name: w.test }));
    fireEvent.click(await wizard.findByRole('button', { name: w.next }));

    expect(wizard.getByRole('radio', { name: new RegExp(w.sharedTitle) })).toBeDisabled();
    expect(wizard.getByRole('radio', { name: new RegExp(w.personalTitle) })).toBeChecked();
    fireEvent.click(wizard.getByRole('button', { name: w.save }));

    // Domain organisasi di akun pribadi: verifikasi menunggu persetujuan, tidak dimulai otomatis.
    expect(
      await wizard.findByText(MAIL_VERIFICATION_UNAVAILABLE_MESSAGES.approval_pending),
    ).toBeVisible();
    expect(
      view.api.requests.some(
        (item) => item.method === 'POST' && item.path.endsWith('/verification'),
      ),
    ).toBe(false);
    // Escape / tutup setelah akun tersimpan = selesai (daftar dimuat ulang, bukan dibatalkan).
    fireEvent.click(wizard.getByRole('button', { name: w.close }));
    expect(await screen.findByText(c.done.created('Rina'))).toBeVisible();
    expect(screen.queryByRole('dialog', { name: w.confirmTitle })).toBeNull();
    const body = view.api.requests.find(
      (item) => item.method === 'POST' && item.path === API_ROUTES.mail.accounts,
    )?.body as Record<string, unknown>;
    expect(body).toMatchObject({ kind: 'personal', provider: 'imap', access: [] });
    expect(body).not.toHaveProperty('confirmation');
  });

  it('Gmail: saran server + keterangan sandi aplikasi, dihubungkan sebagai IMAP lain', async () => {
    const description =
      'Alamat ini memakai Google. Pakai sandi aplikasi (bukan password biasa) dan aktifkan IMAP; "Masuk dengan Google" segera hadir.';
    await renderApp(
      '/pengaturan/akun-email',
      wizardRoutes({
        [`POST ${API_ROUTES.mail.detect}`]: () =>
          json({
            domain: 'gmail.com',
            suggestions: [
              {
                source: 'known_provider',
                provider: 'google',
                imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' },
                smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' },
                username: 'address',
                description,
              },
            ],
          }),
      }),
    );
    const wizard = await openWizard();
    fireEvent.change(wizard.getByLabelText(w.emailLabel), {
      target: { value: 'tokomajujaya@gmail.com' },
    });
    fireEvent.blur(wizard.getByLabelText(w.emailLabel));
    // Kartu "IMAP lain" ditandai cocok (Gmail sendiri masih "Segera hadir").
    expect(await wizard.findByText('@gmail.com')).toBeVisible();
    expect(wizard.getByRole('radio', { name: /IMAP lain/ })).toBeChecked();
    fireEvent.click(wizard.getByRole('button', { name: w.next }));

    expect(await wizard.findByText(w.detectedTitle('gmail.com'))).toBeVisible();
    expect(wizard.queryByText(w.notDetectedTitle)).toBeNull();
    expect(wizard.getByText(description)).toBeVisible();
    expect(wizard.getByText(w.appPasswordNote)).toBeVisible();
    const [imapHost, smtpHost] = wizard.getAllByLabelText(w.host);
    expect(imapHost).toHaveValue('imap.gmail.com');
    expect(smtpHost).toHaveValue('smtp.gmail.com');
    expect(wizard.getByLabelText(w.username)).toHaveValue('tokomajujaya@gmail.com');
    expect(wizard.getAllByText(w.appPasswordHint).length).toBeGreaterThan(0);
  });

  it('jatah deteksi habis (429): tetap bisa lanjut dan mengisi server sendiri', async () => {
    await renderApp(
      '/pengaturan/akun-email',
      wizardRoutes({
        [`POST ${API_ROUTES.mail.detect}`]: () =>
          apiError(429, 'RATE_LIMITED', 'Terlalu sering. Coba lagi sebentar lagi.', {
            retryAfter: 60,
          }),
      }),
    );
    const wizard = await openWizard();
    fireEvent.change(wizard.getByLabelText(w.emailLabel), {
      target: { value: 'cs@majujaya.co.id' },
    });
    fireEvent.click(wizard.getByRole('radio', { name: /cPanel/ }));
    fireEvent.click(wizard.getByRole('button', { name: w.next }));
    expect(await wizard.findByText(w.detectFailed)).toBeVisible();
    // Preset cPanel tetap mengisi host.
    expect(wizard.getAllByLabelText(w.host)[0]).toHaveValue('mail.majujaya.co.id');
  });
});
