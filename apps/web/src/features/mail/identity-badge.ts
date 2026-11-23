import type { MailIdentity } from '@balesin/shared';
import type { StatusTone } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';

const i = t.mail.identities;

/**
 * Lencana status identitas: persetujuan Owner/Admin (akun pribadi berdomain organisasi) didahulukan,
 * lalu verifikasi. Status yang belum dikenal web tampil netral (tidak dianggap biner).
 */
export function identityBadge(identity: Pick<MailIdentity, 'verification' | 'approval'>): {
  tone: StatusTone;
  label: string;
} {
  const approval = identity.approval.state;
  if (approval === 'pending' || approval === 'rejected') {
    return {
      tone: approval === 'pending' ? 'warning' : 'danger',
      label: i.approvalStates[approval] ?? i.unknownState,
    };
  }
  const state = identity.verification.state;
  return {
    tone: state === 'verified' ? 'success' : state === 'pending' ? 'warning' : 'neutral',
    label: i.states[state] ?? i.unknownState,
  };
}
