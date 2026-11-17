import {
  AppError,
  parseWebhookUrl,
  secretTail,
  sendTelegramMessage,
  type Lookup,
  type SecretBox,
} from '@balesin/core';
import {
  CONNECTOR_HEADER_PURPOSE,
  TELEGRAM_TOKEN_PURPOSE,
  broadcastConnectors,
  broadcastSettings,
  loadBroadcastSettings,
  organizations,
  telegramAlarmSettings,
  users,
  type BroadcastConnectorRow,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  BROADCAST_CONNECTOR_TEST_MESSAGES,
  TELEGRAM_TEST_MESSAGES,
  type BroadcastConnector,
  type BroadcastConnectorTestCode,
  type BroadcastConnectorTestResponse,
  type BroadcastSettings,
  type BroadcastSettingsValues,
  type CreateBroadcastConnectorRequest,
  type IdentityConfirmation,
  type TelegramAlarmSettings,
  type TelegramTestCode,
  type UpdateBroadcastConnectorRequest,
  type UpdateBroadcastSettingsRequest,
  type UpdateTelegramAlarmRequest,
} from '@balesin/shared';
import { and, asc, count, eq } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';
import { requireIdentityConfirmation } from '../two-factor/require-confirmation';
import type { TwoFactorContext, TwoFactorService } from '../two-factor/two-factor.service';
import { fetchConnectorTable } from './connector-source';

/**
 * Pengaturan broadcast (ambang persetujuan, cadangan kuota CS, rem otomatis, tarif), konektor REST
 * sumber penerima, dan alarm Telegram (Fase 4, PENGATURAN-UI). Semua rahasia (header konektor, token
 * bot) dienkripsi SecretBox dan TIDAK PERNAH dikirim balik (hanya 4 karakter terakhir).
 *
 *  - Pengaturan = `sending.limits.manage` + konfirmasi identitas; MELONGGARKAN pelindung (ambang naik,
 *    cadangan turun, rem otomatis dimatikan/dilonggarkan, kecepatan maksimal naik) hanya Owner.
 *  - Konektor & Telegram = `integrations.manage`; mengatur/mengganti rahasia, mengubah URL konektor
 *    yang berheader, mengganti tujuan alarm, atau menghapus alarm = konfirmasi identitas.
 */

export interface BroadcastSettingsServiceDeps {
  db: Database;
  secretBox: SecretBox | null;
  twoFactor: Pick<TwoFactorService, 'confirmIdentity'>;
  accessDenied: AccessDeniedRecorder;
  /** HANYA tes: server Telegram tiruan di loopback. */
  telegramBaseUrl?: string;
  /** HANYA tes: konektor ke server tiruan 127.0.0.1. */
  allowLoopback?: boolean;
  lookup?: Lookup;
  now?: () => Date;
}

export interface SettingsContext extends TwoFactorContext {
  client: ClientInfo;
}

const MAX_CONNECTORS = 20;
const notFound = () => new AppError('NOT_FOUND', { message: 'Konektor tidak ditemukan.' });
const noSecretBox = () =>
  new AppError('SERVICE_UNAVAILABLE', {
    message:
      'Rahasia tidak bisa disimpan/dibuka di server. Hubungi admin untuk memeriksa BALESIN_MASTER_KEY.',
  });

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return '';
  }
}

async function privateCidrsOf(db: DbExecutor, organizationId: string): Promise<string[]> {
  const [org] = await db
    .select({ cidrs: organizations.webhookPrivateCidrs })
    .from(organizations)
    .where(eq(organizations.id, organizationId));
  return org?.cidrs ?? [];
}

/** Rem/ambang yang dilonggarkan (perbandingan nilai baru dengan lama). */
export function loosenedFields(
  before: BroadcastSettingsValues,
  after: BroadcastSettingsValues,
): string[] {
  const fields: string[] = [];
  if (after.approvalThreshold > before.approvalThreshold) fields.push('approvalThreshold');
  if (after.maxRatePerSecond > before.maxRatePerSecond) fields.push('maxRatePerSecond');
  if (after.quotaReservePercent < before.quotaReservePercent) fields.push('quotaReservePercent');
  const a = after.autoBrake;
  const b = before.autoBrake;
  if (!a.enabled && b.enabled) fields.push('autoBrake.enabled');
  if (a.failureSpikePercent > b.failureSpikePercent) fields.push('autoBrake.failureSpikePercent');
  if (a.failureSpikeMinSample > b.failureSpikeMinSample) {
    fields.push('autoBrake.failureSpikeMinSample');
  }
  if (a.spikeMultiplier > b.spikeMultiplier) fields.push('autoBrake.spikeMultiplier');
  if (a.spikeMinPerMinute > b.spikeMinPerMinute) fields.push('autoBrake.spikeMinPerMinute');
  if (a.spikeAbsolutePerMinute > b.spikeAbsolutePerMinute) {
    fields.push('autoBrake.spikeAbsolutePerMinute');
  }
  return fields;
}

