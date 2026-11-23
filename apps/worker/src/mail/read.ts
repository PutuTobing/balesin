import {
  classifyMailAttachmentContent,
  classifyMailImapError,
  decodeTransferEncoding,
  defaultMailImapConnector,
  hasMailImapActions,
  mailAttachmentParts,
  mailAttachmentRiskOf,
  mailBodyTextParts,
  mailSenderWarnings,
  openMailAccountSecret,
  parseMailBody,
  parseMailTextPart,
  type ImapPolicy,
  type Logger,
  type MailBodyStructureNode,
  type MailEventPublisher,
  type MailImapActions,
  type MailImapConnector,
  type MailImapSession,
  type MediaStore,
  type SecretBox,
} from '@balesin/core';
import {
  channels,
  mailAccounts,
  mailAttachments,
  mailFolders,
  mailIdentities,
  mailMessageBodies,
  mailMessages,
  mailSettings,
  organizations,
  users,
  type Database,
  type MailAccountRow,
} from '@balesin/db';
import {
  MAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES,
  MAIL_BODY_FETCH_MAX_BYTES,
  MAIL_CACHE_RETENTION_DAYS,
  MAIL_LINK_WARNING_PATH,
  MAIL_TEXT_PART_MAX_BYTES,
} from '@balesin/shared';
import { and, eq, isNull, sql } from 'drizzle-orm';

/**
 * Isi & lampiran modul Email (KONTRAK-API-EMAIL §8, §11 `mail-fetch-body`/`mail-fetch-attachment`).
 * Diambil SAAT DIBUKA lewat sambungan kerja akun (sewa `withWorkSlot`, maks. 2 sambungan per akun).
 *
 *  - Isi: `BODY.PEEK[]` per potongan ≤ 25 MB → `parseMailBody` (penjaga kerumitan → sanitasi
 *    tampilan → penanda gambar), lampiran dari BODYSTRUCTURE (risiko nama/jenis), gambar inline raster
 *    ≤ 5 MB disimpan, peringatan pengirim/tautan/lampiran. > 25 MB → hanya bagian teks (`too_large`).
 *  - Lampiran: `BODY.PEEK[<bagian>]` ≤ 50 MB → risiko dipastikan dari ISI; `blocked` tidak disimpan.
 *  Log: ID + kode saja (tanpa subjek/alamat/nama berkas/URL).
 */

export interface MailReaderDeps {
  db: Database;
  logger: Logger;
  secretBox: SecretBox | null;
  publisher: MailEventPublisher;
  store: MediaStore | null;
  /** Origin web (`APP_URL`) untuk halaman peringatan tautan menipu. */
  appUrl: string;
  policyFor(organizationId: string): Promise<ImapPolicy>;
  connector?: MailImapConnector;
  now?: () => Date;
}

const STOPPED = new Set(['paused', 'auth_failed', 'owner_inactive', 'deleting']);
const DAY_MS = 24 * 60 * 60 * 1000;
/** Batas mentah bagian lampiran (base64 ≈ 4/3 × isi). */
const RAW_ATTACHMENT_MAX = Math.ceil(MAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES * 1.4) + 64 * 1024;

export class MailReadError extends Error {
  constructor(readonly code: string) {
    super(code);
  }
}

function domainOf(address: string): string {
  return address.slice(address.lastIndexOf('@') + 1).toLowerCase();
}

