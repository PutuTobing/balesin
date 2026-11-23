import { API_ROUTES, apiPath, type MailIdentity } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { json, type FakeHandler, type FakeRequest } from '../../test/fake-api';
import {
  COMPOSE_IDS,
  MAIL_IDS,
  fakeMailAccount,
  fakeMailIdentity,
  fakeSignature,
} from '../../test/fake-mail';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { renderApp } from '../../test/render-app';

const i = t.mail.identities;
const sg = t.mail.signatures;
const pf = t.mail.preferences;

const account = fakeMailAccount();
const accountPath = apiPath(API_ROUTES.mail.account, { accountId: MAIL_IDS.cs });
const identitiesPath = apiPath(API_ROUTES.mail.accountIdentities, { accountId: MAIL_IDS.cs });
const signaturesPath = apiPath(API_ROUTES.mail.accountSignatures, { accountId: MAIL_IDS.cs });

const pendingAlias = fakeMailIdentity({
  id: COMPOSE_IDS.identityTagihan,
  address: 'tagihan@majujaya.co.id',
  displayName: 'Tim Tagihan',
  isPrimary: false,
  verification: {
    state: 'pending',
    verifiedAt: null,
    method: null,
    pending: {
      sentAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 30 * 60_000).toISOString(),
      attemptsLeft: 5,
      autoCheckUntil: null,
    },
    available: true,
    unavailableReason: null,
  },
  canSend: false,
  cannotSendReason: 'identity_unverified',
});

function routes(identities: MailIdentity[], extra: Record<string, FakeHandler> = {}) {
  return {
    routes: {
      [`GET ${accountPath}`]: () => json({ account }),
      [`GET ${apiPath(API_ROUTES.mail.accountAccess, { accountId: MAIL_IDS.cs })}`]: () =>
        json({ implicit: [], grants: [], editable: true }),
      [`GET ${identitiesPath}`]: () => json({ identities }),
      [`GET ${signaturesPath}`]: () => json({ shared: [fakeSignature()], mine: [] }),
      ...extra,
    },
  };
}

function find(api: { requests: FakeRequest[] }, method: string, path: string) {
  return api.requests.filter((request) => request.method === method && request.path === path);
}

describe('Pengaturan → Akun email → Alamat pengirim', () => {
  it('menampilkan status (tidak biner) dan memverifikasi alias lewat kode 6 angka', async () => {
    const confirmPath = apiPath(API_ROUTES.mail.identityVerificationConfirm, {
      identityId: pendingAlias.id,
    });
    const { api } = await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes([fakeMailIdentity(), pendingAlias], {
        [`POST ${confirmPath}`]: () =>
          json({
            identity: {
              ...pendingAlias,
              verification: { ...pendingAlias.verification, state: 'verified' },
            },
          }),
      }),
    );
    const card = await screen.findByRole('region', { name: i.title });
    expect(await within(card).findByText('cs@majujaya.co.id')).toBeVisible();
    expect(within(card).getByText(i.states.verified ?? '')).toBeVisible();
    expect(within(card).getByText(i.states.pending ?? '')).toBeVisible();
    expect(within(card).getByText(i.verifiedBy.mailbox ?? '')).toBeVisible();

    const code = within(card).getByLabelText(i.codeLabel('tagihan@majujaya.co.id'));
    fireEvent.change(code, { target: { value: '48 29 13' } });
    fireEvent.click(within(card).getByRole('button', { name: i.confirmCode }));
    await waitFor(() => expect(find(api, 'POST', confirmPath)).toHaveLength(1));
    expect(find(api, 'POST', confirmPath)[0]?.body).toEqual({ code: '482913' });
    expect(await within(card).findByText(i.verifiedNow('tagihan@majujaya.co.id'))).toBeVisible();
  });

  it('alias akun bersama wajib konfirmasi identitas (dialog di luar form)', async () => {
    const { api } = await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes([fakeMailIdentity()], {
        [`POST ${identitiesPath}`]: () => json({ identity: pendingAlias }, { status: 201 }),
      }),
    );
    const card = await screen.findByRole('region', { name: i.title });
    fireEvent.click(await within(card).findByRole('button', { name: i.add }));
    const dialog = await screen.findByRole('dialog', { name: i.addTitle });
    fireEvent.change(within(dialog).getByLabelText(i.addressLabel), {
      target: { value: 'tagihan@majujaya.co.id' },
    });
    fireEvent.change(within(dialog).getByLabelText(i.displayNameLabel), {
      target: { value: 'Tim Tagihan' },
    });
    fireEvent.click(within(dialog).getByRole('button', { name: i.add }));
    expect(find(api, 'POST', identitiesPath)).toHaveLength(0);
    await confirmIdentity(i.confirmTitle, i.add);
    await waitFor(() => expect(find(api, 'POST', identitiesPath)).toHaveLength(1));
    expect(find(api, 'POST', identitiesPath)[0]?.body).toEqual({
      address: 'tagihan@majujaya.co.id',
      displayName: 'Tim Tagihan',
      replyTo: null,
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
    expect(await within(card).findByText(i.added('tagihan@majujaya.co.id'))).toBeVisible();
  });

  it('alamat sistem pengirim yang bentrok & menunggu persetujuan tampil jelas', async () => {
    const approvalPending = fakeMailIdentity({
      approval: { state: 'pending', decidedAt: null },
      verification: {
        state: 'unverified',
        verifiedAt: null,
        method: null,
        pending: null,
        available: false,
        unavailableReason: 'approval_pending',
      },
      canSend: false,
      cannotSendReason: 'identity_not_approved',
    });
    await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes([approvalPending], {
        [`GET ${accountPath}`]: () =>
          json({ account: { ...account, warnings: ['system_sender_conflict'] } }),
      }),
    );
    const card = await screen.findByRole('region', { name: i.title });
    expect(await within(card).findByText(i.systemSenderConflictTitle)).toBeVisible();
    expect(await within(card).findByText(i.approvalStates.pending ?? '')).toBeVisible();
  });
});

