import { z } from 'zod';

import { isoDateTimeSchema } from './fields';

/**
 * Notifikasi Web Push (Fase 2 butir 10 — docs/KONTRAK-API-NOTIFIKASI.md).
 *
 * Alur web: `GET /notifications/vapid-public-key` → `PushManager.subscribe({ applicationServerKey })`
 * → `POST /notifications/subscriptions` (alamat + kunci langganan). Worker mengirim push terenkripsi
 * (RFC 8291) yang isinya `pushNotificationPayloadSchema`; service worker menampilkannya dan membuka
 * `url` (path relatif aplikasi) saat diklik.
 */

/** Batas langganan aktif per pengguna (perangkat/browser); yang tertua dilepas. */
export const PUSH_SUBSCRIPTIONS_PER_USER_MAX = 10;

/** Jeda gabung: paling banyak satu push per pengguna per percakapan dalam rentang ini. */
export const NOTIFICATION_THROTTLE_SECONDS = 30;

/** Panjang cuplikan pesan (bila organisasi mengizinkan cuplikan). */
export const NOTIFICATION_PREVIEW_MAX = 80;

export const vapidPublicKeyResponseSchema = z.object({
  /** Kunci publik VAPID (base64url, 65 byte) untuk `applicationServerKey`. */
  publicKey: z.string(),
});
export type VapidPublicKeyResponse = z.infer<typeof vapidPublicKeyResponseSchema>;

const base64url = (min: number, max: number, message: string) =>
  z
    .string({ error: message })
    .min(min, message)
    .max(max, message)
    .regex(/^[A-Za-z0-9_-]+={0,2}$/, message);

/** `POST /notifications/subscriptions` — bentuk `PushSubscription.toJSON()`. */
export const createPushSubscriptionRequestSchema = z.object({
  endpoint: z
    .string({ error: 'Alamat langganan wajib diisi.' })
    .min(1, 'Alamat langganan wajib diisi.')
    .max(1024, 'Alamat langganan terlalu panjang.'),
  /** Diabaikan server (browser sendiri yang memperbarui langganan). */
  expirationTime: z.number().nullable().optional(),
  keys: z.object({
    p256dh: base64url(80, 100, 'Kunci langganan tidak valid.'),
    auth: base64url(16, 30, 'Kunci langganan tidak valid.'),
  }),
});
export type CreatePushSubscriptionRequest = z.infer<typeof createPushSubscriptionRequestSchema>;

/** `DELETE /notifications/subscriptions` — lepas langganan perangkat ini (milik sendiri). */
export const deletePushSubscriptionRequestSchema = z.object({
  endpoint: z.string().min(1).max(1024),
});
export type DeletePushSubscriptionRequest = z.infer<typeof deletePushSubscriptionRequestSchema>;

export const pushSubscriptionResponseSchema = z.object({
  subscription: z.object({ id: z.uuid(), createdAt: isoDateTimeSchema }),
});
export type PushSubscriptionResponse = z.infer<typeof pushSubscriptionResponseSchema>;

export const pushSubscriptionDeletedResponseSchema = z.object({ deleted: z.boolean() });

/** Jam `HH:MM` (24 jam). */
export const clockTimeSchema = z
  .string()
  .regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'Format jam HH:MM (00:00–23:59).');

/**
 * Preferensi notifikasi per pengguna (bawaan semua menyala, tanpa jam tenang):
 *  - `queue`           — percakapan baru/pesan di antrian terbuka (Belum dilayani); hanya untuk
 *                        peran yang bisa mengambil chat (`inbox.assign`);
 *  - `assignedMessage` — pesan masuk di percakapan yang dipegang saya;
 *  - `assignedToMe`    — percakapan ditugaskan/dialihkan ke saya oleh orang lain;
 *  - `quietHours`      — rentang jam (zona waktu organisasi) tanpa push; boleh melewati tengah malam.
 */
export const notificationPreferencesSchema = z.object({
  queue: z.boolean(),
  assignedMessage: z.boolean(),
  assignedToMe: z.boolean(),
  quietHours: z
    .object({ start: clockTimeSchema, end: clockTimeSchema })
    .refine((value) => value.start !== value.end, 'Jam mulai dan selesai tidak boleh sama.')
    .nullable(),
});
export type NotificationPreferences = z.infer<typeof notificationPreferencesSchema>;

export const DEFAULT_NOTIFICATION_PREFERENCES: NotificationPreferences = {
  queue: true,
  assignedMessage: true,
  assignedToMe: true,
  quietHours: null,
};

export const notificationPreferencesResponseSchema = z.object({
  preferences: notificationPreferencesSchema,
  /** Zona waktu jam tenang (zona organisasi). */
  timezone: z.string(),
  /** Jumlah perangkat yang berlangganan untuk pengguna ini. */
  devices: z.number().int().nonnegative(),
});
export type NotificationPreferencesResponse = z.infer<typeof notificationPreferencesResponseSchema>;

/**
 * Pengaturan notifikasi organisasi (`organization.manage` = Owner), keduanya bawaan MATI (privasi
 * layar kunci, review push R1):
 *  - `contactName` = tampilkan nama kontak di judul ("Pesan baru dari {nama}"); mati → "Pesan baru
 *    di inbox". Nama profil WhatsApp (bukan nama dari tim) diberi penanda `~` (selaras UI);
 *  - `preview` = tampilkan cuplikan isi pesan.
 */
export const notificationSettingsSchema = z.object({
  preview: z.boolean(),
  contactName: z.boolean(),
});
export type NotificationSettings = z.infer<typeof notificationSettingsSchema>;
export const notificationSettingsResponseSchema = z.object({
  settings: notificationSettingsSchema,
});

export const notificationTestResponseSchema = z.object({
  /** Jumlah perangkat yang akan dikirimi (0 = belum berlangganan di perangkat mana pun). */
  devices: z.number().int().nonnegative(),
});

/** Isi push yang diterima service worker (setelah didekripsi browser). */
export const pushNotificationPayloadSchema = z.object({
  v: z.literal(1),
  title: z.string(),
  body: z.string(),
  /** Path RELATIF aplikasi (selalu diawali `/`, tidak pernah URL lain). */
  url: z.string().regex(/^\/(?!\/)/),
  /** Notifikasi dengan `tag` sama menggantikan yang lama (satu per percakapan). */
  tag: z.string(),
  conversationId: z.uuid().nullable(),
});
export type PushNotificationPayload = z.infer<typeof pushNotificationPayloadSchema>;
