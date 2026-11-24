import { API_ROUTES, apiPath } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { media } from '../../lib/media';
import { fakeSession, json } from '../../test/fake-api';
import {
  fakeChannelSummary,
  fakeContact,
  fakeConversation,
  fakeEvent,
  fakeMessage,
  fakeNote,
  fakeTag,
} from '../../test/fake-inbox';
import { TEST_CODE, TEST_PASSWORD, confirmIdentity } from '../../test/identity';
import { setMediaQuery } from '../../test/match-media';
import { renderApp } from '../../test/render-app';

const p = t.inbox.panel;
const HOUR = 3_600_000;
const inFuture = (ms: number) => new Date(Date.now() + ms).toISOString();

const vip = fakeTag({ name: 'VIP', color: 'yellow' });
const mitra = fakeTag({ name: 'Mitra', color: 'purple' });
const conversation = fakeConversation({
  status: 'served',
  assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
  windowExpiresAt: inFuture(5 * HOUR),
});
const contact = fakeContact({
  id: conversation.contact.id,
  tags: [{ id: vip.id, name: vip.name, color: vip.color }],
  email: 'budi@contoh.id',
  notes: 'Langganan paket 50 Mbps.',
  attributes: [{ key: 'ID pelanggan', value: 'SKY-0412' }],
});
const starred = fakeMessage({
  text: 'Alamat: Jl. Kenanga 12',
  starredAt: inFuture(-HOUR),
  createdAt: inFuture(-2 * HOUR),
});
const plain = fakeMessage({ text: 'Halo kak', createdAt: inFuture(-HOUR) });
const note = fakeNote();
const otherNote = fakeNote({
  body: 'Sudah dicek teknisi.',
  author: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0042', name: 'Agus' },
  canEdit: false,
  canDelete: false,
});

