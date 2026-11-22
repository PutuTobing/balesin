import { Readable } from 'node:stream';

import {
  AppError,
  WEBHOOK_TARGET_ERROR_MESSAGES,
  cleanFileName,
  fetchRemoteFile,
  type Lookup,
  type RemoteFileError,
} from '@balesin/core';
import {
  apiKeys,
  channels,
  contacts,
  conversations,
  messages,
  organizations,
  users,
  type Database,
} from '@balesin/db';
import {
  OUTBOUND_MEDIA_LIMITS,
  apiKeyHasScope,
  interactiveMessageSchema,
  updateContactRequestSchema,
  type MobichatMessage,
  type MobichatOutgoingMessage,
  type SendMessageRequest,
} from '@balesin/shared';
import { and, eq, gt, inArray, isNull, or } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import type { ApiKeyActor } from '../api-keys/api-key-actor';
import type { ApiKeyPrincipal } from '../api-keys/api-key-auth';
import type { ContactsService } from '../contacts/contacts.service';
import type { AssignmentService } from '../inbox/assignment.service';
import { contactTagsOf, listMessages } from '../inbox/inbox.repo';
import { contactDisplayName, toMessage } from '../inbox/inbox-view';
import type { PanelService } from '../inbox/panel.service';
import type { OutboundService } from '../messages/outbound.service';
import { clientMessageIdFor } from '../public-api/public-api.routes';
import type { MediaUrlSigner } from './media-signature';
import { toMobichatMessage } from './mobichat-view';

/**
 * Lapisan kompatibel MobiChat (Fase 3, docs/KONTRAK-API-MOBICHAT.md) = ADAPTOR TIPIS di atas layanan
 * yang sudah ada: kirim pesan (`OutboundService.sendAsApiKey` — jendela 24 jam, rem darurat, batas
 * harian per key, idempotensi), penanganan (`AssignmentService.*AsApiKey`), catatan
 * (`PanelService.addNoteAsApiKey`), kontak & tag (`ContactsService.*FromApi`). Di sini hanya:
 * terjemahan ID numerik (`conversations.number`/`messages.number`) ↔ UUID, bentuk MobiChat, dan
 * unduhan `media_url` (aman SSRF) sebelum diserahkan ke unggah media biasa.
 * Cakupan data = organisasi pemilik key (sama dengan API publik v1).
 */

export interface MobichatServiceDeps {
  db: Database;
  outbound: OutboundService;
  assignment: Pick<AssignmentService, 'releaseAsApiKey' | 'assignAsApiKey' | 'resolveAsApiKey'>;
  panel: Pick<PanelService, 'addNoteAsApiKey'>;
  contacts: Pick<ContactsService, 'updateFromApi' | 'tagsByNameFromApi'>;
  signer: MediaUrlSigner;
  /** Batas kirim organisasi per menit (sama dengan web/API v1) — dipanggil per pesan. */
  organizationRate: (organizationId: string) => Promise<unknown>;
  now?: () => Date;
  /** Tes saja: unduhan `media_url` ke server tiruan di 127.0.0.1. */
  remote?: { allowLoopback?: boolean; lookup?: Lookup; timeoutMs?: number };
}

export interface ConversationRef {
  id: string;
  number: number;
  status: string;
  contactId: string;
  assigneeUserId: string | null;
}

export interface SentSummary {
  conversationNumber: number;
  phone: string | null;
  messages: { number: number; type: string; status: string | null }[];
}

const CONVERSATION_NOT_FOUND = 'Percakapan tidak ditemukan.';

/**
 * Tombol/daftar gaya MobiChat (`message_type` `button`/`list`, `list_options[]`, `list_title`) →
 * pesan interaktif Balesin, divalidasi dengan batas Meta yang SAMA dengan web/API v1.
 */
