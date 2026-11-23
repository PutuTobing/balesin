import { API_ROUTES, apiPath, type MailDraft, type MailMessageDetail } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { t } from '../../../i18n/id';
import { media } from '../../../lib/media';
import { json, type FakeHandler, type FakeRequest } from '../../../test/fake-api';
import {
  COMPOSE_IDS,
  MAIL_IDS,
  fakeComposeIdentity,
  fakeDraft,
  fakeMailAccount,
  fakeMailDetail,
  fakeMailSummary,
  fakeOutbox,
  fakeSidebar,
} from '../../../test/fake-mail';
import { FakeSocket } from '../../../test/fake-socket';
import { setMediaQuery } from '../../../test/match-media';
import { renderApp } from '../../../test/render-app';

const c = t.mail.compose;
const rb = t.mail.replyBar;
const SELF_ID = '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001';

const cs = fakeMailAccount();
const csIdentity = fakeComposeIdentity();
const aliasUnverified = fakeComposeIdentity({
  id: COMPOSE_IDS.identityTagihan,
  address: 'tagihan@majujaya.co.id',
  displayName: 'Tim Tagihan',
  isPrimary: false,
  verification: {
    state: 'unverified',
    verifiedAt: null,
    method: null,
    pending: null,
    available: true,
    unavailableReason: null,
  },
  canSend: false,
  cannotSendReason: 'identity_unverified',
});

const draftPath = (id: string = COMPOSE_IDS.draft) =>
  apiPath(API_ROUTES.mail.draft, { draftId: id });
const sendPath = apiPath(API_ROUTES.mail.draftSend, { draftId: COMPOSE_IDS.draft });

interface Setup {
  draft?: MailDraft;
  detail?: MailMessageDetail;
  routes?: Record<string, FakeHandler>;
  messages?: ReturnType<typeof fakeMailSummary>[];
}

function setup({ draft = fakeDraft(), detail, routes = {}, messages = [] }: Setup = {}) {
  let version = draft.version;
  return {
    routes: {
      [`GET ${API_ROUTES.mail.accounts}`]: () =>
        json({ accounts: [cs], canConnectPersonal: true, canManageShared: true }),
      [`GET ${API_ROUTES.mail.sidebar}`]: () => json(fakeSidebar([cs])),
      [`GET ${API_ROUTES.mail.messages}`]: () =>
        json({ messages, nextCursor: null, olderOnServer: false }),
      [`GET ${API_ROUTES.mail.composeIdentities}`]: () =>
        json({ identities: [csIdentity, aliasUnverified] }),
      [`POST ${API_ROUTES.mail.drafts}`]: () =>
        json({ draft, skippedAttachments: [] }, { status: 201 }),
      [`GET ${draftPath(draft.id)}`]: () => json({ draft: { ...draft, version } }),
      [`PUT ${draftPath(draft.id)}`]: () => {
        version += 1;
        return json({
          draft: {
            id: draft.id,
            version,
            updatedAt: new Date().toISOString(),
            serverCopy: { state: 'pending', syncedAt: null },
          },
        });
      },
      [`POST ${apiPath(API_ROUTES.mail.draftCheck, { draftId: draft.id })}`]: () =>
        json({
          checks: {
            totalRecipients: 1,
            maxRecipients: 50,
            bccCount: 0,
            bccWarning: false,
            recipients: [],
            newAddressCount: 0,
            newAddressQuota: { limit: 200, remaining: 200 },
            replyToDiffers: null,
            identity: { verified: true, reason: null },
            attachments: { totalBytes: 0, maxBytes: 20 * 1024 * 1024, notReady: 0 },
            threadNewMessages: { count: 0, latestReceivedAt: null },
          },
        }),
      [`PUT ${apiPath(API_ROUTES.mail.draftPresence, { draftId: draft.id })}`]: () =>
        json({ threadKey: draft.threadKey, users: [] }),
      [`DELETE ${apiPath(API_ROUTES.mail.draftPresence, { draftId: draft.id })}`]: () =>
        json({ threadKey: draft.threadKey, users: [] }),
      [`GET ${API_ROUTES.mail.recipientSuggest}`]: () =>
        json({
          suggestions: [
            {
              address: 'rina@contoh.example',
              name: 'Rina Wulandari',
              source: 'contact',
              contactId: null,
            },
          ],
        }),
      [`POST ${sendPath}`]: () => json({ outbox: fakeOutbox() }, { status: 202 }),
      ...(detail
        ? {
            [`GET ${apiPath(API_ROUTES.mail.message, { messageId: detail.id })}`]: () =>
              json({ message: detail }),
            [`POST ${apiPath(API_ROUTES.mail.messageView, { messageId: detail.id })}`]: () =>
              json({
                url: '/api/v1/mail/view/token-tampilan',
                expiresAt: new Date(Date.now() + 600_000).toISOString(),
                remoteImages: { count: 0, shown: false },
              }),
            [`POST ${API_ROUTES.mail.messageActions}`]: (request: FakeRequest) => {
              const body = request.body as { messageIds: string[] };
              return json({
                results: body.messageIds.map((id) => ({ id, ok: true })),
                applied: body.messageIds.length,
              });
            },
          }
        : {}),
      ...routes,
    },
  };
}

