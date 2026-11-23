import type { MailIncomingTestCode } from '@balesin/shared';
import type { FetchMessageObject, ImapFlow } from 'imapflow';

import {
  classifyImapError,
  closeImapClient,
  DEFAULT_IMAP_TIMEOUTS,
  ImapFailure,
  openImapClient,
  type ImapPolicy,
} from '../channels/email-imap';
import type { Secret } from '../secret';
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

export interface MailFetchedBytes {
  bytes: Buffer;
  truncated: boolean;
}

/** Potongan per FETCH (di bawah batas literal sambungan sinkron 4 MB). */
export const MAIL_FETCH_CHUNK_BYTES = 3 * 1024 * 1024;

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
  /**
   * Review 9A-1 S2: putus SEKETIKA (soket ditutup, tanpa LOGOUT) — dipakai saat tenggat habis atau
   * anggaran byte terlewati. Tiruan di memori boleh tidak mengisinya (pemanggil memakai `close`).
   */
  abort?(): void;
}

/**
 * Bagian 2 (isi & aksi dua arah). Terpisah dari `MailImapSession` supaya tiruan sinkron di memori
 * tidak wajib mengisinya; adaptor imapflow mengisi keduanya (`hasMailImapActions`).
 */
export interface MailImapActions {
  /** SELECT baca-tulis (untuk aksi). `select` biasa = EXAMINE (hanya baca). */
  openWritable(path: string): Promise<MailSelectedFolder>;
  /**
   * Sumber RFC 822 satu UID (folder terpilih), diambil per potongan ≤ 4 MB sampai `maxBytes`.
   * `null` = UID tidak ada lagi. `truncated` = lebih panjang dari `maxBytes`.
   */
  fetchSource(uid: number, maxBytes: number): Promise<MailFetchedBytes | null>;
  /** Satu bagian BODYSTRUCTURE (masih ber-transfer-encoding), per potongan sampai `maxBytes`. */
  fetchPart(uid: number, part: string, maxBytes: number): Promise<MailFetchedBytes | null>;
  /**
   * Review 9A-2 S7: seperti `fetchPart` tetapi setiap potongan (≤ 3 MB) DIALIRKAN ke `sink` (mis. ke
   * disk) tanpa ditampung — memori job lampiran tetap kecil. `null` = UID/bagian tidak ada.
   */
  fetchPartTo(
    uid: number,
    part: string,
    maxBytes: number,
    sink: (chunk: Buffer) => Promise<void>,
  ): Promise<{ sizeBytes: number; truncated: boolean } | null>;
  /** `UID STORE ±FLAGS.SILENT`. `false` = server menolak. */
  storeFlags(
    uids: readonly number[],
    add: readonly string[],
    remove: readonly string[],
  ): Promise<boolean>;
  /**
   * Pindah ke `targetPath`: `UID MOVE` (RFC 6851) bila ada; tanpa MOVE: `UID COPY` + `\Deleted` +
   * `UID EXPUNGE` (UIDPLUS); tanpa UIDPLUS: `UID COPY` + `\Deleted` saja (TIDAK PERNAH `EXPUNGE`
   * biasa yang bisa menghapus email lain bertanda `\Deleted`). `null` = gagal; `uidMap` dari
   * `COPYUID` bila server memberinya.
   */
  move(
    uids: readonly number[],
    targetPath: string,
  ): Promise<{ uidMap: Map<number, number>; uidValidity: number | null } | null>;
  /** Hapus permanen: `\Deleted` + `UID EXPUNGE` (UIDPLUS); tanpa UIDPLUS hanya `\Deleted`. */
  expunge(uids: readonly number[]): Promise<boolean>;
  /** `CREATE` folder (path server lengkap). */
  createFolder(path: string): Promise<boolean>;
}

