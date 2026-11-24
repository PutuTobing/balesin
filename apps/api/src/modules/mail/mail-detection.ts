import {
  lookup as dnsLookup,
  resolveMx as dnsResolveMx,
  resolveSrv as dnsResolveSrv,
} from 'node:dns/promises';

import {
  AUTOCONFIG_MAX_BYTES,
  fetchRemoteFile,
  parseAutoconfigXml,
  strictMailAddressAllowed,
  withTimeout,
  type AutoconfigResult,
  type HostLookup,
  type RemoteFileRequest,
  type RemoteFileResult,
} from '@balesin/core';
import {
  MAIL_PRESETS,
  emailDomainOf,
  type DetectMailAccountResponse,
  type MailServerSuggestion,
} from '@balesin/shared';

/**
 * Deteksi otomatis server akun Email (KONTRAK-API-EMAIL §4.1). Tidak membuka sambungan IMAP/SMTP
 * (itu tugas tes). Urutan: domain penyedia terkenal → MX → SRV (RFC 6186/8314) → autoconfig
 * (`autoconfig.<domain>`) → ISPDB Thunderbird → tebakan `mail.<domain>` (preset cPanel).
 *
 * SSRF (SECURITY §6): autoconfig/ISPDB lewat `fetchRemoteFile` — https wajib, alamat privat SELALU
 * ditolak (allowlist kosong), redirect ≤ 2 diperiksa ulang, ≤ 64 KB, 5 dtk per URL; ke ISPDB hanya
 * nama domain yang dikirim. DNS tiap kueri 3 dtk, total 12 dtk (sisa sumber dilewati). Tebakan hanya
 * bila namanya ada di DNS dan SEMUA alamatnya publik (atau privat yang ada di allowlist organisasi).
 * Hasil hanyalah SARAN: host tetap diperiksa penjaga host saat tes & simpan.
 */

export interface MailDetectionDns {
  resolveMx(domain: string): Promise<Array<{ exchange: string }>>;
  resolveSrv(name: string): Promise<Array<{ name: string; port: number; priority: number }>>;
  lookup: HostLookup;
}

export const systemMailDetectionDns: MailDetectionDns = {
  resolveMx: (domain) => dnsResolveMx(domain),
  resolveSrv: (name) => dnsResolveSrv(name),
  lookup: (host) => dnsLookup(host, { all: true, verbatim: true }),
};

export type RemoteFetcher = (request: RemoteFileRequest) => Promise<RemoteFileResult>;

export interface MailDetectionOptions {
  dns?: MailDetectionDns;
  fetchRemote?: RemoteFetcher;
  /** Allowlist IP privat organisasi (hanya untuk tebakan host; autoconfig tidak pernah privat). */
  privateCidrs?: readonly string[];
  /** HANYA tes (server tiruan). */
  allowLoopback?: boolean;
  totalTimeoutMs?: number;
}

const DNS_TIMEOUT_MS = 3_000;
const FETCH_TIMEOUT_MS = 5_000;
const ISPDB_BASE = 'https://autoconfig.thunderbird.net/v1.1/';

const KNOWN_DOMAINS: Readonly<Record<string, 'google' | 'microsoft'>> = {
  'gmail.com': 'google',
  'googlemail.com': 'google',
  'outlook.com': 'microsoft',
  'outlook.co.id': 'microsoft',
  'hotmail.com': 'microsoft',
  'live.com': 'microsoft',
  'msn.com': 'microsoft',
};

const PROVIDER_SERVERS = {
  google: {
    imap: { host: 'imap.gmail.com', port: 993, security: 'ssl' as const },
    smtp: { host: 'smtp.gmail.com', port: 465, security: 'ssl' as const },
    description:
      'Alamat ini memakai Google. Pakai sandi aplikasi (bukan password biasa) dan aktifkan IMAP; "Masuk dengan Google" segera hadir.',
  },
  microsoft: {
    imap: { host: 'outlook.office365.com', port: 993, security: 'ssl' as const },
    smtp: { host: 'smtp.office365.com', port: 587, security: 'starttls' as const },
    description:
      'Alamat ini memakai Microsoft 365/Outlook. Banyak akun mematikan login password (SMTP AUTH); "Masuk dengan Microsoft" segera hadir.',
  },
};