export function interactiveFromMobichat(item: MobichatOutgoingMessage) {
  const body = item.text ?? item.message_text ?? '';
  const options = item.list_options ?? [];
  const candidate =
    item.message_type === 'button'
      ? {
          kind: 'button' as const,
          body,
          buttons: options.map((option) => ({ id: option.id, title: option.title })),
        }
      : {
          kind: 'list' as const,
          body,
          buttonText: item.list_title?.trim() || 'Pilih',
          sections: [
            {
              rows: options.map((option) => ({
                id: option.id,
                title: option.title,
                ...(option.description ? { description: option.description } : {}),
              })),
            },
          ],
        };
  const parsed = interactiveMessageSchema.safeParse(candidate);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new AppError('VALIDATION_ERROR', {
      message: `list_options: ${issue?.message ?? 'Pesan tombol/daftar tidak valid.'}`,
    });
  }
  return parsed.data;
}

/** `+6281…` → `6281…` (format nomor MobiChat). */
export const digitsOf = (phone: string | null) => (phone ? phone.replace(/\D/g, '') : null);

/**
 * Kode negara bawaan untuk nomor lokal berawalan `0` (review template Info 3). TITIK KAIT: pengaturan
 * organisasi (white-label) — butuh migrasi; ditunda karena modul broadcast sedang menambah migrasi.
 */
export const DEFAULT_COUNTRY_CALLING_CODE = '62';

/** Nomor WhatsApp gaya MobiChat (`62…`, `0…`, `+62…`, spasi/tanda hubung) → E.164 atau `null`. */
export function normalizeWhatsappNumber(
  value: string,
  defaultCountryCode: string = DEFAULT_COUNTRY_CALLING_CODE,
): string | null {
  let digits = value.replace(/\D/g, '');
  if (digits.startsWith('0')) digits = `${defaultCountryCode}${digits.slice(1)}`;
  return /^[1-9]\d{6,14}$/.test(digits) ? `+${digits}` : null;
}

/** Galat unduhan `media_url` → galat API (404 = tidak bisa diakses, seperti MobiChat). */
function remoteError(error: RemoteFileError): AppError {
  switch (error) {
    case 'timeout':
      return new AppError('NOT_FOUND', {
        message: 'media_url tidak bisa diunduh: batas waktu habis.',
      });
    case 'network':
    case 'dns':
      return new AppError('NOT_FOUND', { message: 'media_url tidak bisa diunduh: koneksi gagal.' });
    case 'redirect':
      return new AppError('NOT_FOUND', {
        message: 'media_url tidak bisa diunduh: pengalihan tidak valid atau terlalu banyak.',
      });
    case 'http':
      return new AppError('NOT_FOUND', {
        message: 'media_url tidak bisa diakses (server menjawab bukan 2xx).',
      });
    case 'too_large':
      return new AppError('PAYLOAD_TOO_LARGE', {
        message: 'Berkas di media_url melebihi batas ukuran WhatsApp untuk jenis media itu.',
      });
    case 'host_not_allowed':
      return new AppError('VALIDATION_ERROR', {
        message: 'media_url ditolak: host tidak diizinkan.',
      });
    default:
      return new AppError('VALIDATION_ERROR', {
        message: `media_url ditolak: ${WEBHOOK_TARGET_ERROR_MESSAGES[error].replace(/URL webhook|Webhook/g, 'URL')}`,
      });
  }
}

