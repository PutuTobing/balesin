import {
  API_KEY_EMAIL_ATTACHMENT_HOSTS_MAX,
  API_KEY_SCOPES,
  emailAttachmentHostSchema,
  type ApiKeyScope,
} from '@balesin/shared';
import { t } from '../../i18n/id';
import type { FieldErrors } from '../../lib/form';

const copy = t.apiKeys;

/** Satu host per baris (koma juga diterima); baris kosong & duplikat dibuang. */
export function parseAttachmentHosts(
  raw: string,
): { hosts: string[]; error: null } | { hosts: null; error: string } {
  const lines = raw.split(/[\n,]/).map((line) => line.trim());
  const hosts: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (!line) continue;
    const parsed = emailAttachmentHostSchema.safeParse(line);
    if (!parsed.success) return { hosts: null, error: copy.emailHostsInvalid(index + 1) };
    if (!hosts.includes(parsed.data)) hosts.push(parsed.data);
  }
  if (hosts.length > API_KEY_EMAIL_ATTACHMENT_HOSTS_MAX) {
    return { hosts: null, error: copy.emailHostsTooMany(API_KEY_EMAIL_ATTACHMENT_HOSTS_MAX) };
  }
  return { hosts, error: null };
}

/** Kelompok izin di dialog (urut `API_KEY_SCOPES`): percakapan & pesan, kontak, tiket, email. */
export function scopeGroups(): { key: string; label: string; scopes: ApiKeyScope[] }[] {
  const groups: { key: string; label: string; scopes: ApiKeyScope[] }[] = [];
  for (const scope of API_KEY_SCOPES) {
    const prefix = scope.split(':')[0] ?? scope;
    const label = copy.scopeGroups[prefix] ?? prefix;
    const group = groups.find((item) => item.label === label);
    if (group) group.scopes.push(scope);
    else groups.push({ key: prefix, label, scopes: [scope] });
  }
  return groups;
}

/** Sama persis (urutan diabaikan). */
export function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((item) => b.includes(item));
}

/** Galat isian email (lokal atau server, mis. `emailAttachmentHosts.2`) → kunci tampilan. */
export function emailErrors(errors: FieldErrors): { senders?: string; hosts?: string } {
  const find = (prefix: string) =>
    Object.entries(errors).find(([key]) => key === prefix || key.startsWith(`${prefix}.`))?.[1];
  return { senders: find('emailSenderIds'), hosts: find('emailAttachmentHosts') };
}