/**
 * Tahap 9B (KONTRAK-API-EMAIL-TULIS §7, §13): salinan draf/Terkirim dan pencarian `Message-ID`.
 * Terpisah supaya tiruan sinkron di memori tidak wajib mengisinya.
 */
export interface MailImapCompose {
  /** `APPEND` ke `path` dengan bendera. `uid` dari `APPENDUID` (UIDPLUS), atau `null`. */
  append(
    path: string,
    raw: Buffer,
    flags: readonly string[],
  ): Promise<{ uid: number | null; uidValidity: number | null } | null>;
  /** `UID SEARCH [SINCE] HEADER Message-ID <id>` di folder terpilih (≤ 50 UID). */
  searchMessageId(messageId: string, since: Date | null): Promise<number[]>;
}

export function hasMailImapCompose(
  session: MailImapSession,
): session is MailImapSession & MailImapActions & MailImapCompose {
  return typeof (session as Partial<MailImapCompose>).append === 'function';
}

export function hasMailImapActions(
  session: MailImapSession,
): session is MailImapSession & MailImapActions {
  return typeof (session as Partial<MailImapActions>).fetchSource === 'function';
}

/** Batas literal satu respons sinkron header (bukan isi). */
const SYNC_LITERAL_BYTES = 4 * 1024 * 1024;

/**
 * Review 9A-1 S2 — server IMAP bisa dikendalikan penyerang (akun pribadi). Batas per SAMBUNGAN:
 * byte masuk total (lewat → sambungan diputus), tenggat per perintah (aliran tanpa akhir tidak memicu
 * `socketTimeout`), jumlah folder & hasil pencarian.
 */
export const MAIL_SESSION_MAX_BYTES = 96 * 1024 * 1024;
export const MAIL_TEST_SESSION_MAX_BYTES = 8 * 1024 * 1024;
export const MAIL_COMMAND_TIMEOUT_MS = 60_000;
export const MAIL_MAX_FOLDERS = 1_000;
export const MAIL_MAX_SEARCH_RESULTS = 100_000;
/**
 * Byte masuk per PERINTAH (di samping anggaran sambungan): imapflow mengurai setiap respons menjadi
 * objek token yang jauh lebih besar dari byte mentahnya, dan `LIST`/`SEARCH` menimbun seluruh hasil
 * sebelum selesai — jadi satu perintah dibatasi jauh di bawah anggaran sambungan. Lewat → putus.
 */
export const MAIL_COMMAND_MAX_BYTES = 16 * 1024 * 1024;
/** `LIST`: 1.000 folder × ± 200 byte jauh di bawah ini. */
export const MAIL_LIST_MAX_BYTES = 4 * 1024 * 1024;
/** `UID SEARCH`: 500.000 UID × ± 8 byte. */
export const MAIL_SEARCH_MAX_BYTES = 8 * 1024 * 1024;

export interface MailSessionLimits {
  /** Byte masuk maksimum untuk seluruh sambungan. */
  maxBytes?: number;
  /** Tenggat satu perintah. */
  commandMs?: number;
  /** Dibatalkan → sambungan diputus (termasuk selama fase connect). */
  signal?: AbortSignal;
}

/** Putus sesi seketika (`abort`) atau, untuk tiruan, `close`. */
export function abortMailSession(session: MailImapSession): void {
  if (session.abort) session.abort();
  else session.close().catch(() => undefined);
}

/**
 * Jalankan `run` dengan sesi dari `open` dalam tenggat TOTAL `ms`: lewat tenggat → sesi diputus
 * (bukan sekadar janji ditolak) dan `ImapFailure('imap_connection_timeout')`. Sesi yang baru jadi
 * setelah tenggat langsung diputus. Selesai normal → `close()` (LOGOUT).
 */
