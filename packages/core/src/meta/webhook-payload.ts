import { createHash } from 'node:crypto';

import { z } from 'zod';

/**
 * Payload webhook WhatsApp Cloud API: pembacaan TOLERAN, pemecahan per kejadian, dan normalisasi ke
 * bentuk internal Balesin.
 *
 * Sumber (dibaca 15 Nov 2026, developers.facebook.com/documentation/business-messaging/whatsapp/):
 *  - webhooks/overview (payload ≤ 3 MB, retry sampai 7 hari, bisa duplikat)
 *  - webhooks/reference/messages (+ text, image, unsupported, status, errors)
 *
 * Bentuk umum:
 *   { object: "whatsapp_business_account",
 *     entry: [{ id: <WABA ID>, changes: [{ field: "messages", value: {
 *       messaging_product: "whatsapp",
 *       metadata: { display_phone_number, phone_number_id },
 *       contacts?: [{ profile: { name, username? }, wa_id?, user_id }],
 *       messages?: [{ from?, from_user_id, id: "wamid…", timestamp: "<unix>", type, <type>: {…},
 *                     context?, referral?, errors? }],
 *       statuses?: [{ id, status, timestamp, recipient_id?, recipient_user_id?, conversation?,
 *                     pricing?, biz_opaque_callback_data?, errors? }],
 *       errors?: [{ code, title, message, error_data: { details }, href }] } }] }] }
 *
 * Catatan penting dari dokumentasi:
 *  - Sejak username WhatsApp, `from`/`wa_id` BISA TIDAK ADA; `from_user_id`/`user_id` (BSUID) selalu
 *    ada. Pengenal pelanggan wajib salah satunya.
 *  - Status: `sent`, `delivered`, `read`, `played` (pesan suara), `failed`. Nilai baru dibiarkan
 *    lewat (dicatat apa adanya, dinormalisasi `unknown`).
 *  - Satu notifikasi bisa memuat banyak entry/change/pesan/status sekaligus.
 *
 * Prinsip: setiap bagian divalidasi SENDIRI (`safeParse`). Satu pesan berbentuk aneh tidak boleh
 * menggagalkan pesan lain di notifikasi yang sama. Isian tambahan dari Meta dipertahankan
 * (`looseObject`) supaya fitur berikutnya bisa memakainya tanpa mengubah data tersimpan.
 */

// ── Skema bagian payload ────────────────────────────────────────────────────

/** ID Meta numerik (WABA, Phone Number ID). Sama dengan aturan `channels_wa_ids_numeric`. */
const metaNumericId = z.string().regex(/^[0-9]{1,32}$/);
/** `wamid.…` (base64 + titik); dibatasi supaya kunci idempotensi tetap pendek. */
const messageId = z
  .string()
  .min(1)
  .max(256)
  .regex(/^[A-Za-z0-9._=+/:-]+$/);
/**
 * Batas atas cap waktu (1 Jan 2100, unix detik). Angka lebih besar membuat `new Date()` tidak sah
 * (Invalid Date → Drizzle melempar saat menyimpan) — review webhook S2.
 */
export const WEBHOOK_MAX_UNIX_SECONDS = 4_102_444_800;
/** Unix detik sebagai string (Meta) — angka juga diterima. */
const unixSeconds = z
  .union([z.string().regex(/^[0-9]{1,12}$/), z.number().int().nonnegative()])
  .refine((value) => Number(value) <= WEBHOOK_MAX_UNIX_SECONDS, {
    message: 'cap waktu di luar rentang',
  });
const shortText = (max: number) => z.string().max(max);

export const whatsAppWebhookErrorSchema = z.looseObject({
  code: z.number().int(),
  title: shortText(1_000).optional(),
  message: shortText(1_000).optional(),
  error_data: z.looseObject({ details: shortText(4_000).optional() }).optional(),
  href: shortText(1_000).optional(),
});
export type WhatsAppWebhookError = z.infer<typeof whatsAppWebhookErrorSchema>;

export const whatsAppWebhookContactSchema = z.looseObject({
  wa_id: shortText(64).optional(),
  user_id: shortText(256).optional(),
  parent_user_id: shortText(256).optional(),
  profile: z
    .looseObject({ name: shortText(1_000).optional(), username: shortText(256).optional() })
    .optional(),
});
export type WhatsAppWebhookContact = z.infer<typeof whatsAppWebhookContactSchema>;