const inbox = {
  conversations: [conversation],
  contacts: [contact],
  messages: { [conversation.id]: [starred, plain] },
  channels: [fakeChannelSummary()],
  tags: [vip, mitra],
  notes: { [conversation.id]: [note, otherNote] },
  events: {
    [conversation.id]: [
      fakeEvent(),
      fakeEvent({ kind: 'tag_added', tag: { name: 'VIP', color: 'yellow' } }),
      fakeEvent({ kind: 'contact_updated', fields: ['email', 'notes'] }),
      fakeEvent({
        kind: 'assigned',
        assignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0042', name: 'Agus' },
        previousAssignee: { id: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001', name: 'Rina Kartika' },
      }),
    ],
  },
};

function panel() {
  return within(screen.getByRole('complementary', { name: t.inbox.detail.label }));
}

async function openPanel(options: Parameters<typeof renderApp>[1] = {}) {
  act(() => setMediaQuery(media.desktop, true));
  const view = await renderApp(`/inbox?chat=${conversation.id}`, { inbox, ...options });
  await panel().findByText('budi@contoh.id');
  return view;
}

const requestsTo = (
  api: Awaited<ReturnType<typeof renderApp>>['api'],
  method: string,
  path: string,
) => api.requests.filter((request) => request.method === method && request.path === path);

afterEach(() => vi.restoreAllMocks());

describe('panel detail — Info', () => {
  it('menampilkan tag, email, catatan kontak, dan atribut', async () => {
    await openPanel();
    expect(panel().getByText('VIP')).toBeVisible();
    expect(panel().getByText('Langganan paket 50 Mbps.')).toBeVisible();
    expect(panel().getByText('ID pelanggan')).toBeVisible();
    expect(panel().getByText('SKY-0412')).toBeVisible();
  });

  it('pasang tag dari daftar, lepas tag, dan buat tag baru', async () => {
    const { api } = await openPanel();
    const tagsPath = apiPath(API_ROUTES.inbox.contactTags, { contactId: contact.id });

    fireEvent.click(panel().getByRole('button', { name: p.addTag }));
    fireEvent.click(await screen.findByRole('button', { name: /Mitra/ }));
    await waitFor(() =>
      expect(requestsTo(api, 'POST', tagsPath)[0]?.body).toEqual({ tagId: mitra.id }),
    );

    fireEvent.change(screen.getByRole('textbox', { name: p.tagSearch }), {
      target: { value: 'Tunggakan' },
    });
    // Warna tag baru dipilih sebelum dibuat (bawaan biru).
    fireEvent.click(screen.getByRole('radio', { name: 'Ungu' }));
    fireEvent.click(screen.getByRole('button', { name: p.tagCreate('Tunggakan') }));
    await waitFor(() =>
      expect(requestsTo(api, 'POST', API_ROUTES.tags.list)[0]?.body).toEqual({
        name: 'Tunggakan',
        color: 'purple',
      }),
    );
    await waitFor(() => expect(requestsTo(api, 'POST', tagsPath)).toHaveLength(2));

    fireEvent.keyDown(document.activeElement ?? document.body, { key: 'Escape' });
    fireEvent.click(panel().getByRole('button', { name: p.removeTag('VIP') }));
    await waitFor(() =>
      expect(
        requestsTo(
          api,
          'DELETE',
          apiPath(API_ROUTES.inbox.contactTag, { contactId: contact.id, tagId: vip.id }),
        ),
      ).toHaveLength(1),
    );
  });

  it('Teknisi tidak melihat tombol ubah kontak/tag maupun data pribadi', async () => {
    await openPanel({ session: fakeSession('teknisi', 'Rina Kartika') });
    expect(panel().queryByRole('button', { name: p.editContact })).toBeNull();
    expect(panel().queryByRole('button', { name: p.addTag })).toBeNull();
    expect(panel().queryByRole('button', { name: p.deleteContact })).toBeNull();
  });

  it('ubah kontak: validasi email, kembali ke nama WhatsApp, atribut diganti utuh', async () => {
    const { api } = await openPanel();
    fireEvent.click(panel().getByRole('button', { name: p.editContact }));
    const dialog = within(await screen.findByRole('dialog', { name: p.contactEditTitle }));
    fireEvent.change(dialog.getByLabelText(p.email), { target: { value: 'bukan-email' } });
    fireEvent.click(dialog.getByRole('button', { name: p.save }));
    expect(await dialog.findByText(/Alamat email tidak valid/)).toBeVisible();

    fireEvent.change(dialog.getByLabelText(p.email), { target: { value: '' } });
    fireEvent.click(dialog.getByRole('button', { name: p.addAttribute }));
    const keys = dialog.getAllByLabelText(p.attributeKey);
    const values = dialog.getAllByLabelText(p.attributeValue);
    fireEvent.change(keys[1]!, { target: { value: 'Paket' } });
    fireEvent.change(values[1]!, { target: { value: '50 Mbps' } });
    fireEvent.click(dialog.getByRole('button', { name: p.save }));

    await waitFor(() =>
      expect(
        requestsTo(api, 'PATCH', apiPath(API_ROUTES.inbox.contact, { contactId: contact.id }))[0]
          ?.body,
      ).toEqual({
        name: null,
        email: null,
        notes: 'Langganan paket 50 Mbps.',
        attributes: [
          { key: 'ID pelanggan', value: 'SKY-0412' },
          { key: 'Paket', value: '50 Mbps' },
        ],
      }),
    );
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('ekspor data kontak mengunduh JSON', async () => {
    const createObjectURL = vi.fn(() => 'blob:ekspor');
    Object.assign(URL, { createObjectURL, revokeObjectURL: vi.fn() });
    const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const { api } = await openPanel();
    fireEvent.click(panel().getByRole('button', { name: p.exportContact }));
    expect(await panel().findByText(p.exported)).toBeVisible();
    expect(
      requestsTo(api, 'GET', apiPath(API_ROUTES.inbox.contactExport, { contactId: contact.id })),
    ).toHaveLength(1);
    expect(createObjectURL).toHaveBeenCalledOnce();
    expect(click).toHaveBeenCalledOnce();
  });

  it('ekspor tidak lengkap (akses per channel): peringatan berisi alasan dari server', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:ekspor'), revokeObjectURL: vi.fn() });
    vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});
    const reason = 'Sebagian percakapan ada di channel yang tidak boleh kamu lihat.';
    const exportPath = apiPath(API_ROUTES.inbox.contactExport, { contactId: contact.id });
    await openPanel({
      routes: {
        [`GET ${exportPath}`]: () =>
          json({
            exportedAt: '2026-11-22T04:00:00.000Z',
            contact: {
              id: contact.id,
              number: contact.number,
              channelType: contact.channelType,
              phone: contact.phone,
              waUsername: contact.waUsername,
              name: contact.name,
              profileName: contact.profileName,
              email: contact.email ?? null,
              notes: null,
              attributes: [],
              tags: [],
              createdAt: contact.createdAt,
            },
            conversations: [],
            messages: [],
            truncated: false,
            partial: true,
            partialReason: reason,
            excludedConversations: 2,
          }),
      },
    });
    fireEvent.click(panel().getByRole('button', { name: p.exportContact }));
    expect(await panel().findByText(p.exportedPartial)).toBeVisible();
    expect(panel().getByText(reason)).toBeVisible();
    expect(panel().queryByText(p.exported)).toBeNull();
  });

  it('hapus kontak: konfirmasi identitas → chat ditutup', async () => {
    const { api, router } = await openPanel();
    fireEvent.click(panel().getByRole('button', { name: p.deleteContact }));
    await confirmIdentity(p.deleteContactTitle, p.deleteContactConfirm);
    await waitFor(() => expect(router.state.location.search).not.toHaveProperty('chat'));
    expect(
      requestsTo(api, 'DELETE', apiPath(API_ROUTES.inbox.contact, { contactId: contact.id }))[0]
        ?.body,
    ).toEqual({ confirmation: { password: TEST_PASSWORD, code: TEST_CODE } });
  });
});