function composeWindow(title: string = c.titles.new) {
  return screen.findByRole('dialog', { name: c.windowLabel(title) });
}

function requests(api: { requests: FakeRequest[] }, method: string, path: string) {
  return api.requests.filter((request) => request.method === method && request.path === path);
}

async function openNew() {
  fireEvent.click(await screen.findByRole('button', { name: c.button }));
  return composeWindow();
}

beforeEach(() => {
  act(() => setMediaQuery(media.desktop, true));
});

describe('jendela tulis — email baru', () => {
  it('membuat draf dari "Dari" bawaan; alamat belum diverifikasi nonaktif; chip + saran; simpan otomatis', async () => {
    const { api } = await renderApp('/email', setup());
    const window = await openNew();
    await waitFor(() => expect(requests(api, 'POST', API_ROUTES.mail.drafts)).toHaveLength(1));
    expect(requests(api, 'POST', API_ROUTES.mail.drafts)[0]?.body).toMatchObject({
      mode: 'new',
      identityId: COMPOSE_IDS.identityCs,
    });

    // "Dari": yang belum diverifikasi tampil tapi tidak bisa dipilih.
    const from = await within(window).findByRole('button', {
      name: c.fromMenuLabel('CS Maju Jaya <cs@majujaya.co.id>'),
    });
    fireEvent.keyDown(from, { key: 'Enter' });
    const alias = await screen.findByRole('menuitem', { name: /Tim Tagihan/ });
    expect(alias).toHaveAttribute('aria-disabled', 'true');
    expect(alias).toHaveTextContent(c.fromUnverified);
    fireEvent.keyDown(alias, { key: 'Escape' });

    // Kepada: saran (kontak) lalu ketikan dengan koma; alamat tidak sah tetap di kolom.
    const to = within(window).getByRole('combobox', { name: c.toLabel });
    fireEvent.change(to, { target: { value: 'ri' } });
    fireEvent.click(await screen.findByRole('option', { name: /Rina Wulandari/ }));
    fireEvent.change(to, { target: { value: 'agus@contoh.example' } });
    fireEvent.keyDown(to, { key: ',' });
    fireEvent.change(to, { target: { value: 'bukan alamat' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    expect(await within(window).findByRole('alert')).toHaveTextContent(c.invalidAddress('bukan'));
    const chips = within(within(window).getByRole('list', { name: c.toLabel })).getAllByRole(
      'listitem',
    );
    expect(chips.map((chip) => chip.textContent)).toEqual([
      expect.stringContaining('Rina Wulandari'),
      expect.stringContaining('agus@contoh.example'),
    ]);

    fireEvent.change(within(window).getByLabelText(c.subject), {
      target: { value: 'Penawaran paket' },
    });
    // Simpan otomatis (debounce 2 dtk) memuat penerima & subjek dengan versi dasar.
    await waitFor(() => expect(requests(api, 'PUT', draftPath())).not.toHaveLength(0), {
      timeout: 6_000,
    });
    const saved = requests(api, 'PUT', draftPath()).at(-1)?.body as Record<string, unknown>;
    expect(saved).toMatchObject({
      baseVersion: 1,
      identityId: COMPOSE_IDS.identityCs,
      subject: 'Penawaran paket',
      to: [
        { address: 'rina@contoh.example', name: 'Rina Wulandari' },
        { address: 'agus@contoh.example', name: null },
      ],
    });
    expect(await within(window).findByText(/Draf tersimpan · /)).toBeVisible();
  });

  it('kirim → toast Batalkan dengan hitung mundur → batal membuka lagi drafnya', async () => {
    const draft = fakeDraft({
      to: [{ address: 'rina@contoh.example', name: 'Rina Wulandari' }],
      subject: 'Penawaran paket',
    });
    const { api } = await renderApp(
      '/email',
      setup({
        draft,
        routes: {
          [`POST ${apiPath(API_ROUTES.mail.outboxCancel, { outboxId: COMPOSE_IDS.outbox })}`]: () =>
            json({ outbox: fakeOutbox({ status: 'canceled' }), draftId: COMPOSE_IDS.draft }),
        },
      }),
    );
    const window = await openNew();
    const send = await within(window).findByRole('button', { name: c.footer.send });
    // Klik ganda: satu permintaan kirim.
    fireEvent.click(send);
    fireEvent.click(send);
    await waitFor(() => expect(requests(api, 'POST', sendPath)).toHaveLength(1));
    expect(requests(api, 'POST', sendPath)[0]?.body).toMatchObject({
      baseVersion: expect.any(Number) as unknown,
      acknowledgeNewMessagesUntil: null,
    });
    // Jendela tertutup, toast tampil.
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /Tulis email/ })).toBeNull());
    const toasts = screen.getByRole('region', { name: c.toast.region });
    expect(within(toasts).getByText(c.toast.willSend('cs@majujaya.co.id'))).toBeVisible();
    expect(within(toasts).getByRole('button', { name: c.toast.sendNow })).toBeVisible();
    fireEvent.click(within(toasts).getByRole('button', { name: /Batalkan kirim, sisa \d+ detik/ }));
    await waitFor(() =>
      expect(
        requests(
          api,
          'POST',
          apiPath(API_ROUTES.mail.outboxCancel, { outboxId: COMPOSE_IDS.outbox }),
        ),
      ).toHaveLength(1),
    );
    // Draf dibuka lagi dari server.
    expect(await composeWindow('Penawaran paket')).toBeVisible();
    await waitFor(() => expect(requests(api, 'GET', draftPath())).not.toHaveLength(0));
  });

  it('tanpa subjek & menyebut lampiran → konfirmasi dulu; tanpa penerima → ditolak di tempat', async () => {
    const { api } = await renderApp('/email', setup());
    const window = await openNew();
    fireEvent.click(await within(window).findByRole('button', { name: c.footer.send }));
    expect(await within(window).findByText(/Isi minimal satu penerima/)).toBeVisible();

    const to = within(window).getByRole('combobox', { name: c.toLabel });
    fireEvent.change(to, { target: { value: 'rina@contoh.example' } });
    fireEvent.keyDown(to, { key: 'Enter' });
    fireEvent.click(within(window).getByRole('button', { name: c.footer.send }));
    const dialog = await screen.findByRole('dialog', { name: c.preSend.noSubjectTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: c.preSend.sendAnyway }));
    await waitFor(() => expect(requests(api, 'POST', sendPath)).toHaveLength(1));
  });

  it('identitas belum diverifikasi: Kirim nonaktif + ajakan verifikasi', async () => {
    const draft = fakeDraft({
      identityId: COMPOSE_IDS.identityTagihan,
      canSend: false,
      cannotSendReason: 'identity_unverified',
    });
    await renderApp('/email', setup({ draft }));
    const window = await openNew();
    expect(await within(window).findByText(c.fromUnverifiedBody)).toBeVisible();
    expect(within(window).getByRole('link', { name: c.verifyLink })).toBeVisible();
    expect(within(window).getByRole('button', { name: c.footer.send })).toBeDisabled();
  });

  it('konflik versi saat simpan → dialog; "Timpa" mengirim force', async () => {
    let calls = 0;
    const { api } = await renderApp(
      '/email',
      setup({
        routes: {
          [`PUT ${draftPath()}`]: () => {
            calls += 1;
            if (calls === 1) {
              return json(
                {
                  error: {
                    code: 'CONFLICT',
                    message: 'Draf ini diubah di tab atau perangkat lain.',
                    details: [
                      {
                        field: 'baseVersion',
                        message: 'Draf ini diubah di tab atau perangkat lain.',
                        reason: 'draft_version_conflict',
                        currentVersion: 9,
                      },
                    ],
                    requestId: 'req-tes',
                  },
                },
                { status: 409 },
              );
            }
            return json({
              draft: {
                id: COMPOSE_IDS.draft,
                version: 10,
                updatedAt: new Date().toISOString(),
                serverCopy: { state: 'pending', syncedAt: null },
              },
            });
          },
        },
      }),
    );
    const window = await openNew();
    fireEvent.change(await within(window).findByLabelText(c.subject), {
      target: { value: 'Ubah di tab ini' },
    });
    const dialog = await screen.findByRole(
      'dialog',
      { name: c.conflict.title },
      { timeout: 6_000 },
    );
    fireEvent.click(within(dialog).getByRole('button', { name: c.conflict.overwrite }));
    await waitFor(() => expect(requests(api, 'PUT', draftPath())).toHaveLength(2));
    expect(requests(api, 'PUT', draftPath())[1]?.body).toMatchObject({ force: true });
  });

  it('lampiran: jenis berbahaya ditolak sebelum unggah, PDF diunggah', async () => {
    const { api } = await renderApp(
      '/email',
      setup({
        routes: {
          [`POST ${apiPath(API_ROUTES.mail.draftAttachments, { draftId: COMPOSE_IDS.draft })}`]:
            () =>
              json(
                {
                  attachment: {
                    id: COMPOSE_IDS.attachment,
                    filename: 'Penawaran.pdf',
                    contentType: 'application/pdf',
                    sizeBytes: 319_488,
                    inline: false,
                    contentId: null,
                    state: 'ready',
                    source: 'upload',
                  },
                  draft: { version: 2 },
                },
                { status: 201 },
              ),
        },
      }),
    );
    const window = await openNew();
    await within(window).findByRole('button', { name: c.attachments.attach });
    const input = window.querySelector<HTMLInputElement>('input[type="file"][multiple]');
    expect(input).not.toBeNull();
    fireEvent.change(input as HTMLInputElement, {
      target: {
        files: [
          new File(['MZ'], 'setup.exe', { type: 'application/octet-stream' }),
          new File(['%PDF'], 'Penawaran.pdf', { type: 'application/pdf' }),
        ],
      },
    });
    const list = await within(window).findByRole('list', { name: c.attachments.listLabel });
    expect(await within(list).findByText(c.attachments.blockedType)).toBeVisible();
    expect(await within(list).findByText('Penawaran.pdf')).toBeVisible();
    const uploads = requests(
      api,
      'POST',
      apiPath(API_ROUTES.mail.draftAttachments, { draftId: COMPOSE_IDS.draft }),
    );
    expect(uploads).toHaveLength(1);
    expect((uploads[0]?.raw as FormData).get('file')).toBeInstanceOf(File);
  });
});

