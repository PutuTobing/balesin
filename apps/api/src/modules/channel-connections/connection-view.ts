import { defaultTrustedAuthServIds, maskedSecret, telegramWebhookUrlUsable } from '@balesin/core';
import type { Channel, EmailMailboxState } from '@balesin/db';
import {
  CHANNEL_TYPE_AVAILABILITY,
  CONNECTION_TEST_MESSAGES,
  TELEGRAM_WEBHOOK_WARNING,
  connectionTestCodeSchema,
  imapSecuritySchema,
  emailChannelSmtpSecuritySchema,
  type ChannelStatus,
  type ConnectionChannel,
  type ConnectionChannelType,
} from '@balesin/shared';

/**
 * Bentuk channel non-WhatsApp untuk web (Fase 6). Kolom rahasia TIDAK PERNAH dibaca di sini selain
 * ekornya (`*_tail`) untuk petunjuk tersamar.
 */

const PATHS: Readonly<Record<ConnectionChannelType, string>> = {
  telegram: 'webhooks/telegram',
  messenger: 'webhooks/messenger',
  instagram: 'webhooks/instagram',
  email: '',
};

/** `<API_URL>/webhooks/<jenis>/<channelId>` (path `API_URL` dipertahankan). */
export function connectionWebhookUrl(
  apiUrl: string,
  type: ConnectionChannelType,
  channelId: string,
): string {
  const base = apiUrl.endsWith('/') ? apiUrl : `${apiUrl}/`;
  return new URL(`${PATHS[type]}/${encodeURIComponent(channelId)}`, base).toString();
}

function lastTestOf(row: Channel) {
  if (row.lastTestOk === null || row.lastTestedAt === null) return null;
  const code = connectionTestCodeSchema.safeParse(row.lastTestCode);
  if (!code.success) return null;
  return {
    ok: row.lastTestOk,
    code: code.data,
    message: CONNECTION_TEST_MESSAGES[code.data],
    testedAt: row.lastTestedAt.toISOString(),
  };
}

function statusOf(row: Channel): ChannelStatus {
  if (row.lastTestOk === null) return 'untested';
  return row.lastTestOk ? 'connected' : 'failed';
}

export function isConnectionType(type: Channel['type']): type is ConnectionChannelType {
  return type === 'telegram' || type === 'email' || type === 'messenger' || type === 'instagram';
}

export function toConnectionChannel(
  row: Channel,
  apiUrl: string,
  mailbox: EmailMailboxState | null,
): ConnectionChannel {
  const base = {
    id: row.id,
    name: row.name,
    enabled: row.enabled,
    disabledAt: row.enabled ? null : (row.disabledAt?.toISOString() ?? null),
    status: statusOf(row),
    lastTest: lastTestOf(row),
    credentialsUpdatedAt: row.credentialsUpdatedAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
  switch (row.type) {
    case 'telegram': {
      const url = connectionWebhookUrl(apiUrl, 'telegram', row.id);
      return {
        ...base,
        type: 'telegram',
        botUsername: row.tgBotUsername,
        botId: row.tgBotId ?? '',
        botTokenHint: maskedSecret(row.tgBotTokenTail),
        webhook: {
          url,
          registeredAt: row.tgWebhookRegisteredAt?.toISOString() ?? null,
          warning: telegramWebhookUrlUsable(url) ? null : TELEGRAM_WEBHOOK_WARNING,
        },
      };
    }
    case 'email': {
      const code = connectionTestCodeSchema.safeParse(mailbox?.lastPollCode);
      const smtpSecurity = emailChannelSmtpSecuritySchema.safeParse(row.emailSmtpSecurity);
      return {
        ...base,
        type: 'email',
        emailAddress: row.emailAddress ?? '',
        fromName: row.emailFromName ?? '',
        imap: {
          host: row.emailImapHost ?? '',
          port: row.emailImapPort ?? 993,
          security: imapSecuritySchema.catch('ssl').parse(row.emailImapSecurity),
          username: row.emailImapUsername ?? '',
          passwordHint: maskedSecret(row.emailImapPasswordTail),
          folder: row.emailImapFolder ?? 'INBOX',
        },
        pollIntervalMinutes: row.emailPollIntervalMinutes ?? 2,
        markAsRead: row.emailMarkAsRead ?? true,
        senderVerification: {
          trustedAuthServIds:
            row.emailTrustedAuthServIds ?? defaultTrustedAuthServIds(row.emailImapHost ?? ''),
          isDefault: row.emailTrustedAuthServIds === null,
        },
        smtp:
          row.emailSmtpMode === 'custom'
            ? {
                mode: 'custom',
                host: row.emailSmtpHost ?? '',
                port: row.emailSmtpPort ?? 465,
                security: smtpSecurity.success ? smtpSecurity.data : 'ssl',
                username: row.emailSmtpUsername ?? '',
                passwordHint: maskedSecret(row.emailSmtpPasswordTail),
              }
            : { mode: 'system' },
        mailbox: {
          lastPolledAt: mailbox?.lastPolledAt?.toISOString() ?? null,
          lastPollOk: mailbox?.lastPollOk ?? null,
          lastPollCode: code.success ? code.data : null,
          lastPollMessage: code.success ? CONNECTION_TEST_MESSAGES[code.data] : null,
          skippedMessages: mailbox?.skippedMessages ?? 0,
        },
      };
    }
    case 'messenger':
    case 'instagram':
      return {
        ...base,
        type: row.type,
        pageId: row.metaPageId ?? '',
        instagramAccountId: row.type === 'instagram' ? row.metaIgAccountId : null,
        pageAccessTokenHint: maskedSecret(row.metaPageTokenTail),
        appSecretHint: maskedSecret(row.metaAppSecretTail),
        webhookUrl: connectionWebhookUrl(apiUrl, row.type, row.id),
        requiresAppReview: true,
        reviewNote: CHANNEL_TYPE_AVAILABILITY[row.type].reason ?? '',
      };
    default:
      throw new Error('Baris channel bukan channel non-WhatsApp');
  }
}
