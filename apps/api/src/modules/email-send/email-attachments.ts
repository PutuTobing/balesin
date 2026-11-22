import {
  classifyOutboundEmailAttachment,
  cleanFileName,
  fetchRemoteFile,
  type Lookup,
  type MediaStore,
  type RemoteFileError,
} from '@balesin/core';
import { mediaFiles, type DbExecutor } from '@balesin/db';
import {
  EMAIL_ATTACHMENTS_MAX,
  EMAIL_ATTACHMENT_MAX_BYTES,
  EMAIL_CID_PATTERN,
  emailAttachmentHostAllowed,
  type EmailAttachmentInput,
} from '@balesin/shared';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z } from 'zod';

import { detail, emailError, invalid } from './email-content';

/**
 * Lampiran email lewat API (tahap 9.1, §3.5). Tepat satu sumber per lampiran: `contentBase64`,
 * `mediaId` (unggahan key yang SAMA untuk pengirim yang SAMA), atau `url` (host harus cocok allowlist
 * key SEBELUM DNS; diambil dengan `fetchRemoteFile` = aturan SSRF webhook keluar, setiap redirect
 * diperiksa ulang allowlist host + SSRF). Jenis dari ISI. Isi & URL utuh tidak pernah di-log.
 */

export interface PreparedAttachment {
  filename: string;
  contentType: string;
  content: Buffer;
  source: 'base64' | 'media' | 'url' | 'qris' | 'logo';
  /** Host URL saja (sumber `url`). */
  sourceHost: string | null;
  inline: boolean;
  contentId: string | null;
}

export interface AttachmentContext {
  organizationId: string;
  apiKeyId: string;
  channelId: string;
  allowedHosts: readonly string[];
  privateCidrs: readonly string[];
  /** CID yang sudah dipakai (logo, QRIS) — lampiran tidak boleh bentrok. */
  reservedCids: readonly string[];
  store: MediaStore;
  now: Date;
  remote?: { lookup?: Lookup; allowLoopback?: boolean; perFileTimeoutMs?: number };
}

const UUID = z.uuid();
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;
const PER_FILE_TIMEOUT_MS = 15_000;
const TOTAL_TIMEOUT_MS = 45_000;
const PARALLEL_FETCHES = 3;

const FETCH_REASONS: Readonly<Record<RemoteFileError, string>> = {
  invalid_url: 'alamatnya tidak valid',
  scheme: 'alamat harus diawali https://',
  port: 'port tidak diizinkan',
  credentials: 'alamat tidak boleh memuat nama pengguna/password',
  https_required: 'alamat publik wajib memakai https://',
  blocked_address: 'alamat terlarang (loopback, link-local, atau metadata cloud)',
  private_not_allowed:
    'alamat jaringan privat belum diizinkan (Pengaturan → Integrasi → allowlist IP privat)',
  dns: 'nama host tidak ditemukan',
  timeout: 'server terlalu lama menjawab',
  network: 'sambungan ke server gagal',
  redirect: 'pengalihan tidak valid atau terlalu banyak',
  too_large: 'berkas lebih dari 20 MB',
  http: 'server menjawab galat',
  host_not_allowed: 'pengalihan ke host yang tidak diizinkan',
};

const tooLarge = (field: string) =>
  invalid(field, 'attachment_too_large', 'Setiap lampiran dan total lampiran maksimal 20 MB.');

function hostOf(url: string): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') return null;
    return parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  } catch {
    return null;
  }
}

async function readAll(store: MediaStore, storageKey: string): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of store.chunks(storageKey)) chunks.push(chunk);
  return Buffer.concat(chunks);
}