export function createMobichatService(deps: MobichatServiceDeps) {
  const { db, outbound, signer } = deps;
  const now = deps.now ?? (() => new Date());

  const actorOf = (key: ApiKeyPrincipal, client: ClientInfo): ApiKeyActor => ({
    organizationId: key.organizationId,
    apiKeyId: key.id,
    client,
  });

  async function conversation(organizationId: string, number: number): Promise<ConversationRef> {
    const [row] = await db
      .select({
        id: conversations.id,
        number: conversations.number,
        status: conversations.status,
        contactId: conversations.contactId,
        assigneeUserId: conversations.assigneeUserId,
      })
      .from(conversations)
      // Lapisan kompatibel MobiChat = WhatsApp saja (DECISIONS 2026-11-19, review bot semua channel
      // B2): percakapan Telegram/Email/Messenger/Instagram dijawab 404 yang sama dengan "tidak ada".
      .innerJoin(
        channels,
        and(
          eq(channels.organizationId, conversations.organizationId),
          eq(channels.id, conversations.channelId),
          eq(channels.type, 'whatsapp'),
        ),
      )
      .where(
        and(eq(conversations.organizationId, organizationId), eq(conversations.number, number)),
      )
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: CONVERSATION_NOT_FOUND });
    return row;
  }

  async function contactOf(organizationId: string, contactId: string) {
    const [row] = await db
      .select()
      .from(contacts)
      .where(and(eq(contacts.organizationId, organizationId), eq(contacts.id, contactId)))
      .limit(1);
    if (!row) throw new AppError('NOT_FOUND', { message: 'Kontak tidak ditemukan.' });
    return row;
  }

  async function contactView(organizationId: string, contactId: string) {
    const row = await contactOf(organizationId, contactId);
    const tagMap = await contactTagsOf(db, organizationId, [row.id]);
    return {
      id: row.number,
      full_name: row.name ?? row.profileName,
      edited_name: row.name,
      name: row.name ?? row.profileName,
      phone_number: digitsOf(row.phone),
      tags: (tagMap.get(row.id) ?? []).map((tag) => tag.name),
    };
  }

  /** `media_url` → unggahan media biasa (aturan jenis/ukuran = web) → ID unggahan. */
  async function uploadFromUrl(
    key: ApiKeyPrincipal,
    conversationId: string,
    item: MobichatOutgoingMessage,
  ): Promise<string> {
    const kind = item.media_type ?? 'document';
    const [org] = await db
      .select({ cidrs: organizations.webhookPrivateCidrs })
      .from(organizations)
      .where(eq(organizations.id, key.organizationId));
    const result = await fetchRemoteFile({
      url: item.media_url ?? '',
      // Allowlist IP privat yang SAMA dengan webhook keluar (mis. server media di LAN).
      privateCidrs: org?.cidrs ?? [],
      maxBytes: OUTBOUND_MEDIA_LIMITS[kind].maxBytes,
      ...(deps.remote?.timeoutMs ? { timeoutMs: deps.remote.timeoutMs } : {}),
      ...(deps.remote?.lookup ? { lookup: deps.remote.lookup } : {}),
      ...(deps.remote?.allowLoopback ? { allowLoopback: true } : {}),
    });
    if (!result.ok) {
      throw remoteError(result.error);
    }
    const fromUrl = decodeURIComponent(result.finalUrl.pathname.split('/').pop() ?? '').trim();
    const filename = cleanFileName(item.file_name?.trim() || fromUrl || null);
    const media = await outbound.uploadAsApiKey(
      { organizationId: key.organizationId, apiKeyId: key.id, dailySendLimit: key.dailySendLimit },
      conversationId,
      { stream: Readable.from([result.body]), filename },
    );
    return media.id;
  }

  return {
    conversation,

    /** Riwayat (terbaru `limit`, urut lama → baru) dalam bentuk MobiChat. */
    async history(key: ApiKeyPrincipal, number: number, limit: number) {
      const ref = await conversation(key.organizationId, number);
      const contact = await contactOf(key.organizationId, ref.contactId);
      const rows = (await listMessages(db, key.organizationId, ref.id, { limit })).reverse();
      const keyIds = [...new Set(rows.map((row) => row.apiKeyId).filter((id) => id !== null))];
      const keyNames = new Map(
        keyIds.length === 0
          ? []
          : (
              await db
                .select({ id: apiKeys.id, name: apiKeys.name })
                .from(apiKeys)
                .where(
                  and(eq(apiKeys.organizationId, key.organizationId), inArray(apiKeys.id, keyIds)),
                )
            ).map((row) => [row.id, row.name] as const),
      );
      const at = now();
      const result: MobichatMessage[] = [];
      for (const row of rows) {
        // Reaksi bukan pesan baru untuk bot (MobiChat juga tidak meneruskannya sebagai pesan).
        if (row.type === 'reaction') continue;
        const message = toMessage(row);
        result.push(
          toMobichatMessage(message, {
            conversationNumber: ref.number,
            index: result.length,
            contactName: contactDisplayName(contact),
            botName: row.apiKeyId ? (keyNames.get(row.apiKeyId) ?? 'Bot') : 'Bot',
            mediaUrl: message.media ? signer.url(message.number, key.id, at) : null,
          }),
        );
      }
      return { conversationNumber: ref.number, messages: result };
    },

    /**
     * Kirim `messages[]` berurutan lewat jalur kirim biasa. `Idempotency-Key` (opsional) berlaku per
     * butir (`<key>#<urutan>`). Galat di tengah jalan menghentikan sisanya (butir sebelumnya sudah
     * terantre).
     */
    async send(
      key: ApiKeyPrincipal,
      number: number,
      items: readonly MobichatOutgoingMessage[],
      idempotencyKey: string | undefined,
      client: ClientInfo,
    ): Promise<SentSummary> {
      const ref = await conversation(key.organizationId, number);
      const sender = {
        organizationId: key.organizationId,
        apiKeyId: key.id,
        dailySendLimit: key.dailySendLimit,
        scopes: key.scopes,
      };
      const sent: SentSummary['messages'] = [];
      for (const [index, item] of items.entries()) {
        await deps.organizationRate(key.organizationId);
        const clientMessageId = clientMessageIdFor(
          key.id,
          idempotencyKey === undefined ? undefined : `${idempotencyKey}#${String(index)}`,
        );
        let input: SendMessageRequest;
        if (item.message_type === 'button' || item.message_type === 'list') {
          input = {
            type: 'interactive',
            clientMessageId,
            interactive: interactiveFromMobichat(item),
          };
        } else if ((item.message_type ?? 'text') === 'media') {
          const caption = (item.caption ?? item.text ?? item.message_text)?.slice(0, 1024);
          input = {
            type: 'media',
            clientMessageId,
            mediaId: await uploadFromUrl(key, ref.id, item),
            ...(caption?.trim() ? { caption } : {}),
          };
        } else {
          input = { type: 'text', clientMessageId, text: item.text ?? item.message_text ?? '' };
        }
        const { message } = await outbound.sendAsApiKey(sender, ref.id, input, client);
        sent.push({ number: message.number, type: message.type, status: message.status });
      }
      const contact = await contactOf(key.organizationId, ref.contactId);
      return { conversationNumber: ref.number, phone: digitsOf(contact.phone), messages: sent };
    },

    /** Status + "assignment" gaya MobiChat (`role: chatbot` saat status `bot`). */
    async status(key: ApiKeyPrincipal, number: number) {
      const ref = await conversation(key.organizationId, number);
      const assignments: {
        user: { id: string; name: string; email: null; role: 'chatbot' | 'agent' };
      }[] = [];
      if (ref.status === 'bot') {
        assignments.push({ user: { id: 'bot', name: 'Bot', email: null, role: 'chatbot' } });
      }
      if (ref.assigneeUserId) {
        const [agent] = await db
          .select({ id: users.id, name: users.name })
          .from(users)
          .where(
            and(eq(users.organizationId, key.organizationId), eq(users.id, ref.assigneeUserId)),
          );
        if (agent) {
          // Email agen sengaja tidak dibuka ke integrasi (nama sudah cukup untuk laporan).
          assignments.push({
            user: { id: agent.id, name: agent.name, email: null, role: 'agent' },
          });
        }
      }
      return { conversationNumber: ref.number, status: ref.status, assignments };
    },

    /** Lepas bot (tanpa agen / `agent_id` bukan ID pengguna Balesin) atau lepas agen tertentu. */
    async release(
      key: ApiKeyPrincipal,
      number: number,
      agentId: string | null | undefined,
      client: ClientInfo,
    ) {
      const ref = await conversation(key.organizationId, number);
      const agentUserId =
        agentId && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(agentId)
          ? agentId.toLowerCase()
          : null;
      const { changed } = await deps.assignment.releaseAsApiKey(
        actorOf(key, client),
        ref.id,
        agentUserId,
      );
      return { conversationNumber: ref.number, changed };
    },

    async assign(key: ApiKeyPrincipal, number: number, agentId: string, client: ClientInfo) {
      const ref = await conversation(key.organizationId, number);
      await deps.assignment.assignAsApiKey(actorOf(key, client), ref.id, agentId);
      return { conversationNumber: ref.number };
    },

    async resolve(key: ApiKeyPrincipal, number: number, client: ClientInfo) {
      const ref = await conversation(key.organizationId, number);
      const { changed } = await deps.assignment.resolveAsApiKey(actorOf(key, client), ref.id);
      return { conversationNumber: ref.number, changed };
    },

    async note(key: ApiKeyPrincipal, number: number, body: string, client: ClientInfo) {
      const ref = await conversation(key.organizationId, number);
      await deps.panel.addNoteAsApiKey(actorOf(key, client), ref.id, body);
      return { conversationNumber: ref.number };
    },

    /** Ganti nama kontak percakapan itu (validasi nama = API kontak biasa). */
    async rename(key: ApiKeyPrincipal, number: number, name: string) {
      const ref = await conversation(key.organizationId, number);
      const parsed = updateContactRequestSchema.safeParse({ name: name.trim() });
      if (!parsed.success) {
        throw new AppError('VALIDATION_ERROR', {
          message: parsed.error.issues[0]?.message ?? 'Nama kontak tidak valid.',
        });
      }
      await deps.contacts.updateFromApi(key.organizationId, key.id, ref.contactId, parsed.data);
      return contactView(key.organizationId, ref.contactId);
    },

    /** Tambah tag ke kontak WhatsApp bernomor itu (tag lama tetap). */
    async addTags(key: ApiKeyPrincipal, whatsappNumber: string, names: readonly string[]) {
      const phone = normalizeWhatsappNumber(whatsappNumber);
      if (!phone) {
        throw new AppError('VALIDATION_ERROR', {
          message: 'whatsapp_number tidak valid. Contoh: 6281234567890.',
        });
      }
      const [row] = await db
        .select({ id: contacts.id })
        .from(contacts)
        .where(
          and(
            eq(contacts.organizationId, key.organizationId),
            eq(contacts.channelType, 'whatsapp'),
            eq(contacts.phone, phone),
          ),
        )
        .limit(1);
      if (!row) {
        throw new AppError('NOT_FOUND', { message: 'Kontak dengan nomor itu tidak ditemukan.' });
      }
      await deps.contacts.tagsByNameFromApi(key.organizationId, key.id, row.id, names, 'add');
      return contactView(key.organizationId, row.id);
    },

    /**
     * Media untuk URL bertanda tangan: key penanda tangan masih aktif + `messages:read`, pesan milik
     * organisasi key itu. `null` = tidak sah (dijawab 404 seragam).
     */
    async signedMedia(messageNumber: number, apiKeyId: string, signal: AbortSignal) {
      const at = now();
      const [key] = await db
        .select({ organizationId: apiKeys.organizationId, scopes: apiKeys.scopes })
        .from(apiKeys)
        .where(
          and(
            eq(apiKeys.id, apiKeyId),
            isNull(apiKeys.revokedAt),
            or(isNull(apiKeys.expiresAt), gt(apiKeys.expiresAt, at)),
          ),
        )
        .limit(1);
      if (!key || !apiKeyHasScope(key.scopes, 'messages:read')) return null;
      const [message] = await db
        .select({ id: messages.id })
        .from(messages)
        .where(
          and(eq(messages.organizationId, key.organizationId), eq(messages.number, messageNumber)),
        )
        .limit(1);
      if (!message) return null;
      return outbound.media(
        {
          permission: 'inbox.view',
          scope: 'all',
          userId: apiKeyId,
          organizationId: key.organizationId,
          principal: 'apiKey',
        },
        message.id,
        signal,
      );
    },
  };
}

export type MobichatService = ReturnType<typeof createMobichatService>;