class Deadline {
  private readonly end: number;
  constructor(ms: number) {
    this.end = Date.now() + ms;
  }
  remaining(): number {
    return this.end - Date.now();
  }
  expired(): boolean {
    return this.remaining() <= 0;
  }
}

async function dnsCall<T>(task: () => Promise<T>, deadline: Deadline, fallback: T): Promise<T> {
  const budget = Math.min(DNS_TIMEOUT_MS, deadline.remaining());
  if (budget <= 0) return fallback;
  try {
    return await withTimeout(task(), budget, 'Resolusi DNS deteksi email');
  } catch {
    return fallback;
  }
}

function cpanelSuggestion(
  domain: string,
  source: MailServerSuggestion['source'],
  description: string,
): MailServerSuggestion {
  const preset = MAIL_PRESETS.cpanel;
  return {
    source,
    provider: 'cpanel',
    imap: { host: `mail.${domain}`, port: preset.imap.port, security: preset.imap.security },
    smtp: { host: `mail.${domain}`, port: preset.smtp.port, security: preset.smtp.security },
    username: 'address',
    description,
  };
}

function autoconfigSuggestion(
  result: AutoconfigResult,
  source: 'autoconfig' | 'ispdb',
): MailServerSuggestion | null {
  if (!result.imap || !result.smtp) return null;
  return {
    source,
    provider: 'imap',
    imap: { host: result.imap.host, port: result.imap.port, security: result.imap.security },
    smtp: { host: result.smtp.host, port: result.smtp.port, security: result.smtp.security },
    username: result.imap.username,
    description:
      source === 'ispdb'
        ? 'Pengaturan dari basis data penyedia email publik (Thunderbird).'
        : 'Pengaturan yang diumumkan domain ini (autoconfig).',
  };
}

