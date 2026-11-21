import { t } from '../../i18n/id';

const c = t.templates;

/** Label bahasa ("Indonesia") atau kodenya bila tidak dikenal. */
export function languageLabel(code: string): string {
  return c.languages[code] ?? code;
}

/** Alasan penolakan Meta dalam bahasa Indonesia (kode yang tidak dikenal tampil apa adanya). */
export function rejectionText(reason: string): string {
  return c.rejectedReason(c.reasons[reason] ?? reason);
}