/** Pemeriksaan murah (sumber, nama, CID, host URL) — SEBELUM mengambil URL apa pun. */
function preflight(
  items: readonly EmailAttachmentInput[],
  context: AttachmentContext,
): { filename: string; host: string | null }[] {
  if (items.length > EMAIL_ATTACHMENTS_MAX) {
    throw invalid('attachments', 'attachments_too_many', 'Lampiran maksimal 10 berkas.');
  }
  const cids = new Set(context.reservedCids.map((cid) => cid.toLowerCase()));
  return items.map((item, index) => {
    const field = `attachments.${String(index)}`;
    const sources = [item.contentBase64, item.mediaId, item.url].filter(
      (value) => value !== undefined,
    );
    if (sources.length !== 1) {
      throw invalid(
        field,
        'attachment_source_invalid',
        'Setiap lampiran butuh tepat satu sumber: contentBase64, mediaId, atau url.',
      );
    }
    const filename = cleanFileName(item.filename);
    if (!filename) {
      throw invalid(
        `${field}.filename`,
        'attachment_source_invalid',
        'Nama berkas lampiran kosong.',
      );
    }
    if (item.cid !== undefined || item.inline === true) {
      if (item.inline !== true || item.cid === undefined || !EMAIL_CID_PATTERN.test(item.cid)) {
        throw invalid(
          `${field}.cid`,
          'attachment_source_invalid',
          'Gambar inline butuh inline: true dan cid (huruf/angka/._-, maks. 64).',
        );
      }
      if (cids.has(item.cid.toLowerCase())) {
        throw invalid(
          `${field}.cid`,
          'attachment_source_invalid',
          `cid "${item.cid}" sudah dipakai gambar lain di email ini.`,
        );
      }
      cids.add(item.cid.toLowerCase());
    }
    let host: string | null = null;
    if (item.url !== undefined) {
      host = hostOf(item.url);
      if (!host) {
        throw invalid(
          `${field}.url`,
          'attachment_fetch_failed',
          'Lampiran dari URL tidak bisa diambil: alamatnya tidak valid.',
        );
      }
      if (!emailAttachmentHostAllowed(host, context.allowedHosts)) {
        throw emailError('FORBIDDEN', [
          detail(
            `${field}.url`,
            'attachment_host_not_allowed',
            'Host lampiran ini tidak ada di daftar host yang diizinkan untuk API key ini.',
          ),
        ]);
      }
    }
    return { filename, host };
  });
}

