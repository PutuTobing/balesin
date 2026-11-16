import {
  AppError,
  PushKeyError,
  checkPushEndpoint,
  generateVapidKeys,
  parseAuthSecret,
  parseP256PublicKey,
  type SecretBox,
} from '@balesin/core';
import {
  notificationPreferences,
  organizations,
  pushSubscriptions,
  pushVapidKeys,
  type Database,
} from '@balesin/db';
import {
  DEFAULT_NOTIFICATION_PREFERENCES,
  PUSH_SUBSCRIPTIONS_PER_USER_MAX,
  type CreatePushSubscriptionRequest,
  type NotificationPreferences,
  type NotificationPreferencesResponse,
  type NotificationSettings,
} from '@balesin/shared';
import { and, desc, eq, notInArray, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import type { NotificationEnqueuer } from '../../queues/notification-queue';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';

/**
 * Notifikasi Web Push (Fase 2 butir 10, docs/KONTRAK-API-NOTIFIKASI.md): kunci VAPID, langganan
 * per perangkat (terikat sesi), preferensi per pengguna, pengaturan cuplikan organisasi, tes.
 *
 * Rahasia:
 *  - kunci privat VAPID → kotak rahasia (`push_vapid_keys.private_key`, AAD organisasi); tidak
 *    pernah dikembalikan ke browser/log;
 *  - kunci langganan browser (`p256dh` + `auth`) → kotak rahasia (`push_subscriptions.keys`, AAD
 *    organisasi + pengguna).
 */

export const VAPID_SECRET_PURPOSE = 'push_vapid_keys.private_key';
export const SUBSCRIPTION_SECRET_PURPOSE = 'push_subscriptions.keys';

const UNAVAILABLE =
  'Notifikasi belum bisa dipakai: kunci master server belum diatur. Hubungi admin server.';
const BAD_ENDPOINT =
  'Browser ini memakai layanan notifikasi yang tidak dikenal. Pakai Chrome, Edge, Firefox, atau Safari terbaru.';
const BAD_KEYS = 'Data langganan notifikasi dari browser tidak valid. Coba aktifkan ulang.';

export interface NotificationsService {
  vapidPublicKey(organizationId: string): Promise<string>;
  subscribe(
    auth: AuthContext,
    input: CreatePushSubscriptionRequest,
  ): Promise<{ id: string; createdAt: Date }>;
  unsubscribe(auth: AuthContext, endpoint: string): Promise<boolean>;
  preferences(auth: AuthContext): Promise<NotificationPreferencesResponse>;
  updatePreferences(
    auth: AuthContext,
    input: NotificationPreferences,
  ): Promise<NotificationPreferencesResponse>;
  settings(organizationId: string): Promise<NotificationSettings>;
  updateSettings(
    auth: AuthContext,
    client: ClientInfo,
    input: NotificationSettings,
  ): Promise<NotificationSettings>;
  test(auth: AuthContext): Promise<number>;
}

const toMinute = (time: string) => Number(time.slice(0, 2)) * 60 + Number(time.slice(3, 5));
const toClock = (minute: number) =>
  `${String(Math.floor(minute / 60)).padStart(2, '0')}:${String(minute % 60).padStart(2, '0')}`;

export function createNotificationsService(deps: {
  db: Database;
  secretBox: SecretBox | null;
  notifications: NotificationEnqueuer;
  /** Origin server push TIRUAN (tes saja). */
  extraOrigins?: readonly string[];
}): NotificationsService {
  const { db, secretBox, notifications } = deps;
  const extraOrigins = deps.extraOrigins ?? [];

  function box(): SecretBox {
    if (!secretBox) throw new AppError('SERVICE_UNAVAILABLE', { message: UNAVAILABLE });
    return secretBox;
  }

  async function devicesOf(auth: AuthContext): Promise<number> {
    const [row] = await db
      .select({ total: sql<number>`count(*)::int` })
      .from(pushSubscriptions)
      .where(
        and(
          eq(pushSubscriptions.organizationId, auth.organizationId),
          eq(pushSubscriptions.userId, auth.user.id),
        ),
      );
    return Number(row?.total ?? 0);
  }

  async function preferences(auth: AuthContext): Promise<NotificationPreferencesResponse> {
    const [row] = await db
      .select()
      .from(notificationPreferences)
      .where(
        and(
          eq(notificationPreferences.organizationId, auth.organizationId),
          eq(notificationPreferences.userId, auth.user.id),
        ),
      );
    const value: NotificationPreferences = row
      ? {
          queue: row.queue,
          assignedMessage: row.assignedMessage,
          assignedToMe: row.assignedToMe,
          quietHours:
            row.quietStartMinute !== null && row.quietEndMinute !== null
              ? { start: toClock(row.quietStartMinute), end: toClock(row.quietEndMinute) }
              : null,
        }
      : DEFAULT_NOTIFICATION_PREFERENCES;
    return {
      preferences: value,
      timezone: auth.organization.timezone,
      devices: await devicesOf(auth),
    };
  }

  return {
    async vapidPublicKey(organizationId) {
      const find = async () => {
        const [row] = await db
          .select({ publicKey: pushVapidKeys.publicKey })
          .from(pushVapidKeys)
          .where(eq(pushVapidKeys.organizationId, organizationId));
        return row?.publicKey;
      };
      const existing = await find();
      if (existing) return existing;
      const keys = generateVapidKeys();
      await db
        .insert(pushVapidKeys)
        .values({
          organizationId,
          publicKey: keys.publicKey,
          privateKeyEncrypted: box().encrypt(keys.privateKey, {
            organizationId,
            purpose: VAPID_SECRET_PURPOSE,
          }),
        })
        // Dua permintaan pertama bersamaan: yang kalah memakai kunci pemenang.
        .onConflictDoNothing();
      const created = await find();
      if (!created) throw new Error('Kunci VAPID tidak tersimpan');
      return created;
    },

    async subscribe(auth, input) {
      const url = checkPushEndpoint(input.endpoint, extraOrigins);
      if (!url) {
        throw new AppError('VALIDATION_ERROR', {
          message: BAD_ENDPOINT,
          details: [{ location: 'body', field: 'endpoint', message: BAD_ENDPOINT }],
        });
      }
      try {
        parseP256PublicKey(input.keys.p256dh);
        parseAuthSecret(input.keys.auth);
      } catch (error) {
        if (!(error instanceof PushKeyError)) throw error;
        throw new AppError('VALIDATION_ERROR', {
          message: BAD_KEYS,
          details: [{ location: 'body', field: 'keys', message: BAD_KEYS }],
        });
      }
      const keysEncrypted = box().encrypt(
        JSON.stringify({ p256dh: input.keys.p256dh, auth: input.keys.auth }),
        {
          organizationId: auth.organizationId,
          purpose: SUBSCRIPTION_SECRET_PURPOSE,
          subjectId: auth.user.id,
        },
      );
      return db.transaction(async (tx) => {
        // Langganan hanya untuk sesi yang SEKARANG masih berlaku (bukan sesi yang baru dicabut).
        await assertActorStillAuthorized(tx, auth, 'inbox.view');
        const [row] = await tx
          .insert(pushSubscriptions)
          .values({
            organizationId: auth.organizationId,
            userId: auth.user.id,
            sessionId: auth.sessionRef,
            endpoint: url.href,
            keysEncrypted,
          })
          .onConflictDoUpdate({
            // Browser yang sama dipakai pengguna/sesi lain → langganan pindah ke pemanggil.
            target: pushSubscriptions.endpoint,
            set: {
              organizationId: auth.organizationId,
              userId: auth.user.id,
              sessionId: auth.sessionRef,
              keysEncrypted,
              lastSuccessAt: null,
            },
          })
          .returning({ id: pushSubscriptions.id, createdAt: pushSubscriptions.createdAt });
        if (!row) throw new Error('Langganan tidak tersimpan');
        // Maks. N perangkat per pengguna: yang tertua dilepas.
        const keep = tx
          .select({ id: pushSubscriptions.id })
          .from(pushSubscriptions)
          .where(
            and(
              eq(pushSubscriptions.organizationId, auth.organizationId),
              eq(pushSubscriptions.userId, auth.user.id),
            ),
          )
          .orderBy(desc(pushSubscriptions.updatedAt), desc(pushSubscriptions.id))
          .limit(PUSH_SUBSCRIPTIONS_PER_USER_MAX);
        await tx
          .delete(pushSubscriptions)
          .where(
            and(
              eq(pushSubscriptions.organizationId, auth.organizationId),
              eq(pushSubscriptions.userId, auth.user.id),
              notInArray(pushSubscriptions.id, keep),
            ),
          );
        return row;
      });
    },

    async unsubscribe(auth, endpoint) {
      const deleted = await db
        .delete(pushSubscriptions)
        .where(
          and(
            eq(pushSubscriptions.organizationId, auth.organizationId),
            eq(pushSubscriptions.userId, auth.user.id),
            eq(pushSubscriptions.endpoint, endpoint),
          ),
        )
        .returning({ id: pushSubscriptions.id });
      return deleted.length > 0;
    },

    preferences,

    async updatePreferences(auth, input) {
      const values = {
        queue: input.queue,
        assignedMessage: input.assignedMessage,
        assignedToMe: input.assignedToMe,
        quietStartMinute: input.quietHours ? toMinute(input.quietHours.start) : null,
        quietEndMinute: input.quietHours ? toMinute(input.quietHours.end) : null,
      };
      await db
        .insert(notificationPreferences)
        .values({ organizationId: auth.organizationId, userId: auth.user.id, ...values })
        .onConflictDoUpdate({ target: notificationPreferences.userId, set: values });
      return preferences(auth);
    },

    async settings(organizationId) {
      const [row] = await db
        .select({ preview: organizations.notificationPreview })
        .from(organizations)
        .where(eq(organizations.id, organizationId));
      return { preview: row?.preview ?? false };
    },

    async updateSettings(auth, client, input) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'organization.manage');
        const [current] = await tx
          .select({ preview: organizations.notificationPreview })
          .from(organizations)
          .where(eq(organizations.id, auth.organizationId))
          .for('update');
        if (!current || current.preview === input.preview) return;
        await tx
          .update(organizations)
          .set({ notificationPreview: input.preview })
          .where(eq(organizations.id, auth.organizationId));
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.notificationSettingsUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          metadata: { previous: { preview: current.preview }, preview: input.preview },
          client,
        });
      });
      return { preview: input.preview };
    },

    async test(auth) {
      const devices = await devicesOf(auth);
      if (devices > 0) {
        await notifications.enqueue({
          organizationId: auth.organizationId,
          kind: 'test',
          userId: auth.user.id,
        });
      }
      return devices;
    },
  };
}
