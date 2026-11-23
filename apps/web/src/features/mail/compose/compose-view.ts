import {
  MAIL_COMPOSE_MESSAGES,
  type MailDraft,
  type MailDraftCheckResponse,
} from '@balesin/shared';
import { t } from '../../../i18n/id';
import type { ComposeIdentity } from './ComposeParts';

const c = t.mail.compose;

/** Judul bilah jendela dari mode & subjek. */
export function composeTitle(mode: MailDraft['mode'], subject: string | null): string {
  const clean = subject?.trim() ?? '';
  if (mode === 'new') return clean || c.titles.new;
  const shown = clean.replace(/^\s*(re|aw|bls|fwd|fw|tr)\s*:\s*/i, '') || c.noSubject;
  return c.titles[mode](shown);
}

/** Identitas bawaan email baru: akun yang sedang dibuka → identitas utama yang bisa mengirim. */
export function defaultIdentity(
  identities: readonly ComposeIdentity[],
  accountId: string | null | undefined,
): ComposeIdentity | null {
  const usable = identities.filter((identity) => identity.canSend);
  const inAccount = (list: readonly ComposeIdentity[]) =>
    list.filter((identity) => identity.accountId === accountId);
  return (
    inAccount(usable).find((identity) => identity.isPrimary) ??
    inAccount(usable)[0] ??
    usable.find((identity) => identity.isPrimary) ??
    usable[0] ??
    inAccount([...identities])[0] ??
    identities[0] ??
    null
  );
}

/** Peringatan dari hasil cek server (§6.5), urut dari yang paling penting. */
export function checkWarnings(
  checks: MailDraftCheckResponse['checks'] | null,
  draft: Pick<MailDraft, 'mode'>,
): string[] {
  if (!checks) return [];
  const list: string[] = [];
  if (checks.replyToDiffers && draft.mode !== 'new') {
    list.push(c.checks.replyToDiffers(checks.replyToDiffers));
  }
  if (checks.totalRecipients > checks.maxRecipients) {
    list.push(MAIL_COMPOSE_MESSAGES.tooManyRecipients(checks.maxRecipients));
  } else if (checks.totalRecipients >= Math.ceil(checks.maxRecipients * 0.8)) {
    list.push(c.checks.count(checks.totalRecipients, checks.maxRecipients));
  }
  if (checks.recipients.some((item) => item.external)) list.push(c.checks.external);
  if (checks.bccWarning) list.push(c.checks.bcc);
  if (checks.newAddressCount > checks.newAddressQuota.remaining) {
    list.push(c.checks.newAddresses(checks.newAddressCount, checks.newAddressQuota.remaining));
  }
  return list;
}
