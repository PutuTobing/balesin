import type { MailIncomingTestCode } from '@balesin/shared';
import type { ImapFlow } from 'imapflow';

import {
  classifyImapError,
  closeImapClient,
  DEFAULT_IMAP_TIMEOUTS,
  ImapFailure,
  openImapClient,
  type ImapPolicy,
} from '../channels/email-imap';
import type { Secret } from '../secret';
import { withTimeout } from '../timeout';
import { MAIL_SYNC_HEADER_FIELDS } from './headers';

/**
 * Klien IMAP akun Email (Fase 9, KONTRAK-API-EMAIL §4.2 & §11) di atas penjaga sambungan Fase 6
 * (`openImapClient`: port, host terperiksa sekali, TLS wajib, batas waktu & ukuran literal).
 *
 * `MailImapSession` adalah antarmuka sempit yang dipakai worker sinkron — tes logika sinkron memakai
 * tiruan di memori; adaptor imapflow ini dites terhadap server IMAP tiruan protokol.
 *
 * Balasan server hanya DIPINDAI untuk mengenali sebab (`classifyMailImapError`), tidak pernah
 * diteruskan/di-log. Password hanya dibuka saat sambungan dibuat.
 */

export interface MailImapConfig {
  host: string;
  port: number;
  security: 'ssl' | 'starttls';
  username: string;
  password: Secret<string>;
}

export interface MailServerCapabilities {
  idle: boolean;
  condstore: boolean;
  qresync: boolean;
  move: boolean;
  uidplus: boolean;
  specialUse: boolean;
  quota: boolean;
}

export interface MailServerFolderStatus {
  messages: number;
  unseen: number;
  uidNext: number | null;
  uidValidity: number | null;
  highestModseq: string | null;
}

export interface MailServerFolder {
  path: string;
  delimiter: string | null;
  flags: string[];
  subscribed: boolean;
  selectable: boolean;
  status: MailServerFolderStatus | null;
}

export interface MailSelectedFolder {
  uidValidity: number;
  uidNext: number;
  exists: number;
  highestModseq: string | null;
}

export interface MailBodyStructureNode {
  part: string | null;
  type: string;
  encoding: string | null;
  charset: string | null;
  size: number;
  disposition: string | null;
  filename: string | null;
  id: string | null;
  childNodes: MailBodyStructureNode[];
}

export interface MailServerMessage {
  uid: number;
  flags: string[];
  internalDate: Date | null;
  size: number;
  headers: Buffer | null;
  bodyStructure: MailBodyStructureNode | null;
  /** Awal bagian teks (≤ 4 KB, masih ber-transfer-encoding) — untuk cuplikan. */
  textPreview: {
    raw: Buffer;
    encoding: string | null;
    charset: string | null;
    html: boolean;
  } | null;
  modseq: string | null;
}

export interface MailFlagUpdate {
  uid: number;
  flags: string[];
  modseq: string | null;
}

export type MailIdleChange = 'exists' | 'expunge' | 'flags';

export interface MailImapSession {
  readonly capabilities: MailServerCapabilities;
  listFolders(): Promise<MailServerFolder[]>;
  quota(): Promise<{ usedBytes: number; limitBytes: number } | null>;
  /** STATUS satu folder (panggil SEBELUM `select` folder itu). */
  status(path: string): Promise<MailServerFolderStatus>;
  select(path: string): Promise<MailSelectedFolder>;
  /** UID email yang `INTERNALDATE` ≥ `since` (`null` = semua). */
  searchUids(since: Date | null): Promise<number[]>;
  /** Header + bendera + struktur untuk UID ini (urutan sembarang). */
  fetchHeaders(uids: readonly number[]): Promise<MailServerMessage[]>;
  /** Bendera UID ini, atau yang berubah sejak `changedSince` (CONDSTORE). */
  fetchFlags(
    uids: readonly number[] | 'all',
    changedSince?: string | null,
  ): Promise<MailFlagUpdate[]>;
  /**
   * IDLE pada folder terpilih sampai `signal` dibatalkan / `maxMs` lewat / server mengirim
   * perubahan (dilaporkan lewat `onChange`). Server tanpa IDLE → melempar.
   */
  idle(options: {
    maxMs: number;
    signal: AbortSignal;
    onChange: (change: MailIdleChange) => void;
  }): Promise<void>;
  close(): Promise<void>;
}