function changedFields(before: BroadcastSettingsValues, after: BroadcastSettingsValues): string[] {
  const fields: string[] = [];
  for (const key of ['approvalThreshold', 'maxRatePerSecond', 'quotaReservePercent'] as const) {
    if (before[key] !== after[key]) fields.push(key);
  }
  for (const key of Object.keys(
    after.autoBrake,
  ) as (keyof BroadcastSettingsValues['autoBrake'])[]) {
    if (before.autoBrake[key] !== after.autoBrake[key]) fields.push(`autoBrake.${key}`);
  }
  if (JSON.stringify(before.rates) !== JSON.stringify(after.rates)) fields.push('rates');
  return fields;
}

export function createBroadcastSettingsService(deps: BroadcastSettingsServiceDeps) {
  const { db, secretBox, twoFactor, accessDenied } = deps;
  const now = deps.now ?? (() => new Date());

  async function settingsView(executor: DbExecutor, organizationId: string) {
    const values = await loadBroadcastSettings(executor, organizationId);
    const [row] = await executor
      .select({
        updatedAt: broadcastSettings.updatedAt,
        userId: users.id,
        userName: users.name,
      })
      .from(broadcastSettings)
      .leftJoin(
        users,
        and(
          eq(users.organizationId, broadcastSettings.organizationId),
          eq(users.id, broadcastSettings.updatedByUserId),
        ),
      )
      .where(eq(broadcastSettings.organizationId, organizationId));
    const settings: BroadcastSettings = {
      ...values,
      updatedAt: row?.updatedAt.toISOString() ?? null,
      updatedBy: row?.userId && row.userName ? { id: row.userId, name: row.userName } : null,
    };
    return settings;
  }

  function connectorView(row: BroadcastConnectorRow): BroadcastConnector {
    const code = row.lastTestCode as BroadcastConnectorTestCode | null;
    return {
      id: row.id,
      name: row.name,
      url: row.url,
      authHeaderName: row.authHeaderName,
      authHeaderTail: row.authHeaderTail,
      itemsPath: row.itemsPath,
      phoneField: row.phoneField,
      lastTest:
        row.lastTestOk !== null && row.lastTestedAt && code
          ? {
              ok: row.lastTestOk,
              code,
              message:
                BROADCAST_CONNECTOR_TEST_MESSAGES[code] ??
                BROADCAST_CONNECTOR_TEST_MESSAGES.network,
              items: row.lastTestItems,
              at: row.lastTestedAt.toISOString(),
            }
          : null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  async function connectorRow(organizationId: string, id: string) {
    const [row] = await db
      .select()
      .from(broadcastConnectors)
      .where(
        and(eq(broadcastConnectors.organizationId, organizationId), eq(broadcastConnectors.id, id)),
      )
      .limit(1);
    if (!row) throw notFound();
    return row;
  }

  async function assertUrl(organizationId: string, url: string) {
    const parsed = parseWebhookUrl(url, await privateCidrsOf(db, organizationId), {
      allowLoopback: deps.allowLoopback ?? false,
    });
    if ('error' in parsed) {
      const code: BroadcastConnectorTestCode =
        parsed.error === 'blocked_address' ||
        parsed.error === 'private_not_allowed' ||
        parsed.error === 'https_required'
          ? parsed.error
          : 'invalid_url';
      throw new AppError('VALIDATION_ERROR', {
        message: BROADCAST_CONNECTOR_TEST_MESSAGES[code],
        details: [
          { location: 'body', field: 'url', message: BROADCAST_CONNECTOR_TEST_MESSAGES[code] },
        ],
      });
    }
  }

  function sealHeader(organizationId: string, connectorId: string, value: string) {
    if (!secretBox) throw noSecretBox();
    return secretBox.encrypt(value, {
      organizationId,
      purpose: CONNECTOR_HEADER_PURPOSE,
      subjectId: connectorId,
    });
  }

  /** Header konektor yang sudah dibuka (untuk fetch); `null` = tanpa header. */
  function openHeader(row: BroadcastConnectorRow): { name: string; value: string } | null {
    if (!row.authHeaderName || !row.authHeaderValueEncrypted) return null;
    if (!secretBox) throw noSecretBox();
    try {
      return {
        name: row.authHeaderName,
        value: secretBox.decrypt(row.authHeaderValueEncrypted, {
          organizationId: row.organizationId,
          purpose: CONNECTOR_HEADER_PURPOSE,
          subjectId: row.id,
        }),
      };
    } catch {
      throw noSecretBox();
    }
  }

  async function telegramView(organizationId: string): Promise<TelegramAlarmSettings> {
    const [row] = await db
      .select()
      .from(telegramAlarmSettings)
      .where(eq(telegramAlarmSettings.organizationId, organizationId));
    if (!row) {
      return {
        configured: false,
        enabled: false,
        tokenTail: null,
        chatId: null,
        lastTest: null,
        updatedAt: null,
      };
    }
    const code = row.lastTestCode as TelegramTestCode | null;
    return {
      configured: true,
      enabled: row.enabled,
      tokenTail: row.botTokenTail,
      chatId: row.telegramChat,
      lastTest:
        row.lastTestOk !== null && row.lastTestedAt && code
          ? {
              ok: row.lastTestOk,
              code,
              message: TELEGRAM_TEST_MESSAGES[code] ?? TELEGRAM_TEST_MESSAGES.unknown,
              at: row.lastTestedAt.toISOString(),
            }
          : null,
      updatedAt: row.updatedAt.toISOString(),
    };
  }

  return {
    getSettings: (organizationId: string) => settingsView(db, organizationId),

    async updateSettings(
      auth: AuthContext,
      input: UpdateBroadcastSettingsRequest & { confirmation?: IdentityConfirmation },
      context: SettingsContext,
    ): Promise<BroadcastSettings> {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        input.confirmation,
        'broadcast_settings.update',
        context,
        'Masukkan password (dan kode verifikasi) untuk mengubah pengaturan broadcast.',
      );
      const { confirmation: _confirmation, ...values } = input;
      const next: BroadcastSettingsValues = values;
      return db.transaction(async (tx) => {
        const { role } = await assertActorStillAuthorized(tx, auth, 'sending.limits.manage');
        const before = await loadBroadcastSettings(tx, auth.organizationId);
        const loosened = loosenedFields(before, next);
        if (loosened.length > 0 && role !== 'owner') {
          await forbidByRule(accessDenied, {
            auth,
            rule: ACCESS_RULES.broadcastSettingsLoosen,
            client: context.client,
            details: { fields: loosened.join(',').slice(0, 200) },
            message:
              'Hanya Owner yang boleh melonggarkan pelindung broadcast (menaikkan ambang persetujuan/kecepatan, menurunkan cadangan kuota, atau melonggarkan rem otomatis).',
          });
        }
        const row = {
          approvalThreshold: next.approvalThreshold,
          maxRatePerSecond: next.maxRatePerSecond,
          quotaReservePercent: next.quotaReservePercent,
          autoBrakeEnabled: next.autoBrake.enabled,
          failureSpikePercent: next.autoBrake.failureSpikePercent,
          failureSpikeMinSample: next.autoBrake.failureSpikeMinSample,
          spikeMultiplier: next.autoBrake.spikeMultiplier,
          spikeMinPerMinute: next.autoBrake.spikeMinPerMinute,
          spikeAbsolutePerMinute: next.autoBrake.spikeAbsolutePerMinute,
          rates: next.rates,
          updatedByUserId: auth.user.id,
        };
        await tx
          .insert(broadcastSettings)
          .values({ organizationId: auth.organizationId, ...row })
          .onConflictDoUpdate({ target: broadcastSettings.organizationId, set: row });
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.broadcastSettingsUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          metadata: {
            changedFields: changedFields(before, next),
            loosened,
            approvalThreshold: next.approvalThreshold,
            autoBrakeEnabled: next.autoBrake.enabled,
            actorRole: role,
          },
          client: context.client,
        });
        return settingsView(tx, auth.organizationId);
      });
    },

    // ── Konektor ────────────────────────────────────────────────────────────

    async listConnectors(organizationId: string): Promise<BroadcastConnector[]> {
      const rows = await db
        .select()
        .from(broadcastConnectors)
        .where(eq(broadcastConnectors.organizationId, organizationId))
        .orderBy(asc(broadcastConnectors.name));
      return rows.map(connectorView);
    },

    async connectorOptions(organizationId: string) {
      return db
        .select({ id: broadcastConnectors.id, name: broadcastConnectors.name })
        .from(broadcastConnectors)
        .where(eq(broadcastConnectors.organizationId, organizationId))
        .orderBy(asc(broadcastConnectors.name));
    },

    async createConnector(
      auth: AuthContext,
      input: CreateBroadcastConnectorRequest,
      context: SettingsContext,
    ): Promise<BroadcastConnector> {
      if (input.auth) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          input.confirmation,
          'broadcast_connector.create',
          context,
          'Masukkan password (dan kode verifikasi) untuk menyimpan header autentikasi konektor.',
        );
      }
      await assertUrl(auth.organizationId, input.url);
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [total] = await tx
          .select({ value: count() })
          .from(broadcastConnectors)
          .where(eq(broadcastConnectors.organizationId, auth.organizationId));
        if ((total?.value ?? 0) >= MAX_CONNECTORS) {
          throw new AppError('CONFLICT', { message: `Maksimal ${MAX_CONNECTORS} konektor.` });
        }
        const [created] = await tx
          .insert(broadcastConnectors)
          .values({
            organizationId: auth.organizationId,
            name: input.name,
            url: input.url,
            itemsPath: input.itemsPath ?? '',
            phoneField: input.phoneField,
            createdByUserId: auth.user.id,
            updatedByUserId: auth.user.id,
          })
          .returning();
        if (!created) throw new Error('INSERT konektor tidak mengembalikan baris');
        let row = created;
        if (input.auth) {
          const [updated] = await tx
            .update(broadcastConnectors)
            .set({
              authHeaderName: input.auth.headerName,
              authHeaderValueEncrypted: sealHeader(
                auth.organizationId,
                created.id,
                input.auth.headerValue,
              ),
              authHeaderTail: secretTail(input.auth.headerValue) ?? '',
            })
            .where(eq(broadcastConnectors.id, created.id))
            .returning();
          if (updated) row = updated;
        }
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.broadcastConnectorCreated,
          targetType: 'broadcast_connector',
          targetId: row.id,
          metadata: { name: row.name, host: hostOf(row.url), withAuth: input.auth !== null },
          client: context.client,
        });
        return connectorView(row);
      });
    },

    async updateConnector(
      auth: AuthContext,
      id: string,
      input: UpdateBroadcastConnectorRequest,
      context: SettingsContext,
    ): Promise<BroadcastConnector> {
      const current = await connectorRow(auth.organizationId, id);
      const urlChanged = input.url !== undefined && input.url !== current.url;
      // Header baru, atau URL baru untuk konektor berheader (header ikut terkirim ke tujuan baru).
      if (input.auth || (urlChanged && current.authHeaderName && input.auth !== null)) {
        await requireIdentityConfirmation(
          twoFactor,
          auth,
          input.confirmation,
          'broadcast_connector.update',
          context,
          'Masukkan password (dan kode verifikasi) untuk mengubah header atau alamat konektor.',
        );
      }
      if (input.url !== undefined) await assertUrl(auth.organizationId, input.url);
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const changes: Partial<typeof broadcastConnectors.$inferInsert> = {
          updatedByUserId: auth.user.id,
        };
        const fields: string[] = [];
        if (input.name !== undefined && input.name !== current.name) {
          changes.name = input.name;
          fields.push('name');
        }
        if (urlChanged && input.url !== undefined) {
          changes.url = input.url;
          fields.push('url');
        }
        if (input.itemsPath !== undefined && input.itemsPath !== current.itemsPath) {
          changes.itemsPath = input.itemsPath;
          fields.push('itemsPath');
        }
        if (input.phoneField !== undefined && input.phoneField !== current.phoneField) {
          changes.phoneField = input.phoneField;
          fields.push('phoneField');
        }
        if (input.auth === null && current.authHeaderName) {
          changes.authHeaderName = null;
          changes.authHeaderValueEncrypted = null;
          changes.authHeaderTail = null;
          fields.push('auth');
        } else if (input.auth) {
          changes.authHeaderName = input.auth.headerName;
          changes.authHeaderValueEncrypted = sealHeader(
            auth.organizationId,
            current.id,
            input.auth.headerValue,
          );
          changes.authHeaderTail = secretTail(input.auth.headerValue) ?? '';
          fields.push('auth');
        }
        if (fields.length > 0) {
          // Hasil tes lama tidak berlaku untuk konfigurasi baru.
          changes.lastTestOk = null;
          changes.lastTestCode = null;
          changes.lastTestItems = null;
          changes.lastTestedAt = null;
        }
        const [row] = await tx
          .update(broadcastConnectors)
          .set(changes)
          .where(
            and(
              eq(broadcastConnectors.organizationId, auth.organizationId),
              eq(broadcastConnectors.id, current.id),
            ),
          )
          .returning();
        if (!row) throw notFound();
        if (fields.length > 0) {
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.broadcastConnectorUpdated,
            targetType: 'broadcast_connector',
            targetId: row.id,
            metadata: {
              changedFields: fields,
              host: hostOf(row.url),
              ...(urlChanged ? { previousHost: hostOf(current.url) } : {}),
            },
            client: context.client,
          });
        }
        return connectorView(row);
      });
    },

    async deleteConnector(auth: AuthContext, id: string, client: ClientInfo): Promise<void> {
      const current = await connectorRow(auth.organizationId, id);
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        await tx
          .delete(broadcastConnectors)
          .where(
            and(
              eq(broadcastConnectors.organizationId, auth.organizationId),
              eq(broadcastConnectors.id, current.id),
            ),
          );
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.broadcastConnectorDeleted,
          targetType: 'broadcast_connector',
          targetId: current.id,
          metadata: { name: current.name, host: hostOf(current.url) },
          client,
        });
      });
    },

    /** Ambil data konektor (dipakai tes koneksi & impor penerima). */
    async fetchConnector(organizationId: string, id: string) {
      const row = await connectorRow(organizationId, id);
      const result = await fetchConnectorTable({
        url: row.url,
        header: openHeader(row),
        itemsPath: row.itemsPath,
        phoneField: row.phoneField,
        privateCidrs: await privateCidrsOf(db, organizationId),
        ...(deps.allowLoopback ? { allowLoopback: true } : {}),
        ...(deps.lookup ? { lookup: deps.lookup } : {}),
      });
      return { row, result };
    },

    async testConnector(
      organizationId: string,
      id: string,
    ): Promise<BroadcastConnectorTestResponse> {
      const { row, result } = await this.fetchConnector(organizationId, id);
      const code: BroadcastConnectorTestCode = result.ok ? 'ok' : result.code;
      const items = result.ok ? result.items : null;
      await db
        .update(broadcastConnectors)
        .set({
          lastTestOk: result.ok,
          lastTestCode: code,
          lastTestItems: items,
          lastTestedAt: now(),
        })
        .where(
          and(
            eq(broadcastConnectors.organizationId, organizationId),
            eq(broadcastConnectors.id, row.id),
          ),
        );
      return {
        ok: result.ok,
        code,
        message: BROADCAST_CONNECTOR_TEST_MESSAGES[code],
        items,
        columns: result.ok ? result.table.columns : [],
      };
    },

    // ── Alarm Telegram ──────────────────────────────────────────────────────

    getTelegram: telegramView,

    async updateTelegram(
      auth: AuthContext,
      input: UpdateTelegramAlarmRequest,
      context: SettingsContext,
    ): Promise<TelegramAlarmSettings> {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        input.confirmation,
        'alarm_telegram.update',
        context,
        'Masukkan password (dan kode verifikasi) untuk mengatur alarm Telegram.',
      );
      if (!secretBox) throw noSecretBox();
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const [current] = await tx
          .select()
          .from(telegramAlarmSettings)
          .where(eq(telegramAlarmSettings.organizationId, auth.organizationId))
          .for('update');
        if (!current && !input.botToken) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Isi token bot Telegram.',
            details: [{ location: 'body', field: 'botToken', message: 'Token bot wajib diisi.' }],
          });
        }
        const token = input.botToken
          ? {
              botTokenEncrypted: secretBox.encrypt(input.botToken, {
                organizationId: auth.organizationId,
                purpose: TELEGRAM_TOKEN_PURPOSE,
                subjectId: auth.organizationId,
              }),
              botTokenTail: secretTail(input.botToken) ?? '',
            }
          : null;
        const chatChanged = !current || current.telegramChat !== input.chatId;
        const values = {
          enabled: input.enabled,
          telegramChat: input.chatId,
          updatedByUserId: auth.user.id,
          ...(token ?? {}),
          ...(token || chatChanged
            ? { lastTestOk: null, lastTestCode: null, lastTestedAt: null }
            : {}),
        };
        if (current) {
          await tx
            .update(telegramAlarmSettings)
            .set(values)
            .where(eq(telegramAlarmSettings.organizationId, auth.organizationId));
        } else if (token) {
          await tx
            .insert(telegramAlarmSettings)
            .values({ organizationId: auth.organizationId, ...values, ...token });
        }
        await recordAudit(tx, {
          organizationId: auth.organizationId,
          actorUserId: auth.user.id,
          action: AUDIT_ACTIONS.telegramAlarmUpdated,
          targetType: 'organization',
          targetId: auth.organizationId,
          metadata: { tokenChanged: token !== null, chatChanged, enabled: input.enabled },
          client: context.client,
        });
      });
      return telegramView(auth.organizationId);
    },

    async deleteTelegram(
      auth: AuthContext,
      confirmation: IdentityConfirmation | undefined,
      context: SettingsContext,
    ): Promise<TelegramAlarmSettings> {
      await requireIdentityConfirmation(
        twoFactor,
        auth,
        confirmation,
        'alarm_telegram.delete',
        context,
        'Masukkan password (dan kode verifikasi) untuk menghapus alarm Telegram.',
      );
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, 'integrations.manage');
        const deleted = await tx
          .delete(telegramAlarmSettings)
          .where(eq(telegramAlarmSettings.organizationId, auth.organizationId))
          .returning({ id: telegramAlarmSettings.organizationId });
        if (deleted.length > 0) {
          await recordAudit(tx, {
            organizationId: auth.organizationId,
            actorUserId: auth.user.id,
            action: AUDIT_ACTIONS.telegramAlarmDeleted,
            targetType: 'organization',
            targetId: auth.organizationId,
            client: context.client,
          });
        }
      });
      return telegramView(auth.organizationId);
    },

    async testTelegram(auth: AuthContext) {
      const [row] = await db
        .select({
          token: telegramAlarmSettings.botTokenEncrypted,
          chat: telegramAlarmSettings.telegramChat,
          productName: organizations.productName,
          name: organizations.name,
        })
        .from(telegramAlarmSettings)
        .innerJoin(organizations, eq(organizations.id, telegramAlarmSettings.organizationId))
        .where(eq(telegramAlarmSettings.organizationId, auth.organizationId));
      if (!row) {
        return {
          ok: false,
          code: 'not_configured' as const,
          message: TELEGRAM_TEST_MESSAGES.not_configured,
        };
      }
      if (!secretBox) throw noSecretBox();
      let token: string;
      try {
        token = secretBox.decrypt(row.token, {
          organizationId: auth.organizationId,
          purpose: TELEGRAM_TOKEN_PURPOSE,
          subjectId: auth.organizationId,
        });
      } catch {
        throw noSecretBox();
      }
      const product = row.productName ?? row.name;
      const result = await sendTelegramMessage({
        token,
        chatId: row.chat,
        text: [
          `[${product}] Tes alarm`,
          `Pesan tes: alarm sistem ${product} akan dikirim ke chat ini.`,
        ].join('\n'),
        ...(deps.telegramBaseUrl ? { baseUrl: deps.telegramBaseUrl } : {}),
      });
      const code: TelegramTestCode = result.ok ? 'ok' : result.code;
      await db
        .update(telegramAlarmSettings)
        .set({ lastTestOk: result.ok, lastTestCode: code, lastTestedAt: now() })
        .where(eq(telegramAlarmSettings.organizationId, auth.organizationId));
      return { ok: result.ok, code, message: TELEGRAM_TEST_MESSAGES[code] };
    },
  };
}

export type BroadcastSettingsService = ReturnType<typeof createBroadcastSettingsService>;