describe('panel detail — Catatan, Berkas, Log', () => {
  it('tab diaktifkan pointer ditandai (tanpa cincin fokus); keyboard melepas tandanya', async () => {
    await openPanel();
    const tab = panel().getByRole('tab', { name: p.tabs.log });
    fireEvent.pointerDown(tab);
    expect(tab).toHaveAttribute('data-pointer');
    fireEvent.keyDown(tab, { key: 'ArrowRight' });
    expect(tab).not.toHaveAttribute('data-pointer');
  });

  it('catatan sesi: tombol sesuai hak, tambah dan hapus', async () => {
    const { api } = await openPanel();
    fireEvent.mouseDown(panel().getByRole('tab', { name: p.tabs.notes }));
    fireEvent.click(panel().getByRole('tab', { name: p.tabs.notes }));
    expect(await panel().findByText(note.body)).toBeVisible();
    expect(panel().getByText('Sudah dicek teknisi.')).toBeVisible();
    // Catatan orang lain tanpa hak: tanpa tombol.
    expect(panel().getAllByRole('button', { name: p.editNote })).toHaveLength(1);
    expect(panel().getAllByRole('button', { name: p.deleteNote })).toHaveLength(1);

    fireEvent.change(panel().getByRole('textbox', { name: p.sessionNotes }), {
      target: { value: 'Minta pasang ulang router.' },
    });
    fireEvent.click(panel().getByRole('button', { name: p.addNote }));
    const notesPath = apiPath(API_ROUTES.inbox.notes, { conversationId: conversation.id });
    await waitFor(() =>
      expect(requestsTo(api, 'POST', notesPath)[0]?.body).toEqual({
        body: 'Minta pasang ulang router.',
      }),
    );

    fireEvent.click(panel().getAllByRole('button', { name: p.deleteNote })[0]!);
    const confirm = within(await screen.findByRole('dialog', { name: p.deleteNoteTitle }));
    fireEvent.click(confirm.getByRole('button', { name: p.deleteNoteConfirm }));
    await waitFor(() =>
      expect(
        requestsTo(
          api,
          'DELETE',
          apiPath(API_ROUTES.inbox.note, { conversationId: conversation.id, noteId: note.id }),
        ),
      ).toHaveLength(1),
    );
  });

  it('catatan kosong ditolak di klien', async () => {
    await openPanel();
    fireEvent.mouseDown(panel().getByRole('tab', { name: p.tabs.notes }));
    fireEvent.click(panel().getByRole('tab', { name: p.tabs.notes }));
    const box = await panel().findByRole('textbox', { name: p.sessionNotes });
    fireEvent.change(box, { target: { value: '   ' } });
    expect(panel().getByRole('button', { name: p.addNote })).toBeDisabled();
  });

  it('berkas: pesan ditandai memakai ?only=starred', async () => {
    const { api } = await openPanel();
    fireEvent.mouseDown(panel().getByRole('tab', { name: p.tabs.files }));
    fireEvent.click(panel().getByRole('tab', { name: p.tabs.files }));
    expect(await panel().findByText(p.noMedia)).toBeVisible();
    fireEvent.click(panel().getByRole('radio', { name: p.starred }));
    expect(await panel().findByText('Alamat: Jl. Kenanga 12')).toBeVisible();
    expect(
      api.requests.some(
        (request) =>
          request.path ===
            apiPath(API_ROUTES.inbox.messages, { conversationId: conversation.id }) &&
          request.query.get('only') === 'starred',
      ),
    ).toBe(true);
  });

  it('log: kejadian tag dan isian kontak yang diubah (tanpa isinya)', async () => {
    await openPanel();
    fireEvent.mouseDown(panel().getByRole('tab', { name: p.tabs.log }));
    fireEvent.click(panel().getByRole('tab', { name: p.tabs.log }));
    expect(await panel().findByText(/\(Email, Catatan/)).toBeVisible();
    expect(panel().getByText(/mengalihkan percakapan dari Rina Kartika ke Agus/)).toBeVisible();
    expect(panel().getAllByText('VIP').length).toBeGreaterThan(0);
    expect(panel().queryByText('budi@contoh.id')).toBeNull();
  });
});

describe('tandai pesan', () => {
  it('menu aksi pesan → Tandai pesan → PUT star', async () => {
    const { api } = await openPanel();
    const chat = within(screen.getByRole('region', { name: t.inbox.chat.label }));
    await chat.findByText('Halo kak');
    // Pesan terbaru (bukan yang sudah ditandai) ada di urutan terakhir.
    fireEvent.keyDown(chat.getAllByRole('button', { name: /Aksi untuk pesan/ }).at(-1)!, {
      key: 'Enter',
    });
    fireEvent.click(await screen.findByRole('menuitem', { name: t.inbox.actions.star }));
    await waitFor(() =>
      expect(
        requestsTo(api, 'PUT', apiPath(API_ROUTES.inbox.star, { messageId: plain.id })),
      ).toHaveLength(1),
    );
  });
});