/** Batas literal satu respons sinkron header (bukan isi). */
const SYNC_LITERAL_BYTES = 4 * 1024 * 1024;
export const MAIL_SNIPPET_BYTES = 4096;

/** Sebab khusus dari teks balasan → kode tes (kontrak §12.2). Teks tidak pernah disimpan. */
export function classifyMailImapError(error: unknown): {
  code: Exclude<MailIncomingTestCode, 'ok' | 'imap_quota_full' | 'secret_unavailable'>;
  diagnostic: string | null;
} {
  const base = classifyImapError(error);
  const diagnostic = base.diagnostic;
  if (base.hint === 'app_password_required')
    return { code: 'imap_app_password_required', diagnostic };
  if (base.hint === 'not_enabled') return { code: 'imap_not_enabled', diagnostic };
  if (base.hint === 'too_many_connections')
    return { code: 'imap_too_many_connections', diagnostic };
  const code = base.code === 'imap_folder_not_found' ? 'unknown' : base.code;
  return { code, diagnostic };
}

function capabilitiesOf(client: ImapFlow): MailServerCapabilities {
  const has = (name: string) => client.capabilities.has(name);
  return {
    idle: has('IDLE'),
    condstore: has('CONDSTORE') || has('QRESYNC'),
    qresync: has('QRESYNC'),
    move: has('MOVE'),
    uidplus: has('UIDPLUS'),
    specialUse: has('SPECIAL-USE'),
    quota: has('QUOTA'),
  };
}

type RawStructure = {
  part?: string;
  type?: string;
  encoding?: string;
  parameters?: Record<string, string>;
  size?: number;
  disposition?: string;
  dispositionParameters?: Record<string, string>;
  id?: string;
  childNodes?: RawStructure[];
};

function structureOf(node: RawStructure | undefined, depth = 0): MailBodyStructureNode | null {
  if (!node || depth > 20) return null;
  const children = (node.childNodes ?? [])
    .slice(0, 100)
    .map((child) => structureOf(child, depth + 1))
    .filter((child): child is MailBodyStructureNode => child !== null);
  const filename = node.dispositionParameters?.filename ?? node.parameters?.name ?? null;
  return {
    part: node.part ?? null,
    type: (node.type ?? 'application/octet-stream').toLowerCase().slice(0, 255),
    encoding: node.encoding?.toLowerCase().slice(0, 32) ?? null,
    charset: node.parameters?.charset?.toLowerCase().slice(0, 64) ?? null,
    size: typeof node.size === 'number' && node.size >= 0 ? node.size : 0,
    disposition: node.disposition?.toLowerCase().slice(0, 32) ?? null,
    filename: filename ? filename.slice(0, 255) : null,
    id: node.id ? node.id.slice(0, 998) : null,
    childNodes: children,
  };
}

/** Bagian teks pertama (`text/plain` didahulukan, lalu `text/html`) yang bukan lampiran. */
export function firstTextPart(
  root: MailBodyStructureNode | null,
): { part: string; node: MailBodyStructureNode; html: boolean } | null {
  if (!root) return null;
  const candidates: MailBodyStructureNode[] = [];
  const visit = (node: MailBodyStructureNode) => {
    if (node.childNodes.length > 0) {
      node.childNodes.forEach(visit);
      return;
    }
    if (node.disposition === 'attachment') return;
    if (node.type === 'text/plain' || node.type === 'text/html') candidates.push(node);
  };
  visit(root);
  const plain = candidates.find((node) => node.type === 'text/plain');
  const chosen = plain ?? candidates[0];
  if (!chosen) return null;
  // Email satu bagian: imapflow tidak memberi nomor bagian → bagian "1".
  return { part: chosen.part ?? '1', node: chosen, html: chosen.type === 'text/html' };
}