describe('balas dari panel baca', () => {
  const detail = fakeMailDetail();
  const replyDraft = fakeDraft({
    mode: 'reply',
    sourceMessageId: detail.id,
    threadKey: 'utas-1',
    to: [{ address: 'noc@nusaraya.example', name: 'NOC Nusaraya' }],
    subject: 'Re: Jadwal pemeliharaan 26 November',
    includeQuote: true,
    quote: {
      available: true,
      messageId: detail.id,
      from: { address: 'noc@nusaraya.example', name: 'NOC Nusaraya' },
      sentAt: detail.receivedAt,
      hasHtml: true,
    },
  });

  it('Balas membuat draf balasan, detak presence, lalu 409 utas baru → dialog → Tetap kirim', async () => {
    let attempts = 0;
    const { api } = await renderApp(
      `/email?m=${detail.id}`,
      setup({
        draft: replyDraft,
        detail,
        messages: [fakeMailSummary()],
        routes: {
          [`POST ${sendPath}`]: () => {
            attempts += 1;
            if (attempts === 1) {
              return json(
                {
                  error: {
                    code: 'CONFLICT',
                    message: 'Ada 1 email baru di utas ini sejak kamu mulai menulis.',
                    details: [
                      {
                        field: 'draftId',
                        message: 'Ada email baru.',
                        reason: 'thread_has_new_messages',
                        count: 1,
                        latestReceivedAt: '2026-11-23T03:00:00.000Z',
                        messageIds: [MAIL_IDS.message2],
                      },
                    ],
                    requestId: 'req-tes',
                  },
                },
                { status: 409 },
              );
            }
            return json({ outbox: fakeOutbox() }, { status: 202 });
          },
        },
      }),
    );
    const bar = await screen.findByRole('group', { name: rb.actionsLabel });
    fireEvent.click(within(bar).getByRole('button', { name: rb.reply }));
    const window = await composeWindow(c.titles.reply('Jadwal pemeliharaan 26 November'));
    expect(requests(api, 'POST', API_ROUTES.mail.drafts)[0]?.body).toEqual({
      mode: 'reply',
      sourceMessageId: detail.id,
    });
    // Kutipan tidak masuk editor: cip "Tampilkan kutipan".
    expect(
      await within(window).findByRole('button', { name: c.quote.show('NOC Nusaraya') }),
    ).toBeVisible();
    await waitFor(() =>
      expect(
        requests(api, 'PUT', apiPath(API_ROUTES.mail.draftPresence, { draftId: replyDraft.id })),
      ).toHaveLength(1),
    );

    fireEvent.click(within(window).getByRole('button', { name: c.footer.send }));
    const dialog = await screen.findByRole('dialog', { name: c.threadNew.dialogTitle });
    expect(dialog).toHaveTextContent('Ada 1 email baru di utas ini sejak kamu mulai menulis.');
    fireEvent.click(within(dialog).getByRole('button', { name: c.threadNew.sendAnyway }));
    await waitFor(() => expect(requests(api, 'POST', sendPath)).toHaveLength(2));
    expect(requests(api, 'POST', sendPath)[1]?.body).toMatchObject({
      acknowledgeNewMessagesUntil: '2026-11-23T03:00:00.000Z',
    });
    // Terkirim: presence dilepas.
    await waitFor(() =>
      expect(
        requests(api, 'DELETE', apiPath(API_ROUTES.mail.draftPresence, { draftId: replyDraft.id })),
      ).toHaveLength(1),
    );
  });

  it('panel baca menampilkan rekan yang sedang membalas (tanpa diri sendiri), ikut event WS', async () => {
    const withComposing = {
      ...detail,
      threadKey: 'utas-1',
      composing: [
        { user: { id: SELF_ID, name: 'Rina Kartika' } },
        { user: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0099', name: 'Dimas' } },
      ],
    };
    await renderApp(`/email?m=${detail.id}`, setup({ detail: withComposing }));
    expect(await screen.findByText(rb.composing('Dimas'))).toBeVisible();
    act(() =>
      FakeSocket.latest()?.receive({
        type: 'mail.compose.presence',
        accountId: MAIL_IDS.cs,
        threadKey: 'utas-1',
        users: [],
      }),
    );
    await waitFor(() => expect(screen.queryByText(rb.composing('Dimas'))).toBeNull());
  });

  it('pemegang hak Baca saja: Balas & Balas semua nonaktif', async () => {
    await renderApp(`/email?m=${detail.id}`, setup({ detail: { ...detail, myLevel: 'read' } }));
    const bar = await screen.findByRole('group', { name: rb.actionsLabel });
    expect(within(bar).getByRole('button', { name: rb.reply })).toBeDisabled();
    expect(within(bar).getByRole('button', { name: rb.replyAll })).toBeDisabled();
    expect(within(bar).getByText(rb.noSendRight)).toBeVisible();
  });
});

describe('folder Draf', () => {
  it('salinan draf milikku membuka jendela tulis (draftId), bukan panel baca', async () => {
    const draft = fakeDraft({ subject: 'Draf penawaran' });
    const row = fakeMailSummary({
      subject: 'Draf penawaran',
      draftId: draft.id,
      folderRole: 'drafts',
    });
    const { api } = await renderApp('/email', setup({ draft, messages: [row] }));
    fireEvent.click(await screen.findByRole('button', { name: /Draf penawaran/ }));
    expect(await composeWindow('Draf penawaran')).toBeVisible();
    await waitFor(() => expect(requests(api, 'GET', draftPath())).toHaveLength(1));
    expect(requests(api, 'POST', API_ROUTES.mail.drafts)).toHaveLength(0);
  });
});