export const whatsAppWebhookMessageSchema = z
  .looseObject({
    id: messageId,
    from: shortText(64).optional(),
    from_user_id: shortText(256).optional(),
    from_parent_user_id: shortText(256).optional(),
    timestamp: unixSeconds,
    type: z
      .string()
      .min(1)
      .max(64)
      .regex(/^[a-z_]+$/),
    errors: z.array(whatsAppWebhookErrorSchema).max(50).optional(),
  })
  .refine((message) => Boolean(message.from) || Boolean(message.from_user_id), {
    message: 'pesan tanpa pengenal pengirim (from / from_user_id)',
  });
export type WhatsAppWebhookMessage = z.infer<typeof whatsAppWebhookMessageSchema>;

export const whatsAppWebhookStatusSchema = z.looseObject({
  id: messageId,
  status: z
    .string()
    .min(1)
    .max(32)
    .regex(/^[a-z_]+$/),
  timestamp: unixSeconds,
  recipient_id: shortText(64).optional(),
  recipient_user_id: shortText(256).optional(),
  biz_opaque_callback_data: shortText(1_024).optional(),
  errors: z.array(whatsAppWebhookErrorSchema).max(50).optional(),
});
export type WhatsAppWebhookStatus = z.infer<typeof whatsAppWebhookStatusSchema>;

const metadataSchema = z.looseObject({
  phone_number_id: metaNumericId,
  display_phone_number: shortText(64).optional(),
});

/** Nama field langganan webhook (`messages`, `account_update`, `message_template_status_update`, …). */
const fieldName = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[a-z_]+$/);

const changeSchema = z.looseObject({ field: fieldName, value: z.record(z.string(), z.unknown()) });
const entrySchema = z.looseObject({
  id: metaNumericId,
  changes: z.array(z.unknown()).max(1_000),
});
const envelopeSchema = z.looseObject({
  object: z.literal('whatsapp_business_account'),
  entry: z.array(z.unknown()).max(1_000),
});

// ── Pemecahan notifikasi → kejadian ─────────────────────────────────────────

/**
 * Batas kerja per notifikasi (review webhook R2). Meta membatasi payload 3 MB; status paling ringkas
 * ±150–300 byte, jadi notifikasi sah tidak mendekati 10.000 kejadian. Batas nomor berbeda menjaga
 * routing tetap satu query (`inArray`) yang kecil. Kelebihannya dibuang (`overLimit`), bukan 5xx —
 * mengirim ulang byte yang sama tidak akan pernah berhasil.
 */
export const WEBHOOK_MAX_EVENTS_PER_NOTIFICATION = 10_000;
export const WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION = 50;

/** Payload tersimpan per jenis (bagian yang SUDAH divalidasi skema di atas). */
export interface StoredMessageEvent {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  /** Kontak pengirim dari `value.contacts` (dicocokkan lewat `wa_id`/`user_id`), atau `null`. */
  contact: WhatsAppWebhookContact | null;
  message: WhatsAppWebhookMessage;
}
export interface StoredStatusEvent {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  status: WhatsAppWebhookStatus;
}
export interface StoredErrorEvent {
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  error: WhatsAppWebhookError;
}
/**
 * Field selain `messages` (tingkat WABA: status template, pembaruan akun, …) — belum diproses, jadi
 * isinya TIDAK disimpan (review webhook S4): hanya SHA-256 isi (heks penuh) untuk penelusuran.
 * Pemroses field ini kelak menambah isian yang ia butuhkan secara eksplisit.
 */
export interface StoredOtherEvent {
  wabaId: string;
  valueSha256: string;
}

interface ItemBase {
  /** Field langganan (`messages`, …). */
  field: string;
  /** `entry[].id` — WhatsApp Business Account ID. */
  wabaId: string;
  /**
   * Kunci idempotensi DALAM satu channel (unik bersama `channel_id`):
   *  - pesan masuk `m:<wamid>` → unik per (channel, wamid);
   *  - status `s:<wamid>:<status>` → unik per (channel, wamid, status);
   *  - error/lainnya (tanpa ID dari Meta) `e:`/`o:<field>:` + SHA-256 isinya: pengiriman ulang Meta
   *    memuat byte yang sama, jadi tetap terdeteksi duplikat.
   */
  dedupKey: string;
}