export function createMailReader(deps: MailReaderDeps) {
  const { db, logger, publisher } = deps;
  const now = deps.now ?? (() => new Date());
  const connector = deps.connector ?? defaultMailImapConnector;
  const origin = deps.appUrl.replace(/\/+$/, '');
  const linkWarningHref = (target: string, shown: string) =>
    `${origin}${MAIL_LINK_WARNING_PATH}?ke=${encodeURIComponent(target)}&tampil=${encodeURIComponent(shown)}`;

  async function openSession(row: MailAccountRow): Promise<MailImapSession & MailImapActions> {
    if (!deps.secretBox || !row.imapPasswordEncrypted)
      throw new MailReadError('secret_unavailable');
    let password;
    try {
      password = openMailAccountSecret(
        deps.secretBox,
        row,
        'imapPassword',
        row.imapPasswordEncrypted,
      );
    } catch {
      throw new MailReadError('secret_unavailable');
    }
    let session: MailImapSession;
    try {
      session = await connector(
        {
          host: row.imapHost ?? '',
          port: row.imapPort ?? 993,
          security: row.imapSecurity === 'starttls' ? 'starttls' : 'ssl',
          username: row.imapUsername ?? '',
          password,
        },
        await deps.policyFor(row.organizationId),
      );
    } catch (error) {
      throw new MailReadError(classifyMailImapError(error).code);
    }
    if (!hasMailImapActions(session)) {
      await session.close().catch(() => undefined);
      throw new MailReadError('unknown');
    }
    return session;
  }

  async function retentionDays(organizationId: string): Promise<number> {
    const [row] = await db
      .select({ days: mailSettings.cacheRetentionDays })
      .from(mailSettings)
      .where(eq(mailSettings.organizationId, organizationId))
      .limit(1);
    return row?.days ?? MAIL_CACHE_RETENTION_DAYS.default;
  }

  /** Domain & nama yang dilindungi untuk peringatan penyamaran (kontrak §8). */
  async function senderContext(organizationId: string) {
    const [accountRows, identityRows, channelRows, userRows, orgRows] = await Promise.all([
      db
        .select({ address: mailAccounts.emailAddress })
        .from(mailAccounts)
        .where(
          and(eq(mailAccounts.organizationId, organizationId), isNull(mailAccounts.deletedAt)),
        ),
      db
        .select({ address: mailIdentities.address })
        .from(mailIdentities)
        .where(eq(mailIdentities.organizationId, organizationId)),
      db
        .select({ address: channels.emailAddress, aliases: channels.emailAliases })
        .from(channels)
        .where(
          and(
            eq(channels.organizationId, organizationId),
            eq(channels.type, 'email'),
            isNull(channels.deletedAt),
          ),
        ),
      db
        .select({ name: users.name })
        .from(users)
        .where(and(eq(users.organizationId, organizationId), isNull(users.disabledAt)))
        .limit(1_000),
      db
        .select({ name: organizations.name })
        .from(organizations)
        .where(eq(organizations.id, organizationId))
        .limit(1),
    ]);
    const addresses = [
      ...accountRows.map((row) => row.address),
      ...identityRows.map((row) => row.address),
      ...channelRows.flatMap((row) => [row.address ?? '', ...row.aliases]),
    ].filter((address) => address.includes('@'));
    return {
      organizationDomains: [...new Set(addresses.map(domainOf))],
      protectedNames: [...userRows.map((row) => row.name), ...orgRows.map((row) => row.name)],
    };
  }

  async function loadMessage(organizationId: string, messageId: string) {
    const [row] = await db
      .select({ message: mailMessages, folder: mailFolders, account: mailAccounts })
      .from(mailMessages)
      .innerJoin(
        mailFolders,
        and(
          eq(mailFolders.organizationId, mailMessages.organizationId),
          eq(mailFolders.id, mailMessages.folderId),
        ),
      )
      .innerJoin(
        mailAccounts,
        and(
          eq(mailAccounts.organizationId, mailMessages.organizationId),
          eq(mailAccounts.id, mailMessages.accountId),
        ),
      )
      .where(and(eq(mailMessages.organizationId, organizationId), eq(mailMessages.id, messageId)))
      .limit(1);
    return row ?? null;
  }

  async function markBodyError(organizationId: string, accountId: string, messageId: string) {
    await db
      .update(mailMessages)
      .set({ bodyState: 'error' })
      .where(and(eq(mailMessages.organizationId, organizationId), eq(mailMessages.id, messageId)));
    await publisher.publish([
      {
        organizationId,
        accountId,
        event: { type: 'mail.message.updated', accountId, messageId, fields: ['body'] },
      },
    ]);
  }

  async function fetchBody(payload: {
    organizationId: string;
    accountId: string;
    messageId: string;
  }): Promise<{ status: 'ready' | 'too_large' | 'skipped' | 'failed'; code?: string }> {
    const loaded = await loadMessage(payload.organizationId, payload.messageId);
    if (!loaded || loaded.account.id !== payload.accountId || loaded.account.deletedAt !== null) {
      return { status: 'skipped' };
    }
    const { message, folder, account } = loaded;
    if (message.bodyState === 'ready' || message.bodyState === 'too_large') {
      const [existing] = await db
        .select({ id: mailMessageBodies.messageId })
        .from(mailMessageBodies)
        .where(eq(mailMessageBodies.messageId, message.id))
        .limit(1);
      if (existing) return { status: 'skipped' };
    }
    if (STOPPED.has(account.syncState)) {
      await markBodyError(account.organizationId, account.id, message.id);
      return { status: 'failed', code: 'account_stopped' };
    }
    let session: MailImapSession & MailImapActions;
    try {
      session = await openSession(account);
    } catch (error) {
      const code = error instanceof MailReadError ? error.code : 'unknown';
      logger.warn(
        { accountId: account.id, messageId: message.id, code },
        'Isi email gagal diambil',
      );
      throw error;
    }
    try {
      const selected = await session.select(folder.path);
      if (selected.uidValidity !== message.uidvalidity) {
        await markBodyError(account.organizationId, account.id, message.id);
        return { status: 'failed', code: 'uidvalidity_changed' };
      }
      const structure = (message.bodystructure ?? null) as MailBodyStructureNode | null;
      let body: Awaited<ReturnType<typeof parseMailBody>>;
      let state: 'ready' | 'too_large' = 'ready';
      const source =
        message.sizeBytes > MAIL_BODY_FETCH_MAX_BYTES
          ? null
          : await session.fetchSource(message.uid, MAIL_BODY_FETCH_MAX_BYTES);
      if (message.sizeBytes <= MAIL_BODY_FETCH_MAX_BYTES && source === null) {
        await markBodyError(account.organizationId, account.id, message.id);
        return { status: 'failed', code: 'message_gone' };
      }
      if (source && !source.truncated) {
        body = await parseMailBody(source.bytes, { linkWarningHref });
      } else {
        // Email > 25 MB: hanya bagian teks/HTML isi (≤ 1 MB).
        state = 'too_large';
        const parts = mailBodyTextParts(structure);
        const chosen = parts.html ?? parts.plain;
        const raw = chosen
          ? await session.fetchPart(message.uid, chosen.part ?? '1', MAIL_TEXT_PART_MAX_BYTES)
          : null;
        const text =
          chosen && raw
            ? parseMailTextPart(
                raw.bytes,
                { encoding: chosen.encoding, charset: chosen.charset, html: chosen === parts.html },
                { linkWarningHref },
              )
            : { html: null, remoteImages: [], linkWarnings: 0, htmlOmitted: false, text: null };
        body = { ...text, rawHeaders: null, inlineImages: [] };
      }

      // Lampiran (dari BODYSTRUCTURE) — risiko awal dari nama + jenis yang dinyatakan.
      const parts = mailAttachmentParts(structure);
      const retention = await retentionDays(account.organizationId);
      const at = now();
      if (parts.length > 0) {
        await db
          .insert(mailAttachments)
          .values(
            parts.map((part) => {
              const risk = mailAttachmentRiskOf(part.filename, part.declaredType);
              return {
                organizationId: account.organizationId,
                messageId: message.id,
                partId: part.partId.slice(0, 64),
                filename: part.filename,
                declaredType: part.declaredType.slice(0, 255),
                sizeBytes: Math.min(part.sizeBytes, 2_147_483_647),
                contentId: part.contentId,
                isInline: part.isInline,
                risk: risk.risk,
                riskReason: risk.reason,
              };
            }),
          )
          .onConflictDoNothing({ target: [mailAttachments.messageId, mailAttachments.partId] });
      }
      const attachmentRows = await db
        .select()
        .from(mailAttachments)
        .where(
          and(
            eq(mailAttachments.organizationId, account.organizationId),
            eq(mailAttachments.messageId, message.id),
          ),
        );
      // Gambar inline (cid) raster disimpan sekarang supaya dokumen tampilan bisa langsung memuatnya.
      if (deps.store) {
        for (const image of body.inlineImages) {
          const target = attachmentRows.find(
            (row) => row.contentId === image.contentId && row.storageKey === null,
          );
          if (!target) continue;
          const saved = await deps.store.save('mail', image.content);
          await db
            .update(mailAttachments)
            .set({
              storageKey: saved.storageKey,
              detectedType: image.contentType,
              sizeBytes: saved.sizeBytes,
              fetchedAt: at,
              expiresAt: new Date(at.getTime() + retention * DAY_MS),
            })
            .where(eq(mailAttachments.id, target.id));
        }
      }
      const context = await senderContext(account.organizationId);
      const warnings = new Set<string>(
        mailSenderWarnings(
          message.fromAddress ? { address: message.fromAddress, name: message.fromName } : null,
          context,
        ),
      );
      if (body.linkWarnings > 0) warnings.add('link_mismatch');
      if (attachmentRows.some((row) => row.risk === 'blocked'))
        warnings.add('dangerous_attachment');

      await db
        .insert(mailMessageBodies)
        .values({
          messageId: message.id,
          organizationId: account.organizationId,
          text: body.text,
          htmlSanitized: body.html,
          remoteImages: body.remoteImages,
          linkWarnings: body.linkWarnings,
          rawHeaders: body.rawHeaders,
          fetchedAt: at,
          lastOpenedAt: at,
        })
        .onConflictDoUpdate({
          target: mailMessageBodies.messageId,
          set: {
            text: body.text,
            htmlSanitized: body.html,
            remoteImages: body.remoteImages,
            linkWarnings: body.linkWarnings,
            rawHeaders: body.rawHeaders,
            fetchedAt: at,
            lastOpenedAt: at,
            updatedAt: sql`now()`,
          },
        });
      await db
        .update(mailMessages)
        .set({ bodyState: state, warnings: [...warnings] })
        .where(
          and(
            eq(mailMessages.organizationId, account.organizationId),
            eq(mailMessages.id, message.id),
          ),
        );
      await publisher.publish([
        {
          organizationId: account.organizationId,
          accountId: account.id,
          event: {
            type: 'mail.message.updated',
            accountId: account.id,
            messageId: message.id,
            fields: ['body'],
          },
        },
      ]);
      logger.info({ accountId: account.id, messageId: message.id, state }, 'Isi email diambil');
      return { status: state };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  async function failAttachment(
    organizationId: string,
    accountId: string,
    attachmentId: string,
    code: string,
  ) {
    await publisher.publish([
      {
        organizationId,
        accountId,
        event: { type: 'mail.attachment.failed', accountId, attachmentId, code },
      },
    ]);
  }

  async function fetchAttachment(payload: {
    organizationId: string;
    accountId: string;
    attachmentId: string;
  }): Promise<{ status: 'ready' | 'blocked' | 'skipped' | 'failed'; code?: string }> {
    const [attachment] = await db
      .select()
      .from(mailAttachments)
      .where(
        and(
          eq(mailAttachments.organizationId, payload.organizationId),
          eq(mailAttachments.id, payload.attachmentId),
        ),
      )
      .limit(1);
    if (!attachment) return { status: 'skipped' };
    const loaded = await loadMessage(payload.organizationId, attachment.messageId);
    if (!loaded || loaded.account.id !== payload.accountId || loaded.account.deletedAt !== null) {
      return { status: 'skipped' };
    }
    const { message, folder, account } = loaded;
    if (attachment.storageKey !== null) {
      await publisher.publish([
        {
          organizationId: account.organizationId,
          accountId: account.id,
          event: {
            type: 'mail.attachment.ready',
            accountId: account.id,
            attachmentId: attachment.id,
          },
        },
      ]);
      return { status: 'ready' };
    }
    if (!deps.store) {
      await failAttachment(
        account.organizationId,
        account.id,
        attachment.id,
        'storage_unavailable',
      );
      return { status: 'failed', code: 'storage_unavailable' };
    }
    if (attachment.risk === 'blocked') {
      await failAttachment(account.organizationId, account.id, attachment.id, 'attachment_blocked');
      return { status: 'blocked' };
    }
    if (attachment.sizeBytes > MAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES * 1.4) {
      await failAttachment(account.organizationId, account.id, attachment.id, 'too_large');
      return { status: 'failed', code: 'too_large' };
    }
    if (STOPPED.has(account.syncState)) {
      await failAttachment(account.organizationId, account.id, attachment.id, 'account_stopped');
      return { status: 'failed', code: 'account_stopped' };
    }
    const session = await openSession(account);
    try {
      const selected = await session.select(folder.path);
      if (selected.uidValidity !== message.uidvalidity) {
        await failAttachment(account.organizationId, account.id, attachment.id, 'message_gone');
        return { status: 'failed', code: 'message_gone' };
      }
      const structure = (message.bodystructure ?? null) as MailBodyStructureNode | null;
      const part = mailAttachmentParts(structure).find((item) => item.partId === attachment.partId);
      const raw = await session.fetchPart(message.uid, attachment.partId, RAW_ATTACHMENT_MAX);
      if (!raw) {
        await failAttachment(account.organizationId, account.id, attachment.id, 'message_gone');
        return { status: 'failed', code: 'message_gone' };
      }
      const bytes = decodeTransferEncoding(raw.bytes, part?.encoding ?? null);
      if (raw.truncated || bytes.length > MAIL_ATTACHMENT_DOWNLOAD_MAX_BYTES) {
        await failAttachment(account.organizationId, account.id, attachment.id, 'too_large');
        return { status: 'failed', code: 'too_large' };
      }
      const verdict = classifyMailAttachmentContent(bytes, attachment.filename);
      // Risiko tidak pernah diturunkan dari yang dinyatakan (arsip tetap `warn` walau isi tak dikenal).
      const risk =
        verdict.risk === 'blocked' || attachment.risk === 'blocked'
          ? 'blocked'
          : verdict.risk === 'warn' || attachment.risk === 'warn'
            ? 'warn'
            : 'ok';
      if (risk === 'blocked') {
        await db
          .update(mailAttachments)
          .set({ risk: 'blocked', riskReason: verdict.reason ?? attachment.riskReason })
          .where(eq(mailAttachments.id, attachment.id));
        await db
          .update(mailMessages)
          .set({
            warnings: sql`case when 'dangerous_attachment' = any(${mailMessages.warnings}) then ${mailMessages.warnings} else array_append(${mailMessages.warnings}, 'dangerous_attachment') end`,
          })
          .where(eq(mailMessages.id, message.id));
        await failAttachment(
          account.organizationId,
          account.id,
          attachment.id,
          'attachment_blocked',
        );
        return { status: 'blocked' };
      }
      const retention = await retentionDays(account.organizationId);
      const at = now();
      const saved = await deps.store.save('mail', bytes);
      const [updated] = await db
        .update(mailAttachments)
        .set({
          storageKey: saved.storageKey,
          detectedType: verdict.detectedType,
          sizeBytes: saved.sizeBytes,
          risk,
          riskReason: risk === attachment.risk ? attachment.riskReason : verdict.reason,
          fetchedAt: at,
          expiresAt: new Date(at.getTime() + retention * DAY_MS),
        })
        .where(and(eq(mailAttachments.id, attachment.id), isNull(mailAttachments.storageKey)))
        .returning({ id: mailAttachments.id });
      if (!updated) await deps.store.remove(saved.storageKey).catch(() => undefined);
      await publisher.publish([
        {
          organizationId: account.organizationId,
          accountId: account.id,
          event: {
            type: 'mail.attachment.ready',
            accountId: account.id,
            attachmentId: attachment.id,
          },
        },
      ]);
      logger.info({ accountId: account.id, attachmentId: attachment.id }, 'Lampiran email diambil');
      return { status: 'ready' };
    } finally {
      await session.close().catch(() => undefined);
    }
  }

  return { fetchBody, fetchAttachment, openSession, markBodyError, failAttachment };
}

export type MailReader = ReturnType<typeof createMailReader>;