export async function withMailSession<T, S extends MailImapSession = MailImapSession>(
  open: (signal: AbortSignal) => Promise<S>,
  ms: number,
  run: (session: S) => Promise<T>,
): Promise<T> {
  const state: { session: S | null; expired: boolean } = { session: null, expired: false };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const controller = new AbortController();
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      state.expired = true;
      controller.abort();
      if (state.session) abortMailSession(state.session);
      reject(new ImapFailure('imap_connection_timeout', 'TOTAL_TIMEOUT'));
    }, ms);
  });
  const work = (async () => {
    const opened = await open(controller.signal);
    if (state.expired) {
      abortMailSession(opened);
      throw new ImapFailure('imap_connection_timeout', 'TOTAL_TIMEOUT');
    }
    state.session = opened;
    return run(opened);
  })();
  // Janji yang kalah tidak boleh menjadi "unhandled rejection".
  work.catch(() => undefined);
  deadline.catch(() => undefined);
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
    if (state.session) {
      if (state.expired) abortMailSession(state.session);
      else await state.session.close().catch(() => undefined);
    }
  }
}
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

export const MAIL_BODYSTRUCTURE_MAX_BYTES = 64 * 1024;

/**
 * Review 9A-1 S3: struktur MIME yang DISIMPAN per email ≤ 64 KB. Struktur raksasa diringkas jadi
 * daftar bagian daun (nomor bagian tetap, jadi isi/lampiran masih bisa diambil per bagian), dipangkas
 * sampai muat; tidak muat sama sekali → `null`.
 */