export type WhatsAppWebhookItem =
  | (ItemBase & {
      kind: 'message';
      phoneNumberId: string;
      externalId: string;
      occurredAt: Date;
      payload: StoredMessageEvent;
    })
  | (ItemBase & {
      kind: 'status';
      phoneNumberId: string;
      externalId: string;
      occurredAt: Date;
      payload: StoredStatusEvent;
    })
  | (ItemBase & {
      kind: 'error';
      phoneNumberId: string;
      externalId: null;
      occurredAt: null;
      payload: StoredErrorEvent;
    })
  | (ItemBase & {
      kind: 'other';
      phoneNumberId: null;
      externalId: null;
      occurredAt: null;
      payload: StoredOtherEvent;
    });

export interface WhatsAppWebhookSplit {
  items: WhatsAppWebhookItem[];
  /** Bagian yang tidak lolos skema (dibuang; hanya jumlahnya yang dicatat — tanpa isi). */
  invalid: number;
  /**
   * Bagian yang dibuang karena melewati `WEBHOOK_MAX_EVENTS_PER_NOTIFICATION` /
   * `WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION`.
   */
  overLimit: number;
  /** `false` = bukan notifikasi WhatsApp Business Account sama sekali. */
  recognized: boolean;
}

function unixToDate(value: string | number): Date {
  return new Date(Number(value) * 1000);
}