/** `true` bila ada bagian lampiran (disposisi `attachment`, atau berkas bernama di luar teks). */
export function hasAttachmentParts(root: MailBodyStructureNode | null): boolean {
  if (!root) return false;
  const visit = (node: MailBodyStructureNode): boolean => {
    if (node.childNodes.length > 0) return node.childNodes.some(visit);
    if (node.disposition === 'attachment') return true;
    return (
      node.filename !== null && !node.type.startsWith('text/') && node.disposition !== 'inline'
    );
  };
  return visit(root);
}

function modseqOf(value: unknown): string | null {
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number' && Number.isFinite(value)) return String(Math.trunc(value));
  return null;
}

function uidSet(uids: readonly number[]): string {
  return [...uids].sort((a, b) => a - b).join(',');
}

class ImapFlowSession implements MailImapSession {
  readonly capabilities: MailServerCapabilities;

  constructor(private readonly client: ImapFlow) {
    this.capabilities = capabilitiesOf(client);
  }

  async listFolders(): Promise<MailServerFolder[]> {
    const entries = await this.client.list({
      statusQuery: { messages: true, unseen: true, uidNext: true, uidValidity: true },
    });
    return entries.slice(0, 1_000).map((entry) => {
      const flags = [...entry.flags].map(String);
      const status = entry.status;
      return {
        path: entry.path,
        delimiter: entry.delimiter || null,
        flags:
          entry.specialUse && entry.specialUseSource === 'extension'
            ? [...flags, entry.specialUse]
            : flags,
        subscribed: entry.subscribed,
        selectable: !flags.some((flag) => /^\\noselect$|^\\nonexistent$/i.test(flag)),
        status: status
          ? {
              messages: status.messages ?? 0,
              unseen: status.unseen ?? 0,
              uidNext: status.uidNext ?? null,
              uidValidity: status.uidValidity !== undefined ? Number(status.uidValidity) : null,
              highestModseq: modseqOf(status.highestModseq),
            }
          : null,
      };
    });
  }

  async quota(): Promise<{ usedBytes: number; limitBytes: number } | null> {
    if (!this.capabilities.quota) return null;
    try {
      const result = await this.client.getQuota('INBOX');
      const storage = result && typeof result === 'object' ? result.storage : undefined;
      if (!storage || typeof storage.limit !== 'number' || storage.limit <= 0) return null;
      return { usedBytes: storage.usage ?? 0, limitBytes: storage.limit };
    } catch {
      return null;
    }
  }

  async status(path: string): Promise<MailServerFolderStatus> {
    const result = await this.client.status(path, {
      messages: true,
      unseen: true,
      uidNext: true,
      uidValidity: true,
      ...(this.capabilities.condstore ? { highestModseq: true } : {}),
    });
    if (!result) throw new ImapFailure('unknown', 'STATUS_FAILED');
    return {
      messages: result.messages ?? 0,
      unseen: result.unseen ?? 0,
      uidNext: result.uidNext ?? null,
      uidValidity: result.uidValidity !== undefined ? Number(result.uidValidity) : null,
      highestModseq: modseqOf(result.highestModseq),
    };
  }

  async select(path: string): Promise<MailSelectedFolder> {
    const mailbox = await this.client.mailboxOpen(path, { readOnly: true });
    return {
      uidValidity: Number(mailbox.uidValidity),
      uidNext: mailbox.uidNext,
      exists: mailbox.exists,
      highestModseq: modseqOf(mailbox.highestModseq),
    };
  }

  async searchUids(since: Date | null): Promise<number[]> {
    const result = await this.client.search(since ? { since } : { all: true }, { uid: true });
    return Array.isArray(result) ? result.filter((uid) => Number.isInteger(uid) && uid > 0) : [];
  }