export async function detectMailAccount(
  emailAddress: string,
  options: MailDetectionOptions = {},
): Promise<DetectMailAccountResponse> {
  const dns = options.dns ?? systemMailDetectionDns;
  const fetchRemote = options.fetchRemote ?? fetchRemoteFile;
  const deadline = new Deadline(options.totalTimeoutMs ?? 12_000);
  const domain = emailDomainOf(emailAddress) ?? '';
  if (!domain) return { domain: '', suggestions: [] };
  const suggestions: MailServerSuggestion[] = [];
  const add = (suggestion: MailServerSuggestion | null) => {
    if (!suggestion) return;
    const key = `${suggestion.imap?.host ?? ''}|${suggestion.smtp?.host ?? ''}`;
    if (suggestions.some((item) => `${item.imap?.host ?? ''}|${item.smtp?.host ?? ''}` === key)) {
      return;
    }
    suggestions.push(suggestion);
  };

  // 1. Domain penyedia terkenal.
  const known = KNOWN_DOMAINS[domain];
  if (known) {
    const servers = PROVIDER_SERVERS[known];
    add({
      source: 'known_provider',
      provider: known,
      imap: servers.imap,
      smtp: servers.smtp,
      username: 'address',
      description: servers.description,
    });
    return { domain, suggestions };
  }

  // 2. MX.
  const exchanges = (
    await dnsCall(() => dns.resolveMx(domain), deadline, [] as Array<{ exchange: string }>)
  ).map((record) => record.exchange.toLowerCase().replace(/\.$/, ''));
  if (exchanges.some((host) => host.endsWith('.google.com') || host.endsWith('.googlemail.com'))) {
    const servers = PROVIDER_SERVERS.google;
    add({
      source: 'mx',
      provider: 'google',
      imap: servers.imap,
      smtp: servers.smtp,
      username: 'address',
      description: `Domain ${domain} memakai Google Workspace. ${servers.description}`,
    });
  } else if (exchanges.some((host) => host.endsWith('.outlook.com'))) {
    const servers = PROVIDER_SERVERS.microsoft;
    add({
      source: 'mx',
      provider: 'microsoft',
      imap: servers.imap,
      smtp: servers.smtp,
      username: 'address',
      description: `Domain ${domain} memakai Microsoft 365. ${servers.description}`,
    });
  } else if (exchanges.some((host) => host === `mail.${domain}`)) {
    add(
      cpanelSuggestion(
        domain,
        'mx',
        `Server mail.${domain} menerima email domain ini — pengaturan umum hosting cPanel.`,
      ),
    );
  }

  // 3. SRV (RFC 6186/8314).
  if (!deadline.expired()) {
    const srv = async (name: string) =>
      (
        await dnsCall(
          () => dns.resolveSrv(`${name}.${domain}`),
          deadline,
          [] as Array<{ name: string; port: number; priority: number }>,
        )
      )
        .filter((record) => record.name && record.name !== '.')
        .sort((a, b) => a.priority - b.priority)[0];
    const [imaps, imap, submissions, submission] = await Promise.all([
      srv('_imaps._tcp'),
      srv('_imap._tcp'),
      srv('_submissions._tcp'),
      srv('_submission._tcp'),
    ]);
    const incoming =
      imaps?.port === 993
        ? { host: imaps.name.toLowerCase().replace(/\.$/, ''), port: 993, security: 'ssl' as const }
        : imap?.port === 143
          ? {
              host: imap.name.toLowerCase().replace(/\.$/, ''),
              port: 143,
              security: 'starttls' as const,
            }
          : null;
    const outgoing =
      submissions?.port === 465
        ? {
            host: submissions.name.toLowerCase().replace(/\.$/, ''),
            port: 465,
            security: 'ssl' as const,
          }
        : submission?.port === 587
          ? {
              host: submission.name.toLowerCase().replace(/\.$/, ''),
              port: 587,
              security: 'starttls' as const,
            }
          : null;
    if (incoming && outgoing) {
      add({
        source: 'srv',
        provider: 'imap',
        imap: incoming,
        smtp: outgoing,
        username: 'address',
        description: 'Pengaturan dari catatan DNS (SRV) domain ini.',
      });
    }
  }

  // 4. Autoconfig domain → ISPDB (https saja, privat selalu ditolak).
  const fetchConfig = async (url: string): Promise<AutoconfigResult | null> => {
    const budget = Math.min(FETCH_TIMEOUT_MS, deadline.remaining());
    if (budget <= 0) return null;
    const result = await fetchRemote({
      url,
      privateCidrs: [],
      maxBytes: AUTOCONFIG_MAX_BYTES,
      timeoutMs: budget,
      maxRedirects: 2,
      headers: { accept: 'application/xml, text/xml' },
      ...(options.allowLoopback ? { allowLoopback: true } : {}),
    }).catch(() => null);
    if (!result || !result.ok || !result.finalUrl.protocol.startsWith('https')) return null;
    return parseAutoconfigXml(result.body.toString('utf8'), domain);
  };
  const own = await fetchConfig(`https://autoconfig.${domain}/mail/config-v1.1.xml`);
  if (own) add(autoconfigSuggestion(own, 'autoconfig'));
  else {
    const ispdb = await fetchConfig(`${ISPDB_BASE}${encodeURIComponent(domain)}`);
    if (ispdb) add(autoconfigSuggestion(ispdb, 'ispdb'));
  }

  // 5. Tebakan mail.<domain>.
  if (!deadline.expired() && !suggestions.some((item) => item.provider === 'cpanel')) {
    const addresses = await dnsCall(() => dns.lookup(`mail.${domain}`), deadline, []);
    const rule = {
      privateCidrs: options.privateCidrs ?? [],
      ...(options.allowLoopback ? { allowLoopback: true } : {}),
    };
    if (
      addresses.length > 0 &&
      addresses.every((entry) => strictMailAddressAllowed(entry.address, rule))
    ) {
      add(
        cpanelSuggestion(
          domain,
          'guess',
          `Server mail.${domain} ditemukan. Ini pengaturan yang umum untuk email dari hosting (cPanel / IDCloudHost).`,
        ),
      );
    }
  }
  return { domain, suggestions };
}