/** Cap waktu yang bisa disimpan, atau `null` (Invalid Date tidak pernah sampai ke database). */
function storableDate(value: string | number): Date | null {
  const date = unixToDate(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function fullDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function digest(value: unknown): string {
  return fullDigest(value).slice(0, 40);
}

function pickContact(
  contacts: WhatsAppWebhookContact[],
  message: WhatsAppWebhookMessage,
): WhatsAppWebhookContact | null {
  const match = contacts.find(
    (contact) =>
      (message.from_user_id !== undefined && contact.user_id === message.from_user_id) ||
      (message.from !== undefined && contact.wa_id === message.from),
  );
  if (match) return match;
  return contacts.length === 1 ? (contacts[0] ?? null) : null;
}

/**
 * Memecah satu notifikasi webhook (sudah lolos tanda tangan + `JSON.parse`) menjadi kejadian
 * mandiri: satu per pesan masuk, per status, per error, dan per perubahan field lain.
 */
export function splitWhatsAppWebhook(body: unknown): WhatsAppWebhookSplit {
  const envelope = envelopeSchema.safeParse(body);
  if (!envelope.success) return { items: [], invalid: 1, overLimit: 0, recognized: false };

  const items: WhatsAppWebhookItem[] = [];
  const phoneNumbers = new Set<string>();
  let invalid = 0;
  let overLimit = 0;
  const full = () => items.length >= WEBHOOK_MAX_EVENTS_PER_NOTIFICATION;

  for (const rawEntry of envelope.data.entry) {
    const entry = entrySchema.safeParse(rawEntry);
    if (!entry.success) {
      invalid += 1;
      continue;
    }
    const wabaId = entry.data.id;

    for (const rawChange of entry.data.changes) {
      const change = changeSchema.safeParse(rawChange);
      if (!change.success) {
        invalid += 1;
        continue;
      }
      const { field, value } = change.data;

      if (field !== 'messages') {
        if (full()) {
          overLimit += 1;
          continue;
        }
        items.push({
          kind: 'other',
          field,
          wabaId,
          phoneNumberId: null,
          externalId: null,
          occurredAt: null,
          dedupKey: `o:${field}:${digest(value)}`,
          payload: { wabaId, valueSha256: fullDigest(value) },
        });
        continue;
      }

      const metadata = metadataSchema.safeParse(value.metadata);
      if (!metadata.success) {
        invalid += 1;
        continue;
      }
      const phoneNumberId = metadata.data.phone_number_id;
      if (
        !phoneNumbers.has(phoneNumberId) &&
        phoneNumbers.size >= WEBHOOK_MAX_PHONE_NUMBERS_PER_NOTIFICATION
      ) {
        overLimit += 1;
        continue;
      }
      phoneNumbers.add(phoneNumberId);
      const displayPhoneNumber = metadata.data.display_phone_number ?? null;
      const base = { field, wabaId, phoneNumberId, displayPhoneNumber };

      const contacts = z
        .array(z.unknown())
        .max(1_000)
        .catch([])
        .parse(value.contacts ?? [])
        .flatMap((raw) => {
          const parsed = whatsAppWebhookContactSchema.safeParse(raw);
          return parsed.success ? [parsed.data] : [];
        });

      for (const [list, kind] of [
        [value.messages, 'message'],
        [value.statuses, 'status'],
        [value.errors, 'error'],
      ] as const) {
        if (list === undefined) continue;
        if (!Array.isArray(list)) {
          invalid += 1;
          continue;
        }
        for (const raw of list) {
          if (full()) {
            // Tanpa validasi: sisa bagian hanya dihitung.
            overLimit += 1;
            continue;
          }
          if (kind === 'message') {
            const message = whatsAppWebhookMessageSchema.safeParse(raw);
            const occurredAt = message.success ? storableDate(message.data.timestamp) : null;
            if (!message.success || occurredAt === null) {
              invalid += 1;
              continue;
            }
            items.push({
              kind,
              ...base,
              externalId: message.data.id,
              occurredAt,
              dedupKey: `m:${message.data.id}`,
              payload: {
                wabaId,
                phoneNumberId,
                displayPhoneNumber,
                contact: pickContact(contacts, message.data),
                message: message.data,
              },
            });
          } else if (kind === 'status') {
            const status = whatsAppWebhookStatusSchema.safeParse(raw);
            const occurredAt = status.success ? storableDate(status.data.timestamp) : null;
            if (!status.success || occurredAt === null) {
              invalid += 1;
              continue;
            }
            items.push({
              kind,
              ...base,
              externalId: status.data.id,
              occurredAt,
              dedupKey: `s:${status.data.id}:${status.data.status}`,
              payload: { wabaId, phoneNumberId, displayPhoneNumber, status: status.data },
            });
          } else {
            const error = whatsAppWebhookErrorSchema.safeParse(raw);
            if (!error.success) {
              invalid += 1;
              continue;
            }
            items.push({
              kind,
              ...base,
              externalId: null,
              occurredAt: null,
              dedupKey: `e:${digest({ phoneNumberId, error: error.data })}`,
              payload: { wabaId, phoneNumberId, displayPhoneNumber, error: error.data },
            });
          }
        }
      }
    }
  }

  return { items, invalid, overLimit, recognized: true };
}

/** `String.prototype.isWellFormed/toWellFormed` (ES2024, Node 20+); lib TS proyek masih ES2023. */
interface WellFormedText {
  isWellFormed(): boolean;
  toWellFormed(): string;
}

/**
 * Teks yang pasti diterima kolom `jsonb` Postgres (review webhook S2): `\u0000` dibuang dan surrogate
 * tunggal (mis. emoji terpotong di tengah) diganti U+FFFD. Tanpa ini satu kejadian "beracun"
 * menggagalkan INSERT seluruh notifikasi.
 */
export function toStorableText(value: string): string {
  const withoutNul = value.includes('\u0000') ? value.replaceAll('\u0000', '') : value;
  const text = withoutNul as unknown as WellFormedText;
  return text.isWellFormed() ? withoutNul : text.toWellFormed();
}

const isForbiddenKey = (key: string) => key === '__proto__' || key === 'constructor';

/** Objek dengan kunci yang sudah dibersihkan (objek yang sama bila tidak ada yang perlu diubah). */
function withStorableKeys(value: Record<string, unknown>): Record<string, unknown> {
  const keys = Object.keys(value);
  if (keys.every((key) => toStorableText(key) === key)) return value;
  const cleaned: Record<string, unknown> = {};
  for (const key of keys) {
    const clean = toStorableText(key);
    // Kunci yang BARU menjadi `__proto__`/`constructor` setelah dibersihkan juga dibuang.
    if (isForbiddenKey(clean)) continue;
    cleaned[clean] = value[key];
  }
  return cleaned;
}

/**
 * `JSON.parse` yang membuang kunci `__proto__`/`constructor` (pencemaran prototipe lewat objek hasil
 * parse yang kemudian disalin) dan membersihkan setiap teks — nilai DAN kunci objek — dengan
 * `toStorableText`. `undefined` bila bukan JSON (atau bersarang terlalu dalam).
 */
export function parseWebhookJson(raw: Buffer): unknown {
  try {
    return JSON.parse(raw.toString('utf8'), (key, value: unknown) => {
      if (isForbiddenKey(key)) return undefined;
      if (typeof value === 'string') return toStorableText(value);
      return isRecord(value) ? withStorableKeys(value) : value;
    });
  } catch {
    return undefined;
  }
}

// ── Normalisasi ke bentuk internal (dipakai worker) ─────────────────────────

/** Jenis pesan masuk yang dikenal Balesin. Jenis lain dari Meta → `unknown` (+ `rawType`). */
export const INBOUND_MESSAGE_TYPES = [
  'text',
  'image',
  'audio',
  'video',
  'document',
  'sticker',
  'location',
  'contacts',
  'interactive',
  'button',
  'reaction',
  'order',
  'system',
  'unsupported',
  'unknown',
] as const;
export type InboundMessageType = (typeof INBOUND_MESSAGE_TYPES)[number];

export type InboundMediaKind = 'image' | 'audio' | 'video' | 'document' | 'sticker';

export const MESSAGE_STATUS_VALUES = ['sent', 'delivered', 'read', 'played', 'failed'] as const;
export type MessageStatusValue = (typeof MESSAGE_STATUS_VALUES)[number] | 'unknown';

export interface NormalizedWebhookError {
  code: number;
  title: string | null;
  message: string | null;
  details: string | null;
}

export interface NormalizedInboundMessage {
  wamid: string;
  wabaId: string;
  phoneNumberId: string;
  /** Waktu dari Meta (`timestamp`). */
  sentAt: Date;
  sender: {
    /** Nomor WhatsApp (`from`/`wa_id`); `null` bila pelanggan memakai username tanpa nomor. */
    waId: string | null;
    /** BSUID (`from_user_id`/`user_id`). */
    userId: string | null;
    parentUserId: string | null;
    profileName: string | null;
    username: string | null;
  };
  type: InboundMessageType;
  /** `type` mentah dari Meta (mis. jenis baru yang belum dikenal). */
  rawType: string;
  /** Teks yang bisa ditampilkan: isi teks, keterangan media, teks tombol/pilihan. */
  text: string | null;
  media: {
    kind: InboundMediaKind;
    /** ID media Meta — diunduh lewat Graph API (butir berikutnya). */
    id: string;
    mimeType: string | null;
    sha256: string | null;
    caption: string | null;
    filename: string | null;
    /** Pesan suara (audio `voice: true`). */
    voice: boolean;
    animated: boolean;
  } | null;
  location: {
    latitude: number;
    longitude: number;
    name: string | null;
    address: string | null;
  } | null;
  reaction: { messageId: string; emoji: string | null } | null;
  /** Balasan tombol/daftar/flow. */
  reply: {
    kind: 'button' | 'button_reply' | 'list_reply' | 'nfm_reply' | 'other';
    id: string | null;
    title: string | null;
    description: string | null;
  } | null;
  /** Jumlah kartu kontak yang dibagikan (jenis `contacts`). */
  sharedContacts: number;
  context: {
    /** Pesan yang dibalas / dirujuk. */
    messageId: string | null;
    forwarded: boolean;
    frequentlyForwarded: boolean;
  } | null;
  referral: {
    sourceUrl: string | null;
    sourceId: string | null;
    sourceType: string | null;
    headline: string | null;
    body: string | null;
    ctwaClid: string | null;
  } | null;
  errors: NormalizedWebhookError[];
}

export interface NormalizedStatusUpdate {
  wamid: string;
  wabaId: string;
  phoneNumberId: string;
  status: MessageStatusValue;
  rawStatus: string;
  occurredAt: Date;
  recipient: { waId: string | null; userId: string | null };
  conversation: { id: string | null; originType: string | null; expiresAt: Date | null } | null;
  pricing: {
    billable: boolean | null;
    model: string | null;
    category: string | null;
    type: string | null;
  } | null;
  bizOpaqueCallbackData: string | null;
  errors: NormalizedWebhookError[];
}

export interface NormalizedWebhookFailure {
  wabaId: string;
  phoneNumberId: string;
  error: NormalizedWebhookError;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function text(value: unknown, max = 65_536): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= max ? value : null;
}

function record(value: unknown): Record<string, unknown> {
  return isRecord(value) ? value : {};
}

function finiteNumber(value: unknown): number | null {
  const number = typeof value === 'string' ? Number(value) : value;
  return typeof number === 'number' && Number.isFinite(number) ? number : null;
}

function unixOrNull(value: unknown): Date | null {
  const number = finiteNumber(value);
  return number === null ? null : new Date(number * 1000);
}

function normalizeError(error: WhatsAppWebhookError): NormalizedWebhookError {
  return {
    code: error.code,
    title: text(error.title, 1_000),
    message: text(error.message, 1_000),
    details: text(error.error_data?.details, 4_000),
  };
}

function inboundType(rawType: string): InboundMessageType {
  return (INBOUND_MESSAGE_TYPES as readonly string[]).includes(rawType) && rawType !== 'unknown'
    ? (rawType as InboundMessageType)
    : 'unknown';
}

const storedMessageSchema = z.object({
  wabaId: metaNumericId,
  phoneNumberId: metaNumericId,
  contact: whatsAppWebhookContactSchema.nullable(),
  message: whatsAppWebhookMessageSchema,
});
const storedStatusSchema = z.object({
  wabaId: metaNumericId,
  phoneNumberId: metaNumericId,
  status: whatsAppWebhookStatusSchema,
});
const storedErrorSchema = z.object({
  wabaId: metaNumericId,
  phoneNumberId: metaNumericId,
  error: whatsAppWebhookErrorSchema,
});

/** Payload tersimpan tidak cocok skema (data rusak / versi lain) — tidak akan sembuh bila diulang. */
export class WebhookPayloadError extends Error {
  override readonly name = 'WebhookPayloadError';
}

function parseStored<T>(schema: z.ZodType<T>, payload: unknown, kind: string): T {
  const parsed = schema.safeParse(payload);
  if (!parsed.success) throw new WebhookPayloadError(`Payload kejadian ${kind} tidak valid`);
  return parsed.data;
}

/** Payload kejadian `message` tersimpan → pesan masuk dalam bentuk internal. */
export function normalizeInboundMessage(payload: unknown): NormalizedInboundMessage {
  const { wabaId, phoneNumberId, contact, message } = parseStored(
    storedMessageSchema,
    payload,
    'message',
  );
  const rawType = message.type;
  const type = inboundType(rawType);
  // `Object.hasOwn`: `type` seperti `__proto__`/`toString` tidak membaca isian warisan prototipe.
  const body = record(
    Object.hasOwn(message, rawType) ? (message as Record<string, unknown>)[rawType] : undefined,
  );
  const context = isRecord(message.context) ? message.context : null;
  const referral = isRecord(message.referral) ? message.referral : null;

  let messageText: string | null = null;
  let media: NormalizedInboundMessage['media'] = null;
  let location: NormalizedInboundMessage['location'] = null;
  let reaction: NormalizedInboundMessage['reaction'] = null;
  let reply: NormalizedInboundMessage['reply'] = null;
  let sharedContacts = 0;

  switch (type) {
    case 'text':
      messageText = text(body.body);
      break;
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
    case 'sticker': {
      const id = text(body.id, 256);
      if (id) {
        media = {
          kind: type,
          id,
          mimeType: text(body.mime_type, 256),
          sha256: text(body.sha256, 256),
          caption: text(body.caption),
          filename: text(body.filename, 1_024),
          voice: body.voice === true,
          animated: body.animated === true,
        };
      }
      messageText = text(body.caption);
      break;
    }
    case 'location': {
      const latitude = finiteNumber(body.latitude);
      const longitude = finiteNumber(body.longitude);
      if (latitude !== null && longitude !== null) {
        location = {
          latitude,
          longitude,
          name: text(body.name, 1_024),
          address: text(body.address, 1_024),
        };
      }
      break;
    }
    case 'reaction': {
      const target = text(body.message_id, 256);
      if (target) reaction = { messageId: target, emoji: text(body.emoji, 64) };
      break;
    }
    case 'button':
      reply = {
        kind: 'button',
        id: text(body.payload, 4_096),
        title: text(body.text, 4_096),
        description: null,
      };
      messageText = reply.title;
      break;
    case 'interactive': {
      const kind = text(body.type, 64);
      const detail = kind && Object.hasOwn(body, kind) ? record(body[kind]) : {};
      reply = {
        kind:
          kind === 'button_reply' || kind === 'list_reply' || kind === 'nfm_reply' ? kind : 'other',
        id: text(detail.id, 4_096),
        title: text(detail.title, 4_096) ?? text(detail.body, 4_096),
        description: text(detail.description, 4_096),
      };
      messageText = reply.title;
      break;
    }
    case 'contacts':
      sharedContacts = Array.isArray((message as Record<string, unknown>).contacts)
        ? ((message as Record<string, unknown>).contacts as unknown[]).length
        : 0;
      break;
    case 'system':
      messageText = text(body.body);
      break;
    default:
      break;
  }

  return {
    wamid: message.id,
    wabaId,
    phoneNumberId,
    sentAt: unixToDate(message.timestamp),
    sender: {
      waId: text(message.from, 64) ?? text(contact?.wa_id, 64),
      userId: text(message.from_user_id, 256) ?? text(contact?.user_id, 256),
      parentUserId: text(message.from_parent_user_id, 256) ?? text(contact?.parent_user_id, 256),
      profileName: text(contact?.profile?.name, 1_000),
      username: text(contact?.profile?.username, 256),
    },
    type,
    rawType,
    text: messageText,
    media,
    location,
    reaction,
    reply,
    sharedContacts,
    context: context
      ? {
          messageId: text(context.id, 256),
          forwarded: context.forwarded === true,
          frequentlyForwarded: context.frequently_forwarded === true,
        }
      : null,
    referral: referral
      ? {
          sourceUrl: text(referral.source_url, 2_048),
          sourceId: text(referral.source_id, 256),
          sourceType: text(referral.source_type, 64),
          headline: text(referral.headline, 4_096),
          body: text(referral.body, 4_096),
          ctwaClid: text(referral.ctwa_clid, 1_024),
        }
      : null,
    errors: (message.errors ?? []).map(normalizeError),
  };
}

/** Payload kejadian `status` tersimpan → pembaruan status pesan keluar. */
export function normalizeStatusUpdate(payload: unknown): NormalizedStatusUpdate {
  const { wabaId, phoneNumberId, status } = parseStored(storedStatusSchema, payload, 'status');
  const conversation = isRecord(status.conversation) ? status.conversation : null;
  const pricing = isRecord(status.pricing) ? status.pricing : null;
  return {
    wamid: status.id,
    wabaId,
    phoneNumberId,
    status: (MESSAGE_STATUS_VALUES as readonly string[]).includes(status.status)
      ? (status.status as MessageStatusValue)
      : 'unknown',
    rawStatus: status.status,
    occurredAt: unixToDate(status.timestamp),
    recipient: {
      waId: text(status.recipient_id, 64),
      userId: text(status.recipient_user_id, 256),
    },
    conversation: conversation
      ? {
          id: text(conversation.id, 256),
          originType: text(record(conversation.origin).type, 64),
          expiresAt: unixOrNull(conversation.expiration_timestamp),
        }
      : null,
    pricing: pricing
      ? {
          billable: typeof pricing.billable === 'boolean' ? pricing.billable : null,
          model: text(pricing.pricing_model, 64),
          category: text(pricing.category, 64),
          type: text(pricing.type, 64),
        }
      : null,
    bizOpaqueCallbackData: text(status.biz_opaque_callback_data, 1_024),
    errors: (status.errors ?? []).map(normalizeError),
  };
}

/** Payload kejadian `error` tersimpan (error tingkat sistem/aplikasi/akun dari Meta). */
export function normalizeWebhookFailure(payload: unknown): NormalizedWebhookFailure {
  const { wabaId, phoneNumberId, error } = parseStored(storedErrorSchema, payload, 'error');
  return { wabaId, phoneNumberId, error: normalizeError(error) };
}

/**
 * Urutan status pesan keluar untuk aturan "status tidak boleh mundur" (butir pesan keluar):
 * `sent` < `delivered` < `read` < `played`. `failed` boleh datang kapan saja (kecuali setelah
 * `read`/`played` — pesan yang sudah dibaca jelas terkirim). `unknown` tidak pernah menimpa.
 */
const STATUS_RANK: Readonly<Record<Exclude<MessageStatusValue, 'failed' | 'unknown'>, number>> = {
  sent: 1,
  delivered: 2,
  read: 3,
  played: 4,
};

export function isStatusAdvance(current: MessageStatusValue | null, next: MessageStatusValue) {
  if (next === 'unknown') return false;
  if (current === null || current === 'unknown') return true;
  if (next === 'failed') return current === 'sent' || current === 'delivered';
  if (current === 'failed') return false;
  return STATUS_RANK[next] > STATUS_RANK[current];
}