  async fetchHeaders(uids: readonly number[]): Promise<MailServerMessage[]> {
    if (uids.length === 0) return [];
    const base = await this.client.fetchAll(
      uidSet(uids),
      {
        uid: true,
        flags: true,
        internalDate: true,
        size: true,
        bodyStructure: true,
        headers: [...MAIL_SYNC_HEADER_FIELDS],
      },
      { uid: true },
    );
    const wanted = new Set(uids);
    const messages: MailServerMessage[] = [];
    // Cuplikan: satu FETCH per bagian teks yang sama (biasanya "1"), dikelompokkan.
    const byPart = new Map<string, number[]>();
    for (const item of base) {
      if (!wanted.has(item.uid)) continue;
      const structure = structureOf(item.bodyStructure);
      const text = firstTextPart(structure);
      if (text) byPart.set(text.part, [...(byPart.get(text.part) ?? []), item.uid]);
      messages.push({
        uid: item.uid,
        flags: [...(item.flags ?? new Set<string>())].map(String),
        internalDate: item.internalDate instanceof Date ? item.internalDate : null,
        size: item.size ?? 0,
        headers: item.headers ?? null,
        bodyStructure: structure,
        textPreview: null,
        modseq: modseqOf(item.modseq),
      });
    }
    const byUid = new Map(messages.map((message) => [message.uid, message]));
    for (const [part, partUids] of byPart) {
      const previews = await this.client.fetchAll(
        uidSet(partUids),
        { uid: true, bodyParts: [{ key: part, start: 0, maxLength: MAIL_SNIPPET_BYTES }] },
        { uid: true },
      );
      for (const preview of previews) {
        const message = byUid.get(preview.uid);
        if (!message) continue;
        const raw = preview.bodyParts?.get(part.toLowerCase()) ?? preview.bodyParts?.get(part);
        const text = firstTextPart(message.bodyStructure);
        if (raw && text) {
          message.textPreview = {
            raw: raw.subarray(0, MAIL_SNIPPET_BYTES),
            encoding: text.node.encoding,
            charset: text.node.charset,
            html: text.html,
          };
        }
      }
    }
    return messages;
  }

  async fetchFlags(
    uids: readonly number[] | 'all',
    changedSince?: string | null,
  ): Promise<MailFlagUpdate[]> {
    if (uids !== 'all' && uids.length === 0) return [];
    const range = uids === 'all' ? '1:*' : uidSet(uids);
    const options: { uid: true; changedSince?: bigint } = { uid: true };
    if (changedSince && this.capabilities.condstore) options.changedSince = BigInt(changedSince);
    const rows = await this.client.fetchAll(range, { uid: true, flags: true }, options);
    return rows.map((row) => ({
      uid: row.uid,
      flags: [...(row.flags ?? new Set<string>())].map(String),
      modseq: modseqOf(row.modseq),
    }));
  }

  async idle(options: {
    maxMs: number;
    signal: AbortSignal;
    onChange: (change: MailIdleChange) => void;
  }): Promise<void> {
    if (!this.capabilities.idle) throw new ImapFailure('unknown', 'NO_IDLE');
    const handlers: Record<MailIdleChange, () => void> = {
      exists: () => options.onChange('exists'),
      expunge: () => options.onChange('expunge'),
      flags: () => options.onChange('flags'),
    };
    for (const [event, handler] of Object.entries(handlers)) this.client.on(event, handler);
    const stop = () => {
      // Perintah apa pun memutus IDLE; NOOP paling ringan.
      this.client.noop().catch(() => undefined);
    };
    const timer = setTimeout(stop, options.maxMs);
    options.signal.addEventListener('abort', stop, { once: true });
    try {
      if (!options.signal.aborted) await this.client.idle();
    } finally {
      clearTimeout(timer);
      options.signal.removeEventListener('abort', stop);
      for (const [event, handler] of Object.entries(handlers)) this.client.off(event, handler);
    }
  }

  async close(): Promise<void> {
    await closeImapClient(this.client);
  }
}