export function boundMailBodyStructure(
  root: MailBodyStructureNode | null,
  maxBytes = MAIL_BODYSTRUCTURE_MAX_BYTES,
): MailBodyStructureNode | null {
  if (!root) return null;
  const size = (node: MailBodyStructureNode) => Buffer.byteLength(JSON.stringify(node));
  if (size(root) <= maxBytes) return root;
  const leaves: MailBodyStructureNode[] = [];
  const visit = (node: MailBodyStructureNode) => {
    if (leaves.length >= 500) return;
    if (node.childNodes.length === 0) {
      leaves.push({
        ...node,
        filename: node.filename ? node.filename.slice(0, 120) : null,
        id: node.id ? node.id.slice(0, 200) : null,
      });
      return;
    }
    for (const child of node.childNodes) visit(child);
  };
  visit(root);
  for (let count = Math.min(leaves.length, 200); count >= 1; count = Math.floor(count / 2)) {
    const compact: MailBodyStructureNode = {
      ...root,
      type: 'multipart/mixed',
      filename: null,
      id: null,
      childNodes: leaves.slice(0, count),
    };
    if (size(compact) <= maxBytes) return compact;
  }
  return null;
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

/** Penghitung byte masuk satu sambungan (anggaran sambungan + batas per perintah). */
interface ByteMeter {
  received: number;
  /** Batas `received` selama perintah berjalan (lihat `MAIL_COMMAND_MAX_BYTES`). */
  commandLimit: number;
  overBudget: boolean;
  onExceeded: () => void;
}

class ImapFlowSession implements MailImapSession, MailImapActions, MailImapCompose {
  readonly capabilities: MailServerCapabilities;

  private aborted = false;
  private readonly commandMs: number;

  constructor(
    private readonly client: ImapFlow,
    private readonly meter: ByteMeter,
    limits: MailSessionLimits = {},
  ) {
    this.capabilities = capabilitiesOf(client);
    this.commandMs = limits.commandMs ?? MAIL_COMMAND_TIMEOUT_MS;
    limits.signal?.addEventListener('abort', () => this.abort(), { once: true });
    meter.onExceeded = () => this.abort();
    if (meter.overBudget) this.abort();
  }

  private get overBudget(): boolean {
    return this.meter.overBudget;
  }

  abort(): void {
    if (this.aborted) return;
    this.aborted = true;
    try {
      this.client.close();
    } catch {
      // sudah tertutup
    }
    // `close()` imapflow bisa hanya menutup separuh; soket dihancurkan supaya aliran berhenti.
    (this.client as unknown as { socket?: { destroy(): void } }).socket?.destroy();
  }

  /**
   * Satu perintah dengan tenggat dan batas byte; lewat → sambungan diputus. Dipanggil di ekspresi
   * yang sama dengan perintahnya, jadi batas sudah terpasang sebelum byte jawaban pertama tiba.
   */
  private async guard<T>(promise: Promise<T>, maxBytes = MAIL_COMMAND_MAX_BYTES): Promise<T> {
    promise.catch(() => undefined);
    if (this.aborted) throw new ImapFailure('imap_connection_timeout', 'SESSION_ABORTED');
    this.meter.commandLimit = this.meter.received + maxBytes;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => {
        this.abort();
        reject(new ImapFailure('imap_connection_timeout', 'COMMAND_TIMEOUT'));
      }, this.commandMs);
    });
    deadline.catch(() => undefined);
    try {
      return await Promise.race([promise, deadline]);
    } catch (error) {
      if (this.overBudget) throw new ImapFailure('unknown', 'BYTE_BUDGET');
      throw error;
    } finally {
      clearTimeout(timer);
      this.meter.commandLimit = Number.POSITIVE_INFINITY;
    }
  }

  async listFolders(): Promise<MailServerFolder[]> {
    // Tanpa `statusQuery` (imapflow menjalankan STATUS untuk SETIAP folder sebelum selesai): STATUS
    // hanya untuk folder yang disinkron. Banjir LIST dibatasi `MAIL_LIST_MAX_BYTES`.
    const entries = await this.guard(this.client.list(), MAIL_LIST_MAX_BYTES);
    return entries.slice(0, MAIL_MAX_FOLDERS).map((entry) => {
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
      const result = await this.guard(this.client.getQuota('INBOX'));
      const storage = result && typeof result === 'object' ? result.storage : undefined;
      if (!storage || typeof storage.limit !== 'number' || storage.limit <= 0) return null;
      return { usedBytes: storage.usage ?? 0, limitBytes: storage.limit };
    } catch {
      return null;
    }
  }

  async status(path: string): Promise<MailServerFolderStatus> {
    const result = await this.guard(
      this.client.status(path, {
        messages: true,
        unseen: true,
        uidNext: true,
        uidValidity: true,
        ...(this.capabilities.condstore ? { highestModseq: true } : {}),
      }),
    );
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
    const mailbox = await this.guard(this.client.mailboxOpen(path, { readOnly: true }));
    return {
      uidValidity: Number(mailbox.uidValidity),
      uidNext: mailbox.uidNext,
      exists: mailbox.exists,
      highestModseq: modseqOf(mailbox.highestModseq),
    };
  }

  async searchUids(since: Date | null): Promise<number[]> {
    const result = await this.guard(
      this.client.search(since ? { since } : { all: true }, { uid: true }),
      MAIL_SEARCH_MAX_BYTES,
    );
    if (!Array.isArray(result)) return [];
    const uids = result.filter((uid) => Number.isInteger(uid) && uid > 0);
    // Hasil raksasa: hanya UID TERBARU yang dipakai (sinkron dari yang terbaru).
    return uids.length > MAIL_MAX_SEARCH_RESULTS
      ? uids.sort((a, b) => a - b).slice(-MAIL_MAX_SEARCH_RESULTS)
      : uids;
  }

  /**
   * `UID FETCH` lewat iterator (bukan `fetchAll` yang menimbun semuanya dulu): UID yang tidak
   * diminta atau jumlah respons melebihi permintaan → sambungan diputus (review 9A-1 S2).
   */
  private async fetchBounded<T extends { uid: number }>(
    range: string,
    query: Record<string, unknown>,
    options: Record<string, unknown>,
    wanted: ReadonlySet<number> | null,
    max: number,
  ): Promise<T[]> {
    const rows: T[] = [];
    const collect = async () => {
      for await (const row of this.client.fetch(range, query, options) as AsyncIterable<T>) {
        if ((wanted && !wanted.has(row.uid)) || rows.length >= max) {
          this.abort();
          throw new ImapFailure('unknown', 'UNEXPECTED_FETCH');
        }
        rows.push(row);
      }
    };
    await this.guard(collect());
    return rows;
  }

  async fetchHeaders(uids: readonly number[]): Promise<MailServerMessage[]> {
    if (uids.length === 0) return [];
    const wanted = new Set(uids);
    const base = await this.fetchBounded<FetchMessageObject>(
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
      wanted,
      wanted.size,
    );
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
      const previews = await this.fetchBounded<FetchMessageObject>(
        uidSet(partUids),
        { uid: true, bodyParts: [{ key: part, start: 0, maxLength: MAIL_SNIPPET_BYTES }] },
        { uid: true },
        new Set(partUids),
        partUids.length,
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
    const rows = await this.fetchBounded<FetchMessageObject>(
      range,
      { uid: true, flags: true },
      options,
      uids === 'all' ? null : new Set(uids),
      uids === 'all' ? MAIL_MAX_SEARCH_RESULTS : uids.length,
    );
    return rows.map((row) => ({
      uid: row.uid,
      flags: [...(row.flags ?? new Set<string>())].map(String),
      modseq: modseqOf(row.modseq),
    }));
  }

  async openWritable(path: string): Promise<MailSelectedFolder> {
    const mailbox = await this.guard(this.client.mailboxOpen(path, { readOnly: false }));
    return {
      uidValidity: Number(mailbox.uidValidity),
      uidNext: mailbox.uidNext,
      exists: mailbox.exists,
      highestModseq: modseqOf(mailbox.highestModseq),
    };
  }

  private async fetchChunks(
    uid: number,
    maxBytes: number,
    query: (start: number, length: number) => Record<string, unknown>,
    pick: (row: { source?: Buffer; bodyParts?: Map<string, Buffer> }) => Buffer | undefined,
    sink?: (chunk: Buffer) => Promise<void>,
  ): Promise<(MailFetchedBytes & { sizeBytes: number }) | null> {
    // Dengan `sink`: potongan dialirkan (tidak ditampung) dan `bytes` kosong.
    const chunks: Buffer[] = [];
    let total = 0;
    const result = (truncated: boolean) => ({
      bytes: sink ? Buffer.alloc(0) : Buffer.concat(chunks).subarray(0, maxBytes),
      truncated,
      sizeBytes: Math.min(total, maxBytes),
    });
    for (;;) {
      const length = Math.min(MAIL_FETCH_CHUNK_BYTES, maxBytes + 1 - total);
      const row = await this.guard(
        this.client.fetchOne(String(uid), query(total, length), { uid: true }),
      );
      const chunk = row ? pick(row) : undefined;
      if (!chunk) return total === 0 ? null : result(false);
      total += chunk.length;
      if (total > maxBytes) {
        if (!sink) chunks.push(chunk);
        return result(true);
      }
      if (sink) await sink(chunk);
      else chunks.push(chunk);
      if (chunk.length < length) return result(false);
    }
  }

  async fetchSource(uid: number, maxBytes: number): Promise<MailFetchedBytes | null> {
    return this.fetchChunks(
      uid,
      maxBytes,
      (start, length) => ({ uid: true, source: { start, maxLength: length } }),
      (row) => row.source,
    );
  }

  async fetchPart(uid: number, part: string, maxBytes: number): Promise<MailFetchedBytes | null> {
    if (!/^\d+(\.\d+){0,20}$/.test(part)) return null;
    return this.fetchChunks(
      uid,
      maxBytes,
      (start, length) => ({ uid: true, bodyParts: [{ key: part, start, maxLength: length }] }),
      (row) => row.bodyParts?.get(part),
    );
  }

  async fetchPartTo(
    uid: number,
    part: string,
    maxBytes: number,
    sink: (chunk: Buffer) => Promise<void>,
  ): Promise<{ sizeBytes: number; truncated: boolean } | null> {
    if (!/^\d+(\.\d+){0,20}$/.test(part)) return null;
    const fetched = await this.fetchChunks(
      uid,
      maxBytes,
      (start, length) => ({ uid: true, bodyParts: [{ key: part, start, maxLength: length }] }),
      (row) => row.bodyParts?.get(part),
      sink,
    );
    return fetched ? { sizeBytes: fetched.sizeBytes, truncated: fetched.truncated } : null;
  }

  async storeFlags(
    uids: readonly number[],
    add: readonly string[],
    remove: readonly string[],
  ): Promise<boolean> {
    if (uids.length === 0) return true;
    const range = uidSet(uids);
    if (
      add.length > 0 &&
      !(await this.guard(this.client.messageFlagsAdd(range, [...add], { uid: true })))
    ) {
      return false;
    }
    if (
      remove.length > 0 &&
      !(await this.guard(this.client.messageFlagsRemove(range, [...remove], { uid: true })))
    ) {
      return false;
    }
    return true;
  }

  async move(
    uids: readonly number[],
    targetPath: string,
  ): Promise<{ uidMap: Map<number, number>; uidValidity: number | null } | null> {
    if (uids.length === 0) return { uidMap: new Map(), uidValidity: null };
    const range = uidSet(uids);
    type CopyResult =
      { uidMap?: Map<number, number>; uidValidity?: bigint | number } | false | undefined;
    const mapOf = (result: CopyResult) => ({
      uidMap: result && result.uidMap instanceof Map ? result.uidMap : new Map<number, number>(),
      uidValidity: result && result.uidValidity !== undefined ? Number(result.uidValidity) : null,
    });
    if (this.capabilities.move) {
      const result = (await this.guard(
        this.client.messageMove(range, targetPath, { uid: true }),
      )) as CopyResult;
      return result ? mapOf(result) : null;
    }
    const copied = (await this.guard(
      this.client.messageCopy(range, targetPath, { uid: true }),
    )) as CopyResult;
    if (!copied) return null;
    if (!(await this.guard(this.client.messageFlagsAdd(range, ['\\Deleted'], { uid: true }))))
      return null;
    if (this.capabilities.uidplus) {
      // UIDPLUS: imapflow memakai `UID EXPUNGE <uid>` (hanya UID ini).
      await this.guard(this.client.messageDelete(range, { uid: true }));
    }
    return mapOf(copied);
  }

  async expunge(uids: readonly number[]): Promise<boolean> {
    if (uids.length === 0) return true;
    const range = uidSet(uids);
    if (!this.capabilities.uidplus) {
      // Tanpa UIDPLUS `EXPUNGE` biasa bisa menghapus email lain bertanda \Deleted → hanya ditandai.
      return Boolean(
        await this.guard(this.client.messageFlagsAdd(range, ['\\Deleted'], { uid: true })),
      );
    }
    return Boolean(await this.guard(this.client.messageDelete(range, { uid: true })));
  }

  async append(
    path: string,
    raw: Buffer,
    flags: readonly string[],
  ): Promise<{ uid: number | null; uidValidity: number | null } | null> {
    try {
      const result = (await this.guard(this.client.append(path, raw, [...flags]))) as
        { uid?: number; uidValidity?: bigint | number } | false | undefined;
      if (!result) return null;
      return {
        uid: typeof result.uid === 'number' && result.uid > 0 ? result.uid : null,
        uidValidity: result.uidValidity !== undefined ? Number(result.uidValidity) : null,
      };
    } catch {
      return null;
    }
  }

  async searchMessageId(messageId: string, since: Date | null): Promise<number[]> {
    // `Message-ID` dari Balesin sendiri (bukan masukan luar); tetap dibatasi bentuknya.
    if (!/^[A-Za-z0-9._@+=-]{3,200}$/.test(messageId)) return [];
    const result = await this.guard(
      this.client.search(
        { header: { 'message-id': `<${messageId}>` }, ...(since ? { since } : {}) },
        { uid: true },
      ),
      MAIL_SEARCH_MAX_BYTES,
    );
    if (!Array.isArray(result)) return [];
    return result.filter((uid) => Number.isInteger(uid) && uid > 0).slice(0, 50);
  }

  async createFolder(path: string): Promise<boolean> {
    try {
      const result = await this.guard(this.client.mailboxCreate(path));
      return Boolean(result);
    } catch {
      return false;
    }
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
  limits: MailSessionLimits = {},
): Promise<MailImapSession & MailImapActions> {
  const maxBytes = limits.maxBytes ?? MAIL_SESSION_MAX_BYTES;
  // Anggaran byte berlaku SEJAK soket dibuat: server jahat bisa membanjiri sapaan/login atau perintah
  // awal imapflow (`LIST "" ""`, NAMESPACE) sebelum sesi jadi.
  const connecting = new AbortController();
  const meter: ByteMeter = {
    received: 0,
    commandLimit: MAIL_LIST_MAX_BYTES,
    overBudget: false,
    onExceeded: () => connecting.abort(),
  };
  const forward = () => connecting.abort();
  if (limits.signal?.aborted) connecting.abort();
  limits.signal?.addEventListener('abort', forward, { once: true });
  let client: ImapFlow;
  try {
    client = await openImapClient(
      { ...config },
      { ...policy, timeouts: { ...DEFAULT_IMAP_TIMEOUTS, ...policy.timeouts } },
      {
        maxLiteralBytes: SYNC_LITERAL_BYTES,
        signal: connecting.signal,
        onBytes: (bytes) => {
          meter.received += bytes;
          if (
            !meter.overBudget &&
            (meter.received > maxBytes || meter.received > meter.commandLimit)
          ) {
            meter.overBudget = true;
            meter.onExceeded();
          }
        },
      },
    );
  } catch (error) {
    if (meter.overBudget) throw new ImapFailure('unknown', 'BYTE_BUDGET');
    throw error;
  } finally {
    limits.signal?.removeEventListener('abort', forward);
  }
  meter.commandLimit = Number.POSITIVE_INFINITY;
  return new ImapFlowSession(client, meter, limits);
}

/** Pembuka sesi (bisa diganti di tes). */
export type MailImapConnector = (
  config: MailImapConfig,
  policy: ImapPolicy,
  limits?: MailSessionLimits,
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
  const totalMs = Math.min(timeouts.totalMs, 30_000);
  try {
    // Review 9A-1 S2: tenggat yang MEMUTUS sambungan + anggaran byte kecil untuk tes.
    const details = await withMailSession(
      (signal) =>
        (options.connector ?? defaultMailImapConnector)(config, policy, {
          maxBytes: MAIL_TEST_SESSION_MAX_BYTES,
          commandMs: totalMs,
          signal,
        }),
      totalMs,
      async (session) => {
        const folders = await session.listFolders();
        const inbox = folders.find((folder) => folder.path.toUpperCase() === 'INBOX');
        const roles = new Set<string>();
        for (const folder of folders) {
          const role = options.roleOf(folder);
          if (role && role !== 'inbox' && role !== 'all' && role !== 'flagged') roles.add(role);
        }
        const quota = await session.quota();
        let estimate: number | null = null;
        let inboxTotal = 0;
        if (inbox) {
          inboxTotal = inbox.status?.messages ?? (await session.status(inbox.path)).messages;
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
          inboxTotal,
          specialFolders: [...roles],
          idle: session.capabilities.idle,
          quota,
          estimatedInitialSync: estimate,
          capabilities: session.capabilities,
        } satisfies MailIncomingTestDetails;
      },
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