describe('Pengaturan → Akun email → Tanda tangan & preferensi', () => {
  it('membuat tanda tangan pribadi lewat editor yang sama dengan jendela tulis', async () => {
    const { api } = await renderApp(
      `/pengaturan/akun-email/${MAIL_IDS.cs}`,
      routes([fakeMailIdentity()], {
        [`POST ${signaturesPath}`]: () =>
          json(
            { signature: fakeSignature({ scope: 'personal', name: 'Singkat' }) },
            { status: 201 },
          ),
      }),
    );
    const card = await screen.findByRole('region', { name: sg.title });
    expect(await within(card).findByText('Formal', { selector: 'p' })).toBeVisible();
    fireEvent.click(within(card).getByRole('button', { name: sg.createMine }));
    const dialog = await screen.findByRole('dialog', { name: sg.createTitle });
    fireEvent.change(within(dialog).getByLabelText(sg.nameLabel), { target: { value: 'Singkat' } });
    fireEvent.click(within(dialog).getByRole('button', { name: sg.save }));
    await waitFor(() => expect(find(api, 'POST', signaturesPath)).toHaveLength(1));
    expect(find(api, 'POST', signaturesPath)[0]?.body).toMatchObject({
      scope: 'personal',
      name: 'Singkat',
    });
    expect(await within(card).findByText(sg.saved('Singkat'))).toBeVisible();
  });

  it('preferensi menulis: lama batalkan kirim tersimpan', async () => {
    const { api } = await renderApp('/pengaturan/akun-email', {
      routes: {
        [`GET ${API_ROUTES.mail.settingsAccounts}`]: () =>
          json({ accounts: [account], canConnectPersonal: true, canManageShared: true }),
        [`PUT ${API_ROUTES.mail.preferences}`]: (request: FakeRequest) =>
          json({ signatureChoices: {}, ...(request.body as object) }),
      },
    });
    const card = await screen.findByRole('region', { name: pf.title });
    fireEvent.change(await within(card).findByLabelText(pf.undoLabel), { target: { value: '20' } });
    fireEvent.click(within(card).getByRole('button', { name: pf.save }));
    await waitFor(() => expect(find(api, 'PUT', API_ROUTES.mail.preferences)).toHaveLength(1));
    expect(find(api, 'PUT', API_ROUTES.mail.preferences)[0]?.body).toEqual({
      undoSendSeconds: 20,
      composeFormat: 'html',
    });
    expect(await within(card).findByText(pf.saved)).toBeVisible();
  });
});