/** Membuka sesi akun. Gagal → `ImapFailure` (kode Fase 6) — pemanggil memetakan via `classifyMailImapError`. */
export async function openMailImapSession(
  config: MailImapConfig,
  policy: ImapPolicy,
): Promise<MailImapSession> {
  const client = await openImapClient(
    { ...config },
    { ...policy, timeouts: { ...DEFAULT_IMAP_TIMEOUTS, ...policy.timeouts } },
    { maxLiteralBytes: SYNC_LITERAL_BYTES },
  );
  return new ImapFlowSession(client);
}

/** Pembuka sesi (bisa diganti di tes). */
export type MailImapConnector = (
  config: MailImapConfig,
  policy: ImapPolicy,
) => Promise<MailImapSession>;

export const defaultMailImapConnector: MailImapConnector = openMailImapSession;

// ── Tes Masuk (kontrak §4.2) ───────────────────────────────────────────────

export interface MailIncomingTestDetails {
  folderCount: number;
  inboxTotal: number;
  specialFolders: string[];
  idle: boolean;
  quota: { usedBytes: number; limitBytes: number } | null;
  estimatedInitialSync: number | null;
  capabilities: MailServerCapabilities;
}

export type MailIncomingTestOutcome =
  | {
      ok: true;
      code: 'ok' | 'imap_quota_full';
      durationMs: number;
      details: MailIncomingTestDetails;
    }
  | {
      ok: false;
      code: Exclude<MailIncomingTestCode, 'ok' | 'imap_quota_full'>;
      durationMs: number;
      diagnostic: string | null;
    };

/**
 * Sambung + TLS + login + LIST + STATUS INBOX + GETQUOTAROOT (bila ada) + perkiraan email dalam
 * jendela sinkron (`SEARCH SINCE`). `roleOf` memetakan folder → peran (dari `@balesin/shared`).
 */
export async function testMailIncoming(
  config: MailImapConfig,
  policy: ImapPolicy,
  options: {
    syncWindowDays: number | null;
    roleOf: (folder: MailServerFolder) => string | null;
    connector?: MailImapConnector;
    now?: () => Date;
  },
): Promise<MailIncomingTestOutcome> {
  const started = Date.now();
  const timeouts = { ...DEFAULT_IMAP_TIMEOUTS, ...policy.timeouts };
  try {
    const details = await withTimeout(
      (async () => {
        const session = await (options.connector ?? defaultMailImapConnector)(config, policy);
        try {
          const folders = await session.listFolders();
          const inbox = folders.find((folder) => folder.path.toUpperCase() === 'INBOX');
          const roles = new Set<string>();
          for (const folder of folders) {
            const role = options.roleOf(folder);
            if (role && role !== 'inbox' && role !== 'all' && role !== 'flagged') roles.add(role);
          }
          const quota = await session.quota();
          let estimate: number | null = null;
          if (inbox) {
            await session.select(inbox.path);
            const since =
              options.syncWindowDays === null
                ? null
                : new Date(
                    (options.now ?? (() => new Date()))().getTime() -
                      options.syncWindowDays * 24 * 60 * 60 * 1000,
                  );
            estimate = (await session.searchUids(since)).length;
          }
          return {
            folderCount: folders.length,
            inboxTotal: inbox?.status?.messages ?? 0,
            specialFolders: [...roles],
            idle: session.capabilities.idle,
            quota,
            estimatedInitialSync: estimate,
            capabilities: session.capabilities,
          } satisfies MailIncomingTestDetails;
        } finally {
          await session.close();
        }
      })(),
      Math.min(timeouts.totalMs, 30_000),
      'Tes IMAP akun email',
    );
    const full =
      details.quota !== null &&
      details.quota.limitBytes > 0 &&
      details.quota.usedBytes / details.quota.limitBytes >= 0.95;
    return {
      ok: true,
      code: full ? 'imap_quota_full' : 'ok',
      durationMs: Date.now() - started,
      details,
    };
  } catch (error) {
    const failure = classifyMailImapError(error);
    return {
      ok: false,
      code: failure.code,
      durationMs: Date.now() - started,
      diagnostic: failure.diagnostic,
    };
  }
}