export async function resolveAttachments(
  db: DbExecutor,
  items: readonly EmailAttachmentInput[],
  context: AttachmentContext,
): Promise<PreparedAttachment[]> {
  const checked = preflight(items, context);
  const deadline = Date.now() + TOTAL_TIMEOUT_MS;

  const loadOne = async (
    item: EmailAttachmentInput,
    index: number,
  ): Promise<PreparedAttachment> => {
    const field = `attachments.${String(index)}`;
    const { filename, host } = checked[index] as { filename: string; host: string | null };
    let content: Buffer;
    let source: PreparedAttachment['source'];
    if (item.contentBase64 !== undefined) {
      const compact = item.contentBase64.replace(/\s+/g, '');
      if (!BASE64.test(compact) || compact.length % 4 === 1) {
        throw invalid(
          `${field}.contentBase64`,
          'attachment_source_invalid',
          'contentBase64 bukan base64 yang sah (tanpa awalan data:).',
        );
      }
      if (Math.floor((compact.length * 3) / 4) > EMAIL_ATTACHMENT_MAX_BYTES + 3)
        throw tooLarge(field);
      content = Buffer.from(compact, 'base64');
      source = 'base64';
    } else if (item.mediaId !== undefined) {
      const notFound = invalid(
        `${field}.mediaId`,
        'attachment_media_not_found',
        'Lampiran mediaId tidak ditemukan atau sudah kedaluwarsa.',
      );
      if (!UUID.safeParse(item.mediaId).success) throw notFound;
      const [file] = await db
        .select({ storageKey: mediaFiles.storageKey, sizeBytes: mediaFiles.sizeBytes })
        .from(mediaFiles)
        .where(
          and(
            eq(mediaFiles.organizationId, context.organizationId),
            eq(mediaFiles.id, item.mediaId),
            eq(mediaFiles.channelId, context.channelId),
            eq(mediaFiles.uploadedByApiKeyId, context.apiKeyId),
            isNull(mediaFiles.deletedAt),
            gt(mediaFiles.expiresAt, context.now),
          ),
        )
        .limit(1);
      if (!file?.storageKey) throw notFound;
      if (file.sizeBytes > EMAIL_ATTACHMENT_MAX_BYTES) throw tooLarge(field);
      try {
        content = await readAll(context.store, file.storageKey);
      } catch {
        throw notFound;
      }
      source = 'media';
    } else {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        throw invalid(
          `${field}.url`,
          'attachment_fetch_failed',
          'Lampiran dari URL tidak bisa diambil: server terlalu lama menjawab.',
        );
      }
      const allowed = context.allowedHosts;
      const result = await fetchRemoteFile({
        url: item.url ?? '',
        privateCidrs: context.privateCidrs,
        maxBytes: EMAIL_ATTACHMENT_MAX_BYTES,
        timeoutMs: Math.min(context.remote?.perFileTimeoutMs ?? PER_FILE_TIMEOUT_MS, remaining),
        maxRedirects: 3,
        allowHost: (hostname) => emailAttachmentHostAllowed(hostname, allowed),
        ...(context.remote?.lookup ? { lookup: context.remote.lookup } : {}),
        ...(context.remote?.allowLoopback ? { allowLoopback: true } : {}),
      });
      if (!result.ok) {
        if (result.error === 'host_not_allowed') {
          throw emailError('FORBIDDEN', [
            detail(
              `${field}.url`,
              'attachment_host_not_allowed',
              'Lampiran dialihkan ke host yang tidak ada di daftar host yang diizinkan untuk API key ini.',
            ),
          ]);
        }
        if (result.error === 'too_large') throw tooLarge(field);
        const why =
          result.error === 'http' && result.httpStatus !== null
            ? `server menjawab ${String(result.httpStatus)}`
            : FETCH_REASONS[result.error];
        throw invalid(
          `${field}.url`,
          'attachment_fetch_failed',
          `Lampiran dari URL tidak bisa diambil: ${why}.`,
        );
      }
      content = result.body;
      source = 'url';
    }
    if (content.length > EMAIL_ATTACHMENT_MAX_BYTES) throw tooLarge(field);
    const verdict = classifyOutboundEmailAttachment(content, filename);
    if (!verdict.ok) {
      throw invalid(
        field,
        verdict.reason === 'empty' ? 'attachment_source_invalid' : 'attachment_type_blocked',
        verdict.reason === 'empty'
          ? 'Berkas lampiran kosong.'
          : 'Jenis berkas ini tidak boleh dilampirkan (program, makro, HTML, atau arsip).',
      );
    }
    if (item.inline === true && !verdict.rasterImage) {
      throw invalid(
        `${field}.inline`,
        'attachment_type_blocked',
        'Lampiran inline hanya untuk gambar PNG, JPEG, GIF, atau WebP.',
      );
    }
    return {
      filename,
      contentType: verdict.mimeType,
      content,
      source,
      sourceHost: host,
      inline: item.inline === true,
      contentId: item.inline === true ? (item.cid ?? null) : null,
    };
  };

  // Maks. 3 berkas diambil bersamaan; galat pertama (urutan lampiran) yang dilaporkan.
  const results: PreparedAttachment[] = new Array<PreparedAttachment>(items.length);
  for (let start = 0; start < items.length; start += PARALLEL_FETCHES) {
    const batch = items.slice(start, start + PARALLEL_FETCHES);
    const settled = await Promise.allSettled(
      batch.map((item, offset) => loadOne(item, start + offset)),
    );
    for (const [offset, outcome] of settled.entries()) {
      if (outcome.status === 'rejected') throw outcome.reason;
      results[start + offset] = outcome.value;
    }
  }
  const total = results.reduce((sum, part) => sum + part.content.length, 0);
  if (total > EMAIL_ATTACHMENT_MAX_BYTES) throw tooLarge('attachments');
  return results;
}
