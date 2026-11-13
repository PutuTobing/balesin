import { lookup as dnsLookup, resolveMx as dnsResolveMx } from 'node:dns/promises';

import { isBlockedMailAddress, withTimeout, type HostLookup } from '@balesin/core';
import {
  SMTP_PRESETS,
  emailDomainOf,
  type DetectEmailHostResponse,
  type EmailHostSuggestion,
  type SmtpPresetId,
} from '@balesin/shared';

/**
 * Deteksi otomatis host SMTP dari domain alamat email (docs/PENGATURAN-UI.md §1).
 *
 * Hanya memakai DNS — tidak membuka sambungan ke host mana pun (itu tugas tombol "Tes
 * koneksi"). Urutan saran: penyedia terkenal dari nama domain → penyedia dari catatan MX →
 * `mail.<domain>` dan `smtp.<domain>` yang memang ada di DNS.
 */

export interface MailDns {
  resolveMx(domain: string): Promise<Array<{ exchange: string }>>;
  lookup: HostLookup;
}

const DNS_TIMEOUT_MS = 3_000;

export const systemMailDns: MailDns = {
  resolveMx: (domain) => dnsResolveMx(domain),
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
};

/** Domain email yang dilayani langsung oleh sebuah penyedia. */
const KNOWN_PROVIDER_DOMAINS: Record<string, SmtpPresetId> = {
  'gmail.com': 'gmail',
  'googlemail.com': 'gmail',
  'outlook.com': 'outlook',
  'outlook.co.id': 'outlook',
  'hotmail.com': 'outlook',
  'live.com': 'outlook',
  'msn.com': 'outlook',
};

/** Akhiran host MX → penyedia (domain sendiri yang emailnya di-hosting penyedia itu). */
const MX_SUFFIXES: Array<{ suffix: string; presetId: SmtpPresetId; description: string }> = [
  { suffix: '.google.com', presetId: 'gmail', description: 'Domain ini memakai Google Workspace.' },
  {
    suffix: '.googlemail.com',
    presetId: 'gmail',
    description: 'Domain ini memakai Google Workspace.',
  },
  {
    suffix: '.outlook.com',
    presetId: 'outlook',
    description: 'Domain ini memakai Microsoft 365.',
  },
];

function presetSuggestion(
  presetId: SmtpPresetId,
  reason: EmailHostSuggestion['reason'],
  description: string,
): EmailHostSuggestion | undefined {
  const preset = SMTP_PRESETS.find((candidate) => candidate.id === presetId);
  if (!preset?.host || !preset.port || !preset.security) return undefined;
  return {
    presetId,
    host: preset.host,
    port: preset.port,
    security: preset.security,
    reason,
    description,
  };
}

async function hostExists(dns: MailDns, host: string): Promise<boolean> {
  try {
    const addresses = await withTimeout(dns.lookup(host), DNS_TIMEOUT_MS, 'Resolusi DNS');
    return addresses.length > 0 && addresses.every((entry) => !isBlockedMailAddress(entry.address));
  } catch {
    return false;
  }
}

async function mxExchanges(dns: MailDns, domain: string): Promise<string[]> {
  try {
    const records = await withTimeout(dns.resolveMx(domain), DNS_TIMEOUT_MS, 'Resolusi MX');
    return records.map((record) => record.exchange.toLowerCase().replace(/\.$/, ''));
  } catch {
    return [];
  }
}

export async function detectEmailHost(
  emailAddress: string,
  dns: MailDns = systemMailDns,
): Promise<DetectEmailHostResponse> {
  const domain = emailDomainOf(emailAddress);
  if (!domain) return { domain: '', suggestions: [] };

  const suggestions: EmailHostSuggestion[] = [];
  const add = (suggestion: EmailHostSuggestion | undefined) => {
    if (suggestion && !suggestions.some((existing) => existing.host === suggestion.host)) {
      suggestions.push(suggestion);
    }
  };

  const knownProvider = KNOWN_PROVIDER_DOMAINS[domain];
  if (knownProvider) {
    add(presetSuggestion(knownProvider, 'known_provider', `Alamat ${domain} memakai server ini.`));
    return { domain, suggestions };
  }

  const [exchanges, mailHostExists, smtpHostExists] = await Promise.all([
    mxExchanges(dns, domain),
    hostExists(dns, `mail.${domain}`),
    hostExists(dns, `smtp.${domain}`),
  ]);

  for (const { suffix, presetId, description } of MX_SUFFIXES) {
    if (exchanges.some((exchange) => exchange.endsWith(suffix))) {
      add(presetSuggestion(presetId, 'mx_record', description));
    }
  }
  if (mailHostExists) {
    add({
      presetId: 'cpanel',
      host: `mail.${domain}`,
      port: 465,
      security: 'ssl',
      reason: 'dns_found',
      description: `Server mail.${domain} ditemukan. Ini pengaturan yang umum untuk email dari hosting.`,
    });
  }
  if (smtpHostExists) {
    add({
      presetId: 'other',
      host: `smtp.${domain}`,
      port: 587,
      security: 'starttls',
      reason: 'dns_found',
      description: `Server smtp.${domain} ditemukan.`,
    });
  }
  return { domain, suggestions };
}
