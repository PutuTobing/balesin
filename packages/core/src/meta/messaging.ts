import type { OutboundMediaKind } from '@balesin/shared';
import { z } from 'zod';

import type { MetaCredentials, MetaGraphClient } from './graph-client';

/**
 * Pengiriman pesan & media WhatsApp Cloud API lewat klien Graph terpusat (kelompok batas laju
 * `messaging`). Sumber (dibaca 16 Nov 2026): developers.facebook.com/docs/whatsapp/cloud-api/
 * reference/messages, /reference/media.
 *
 * Kirim pesan TIDAK pernah diulang otomatis oleh klien (bukan idempoten di sisi Meta: jaringan
 * putus setelah Meta menerima = pesan bisa terkirim dua kali). Pengulangan diputuskan pemanggil
 * (worker) hanya untuk penolakan yang jelas belum diproses Meta (batas laju / gangguan sementara).
 */

/** Isi pesan keluar dalam bentuk netral (dibangun worker dari baris `messages`). */
export type OutboundContent =
  | { type: 'text'; text: string }
  | {
      type: 'media';
      kind: OutboundMediaKind;
      metaMediaId: string;
      caption: string | null;
      filename: string | null;
    }
  | {
      type: 'location';
      latitude: number;
      longitude: number;
      name: string | null;
      address: string | null;
    }
  | { type: 'reaction'; targetWamid: string; emoji: string };

export interface OutboundEnvelope {
  /** Nomor tujuan tanpa `+` (wa_id). */
  to: string;
  content: OutboundContent;
  /** wamid pesan yang dikutip (balas-kutip). */
  replyToWamid: string | null;
}

/** Body `POST /{phone-number-id}/messages`. */
export function buildOutboundPayload(envelope: OutboundEnvelope): Record<string, unknown> {
  const { content } = envelope;
  const base: Record<string, unknown> = {
    messaging_product: 'whatsapp',
    recipient_type: 'individual',
    to: envelope.to,
  };
  // Reaksi tidak mendukung `context`.
  if (envelope.replyToWamid && content.type !== 'reaction') {
    base.context = { message_id: envelope.replyToWamid };
  }
  switch (content.type) {
    case 'text':
      return { ...base, type: 'text', text: { body: content.text, preview_url: false } };
    case 'location':
      return {
        ...base,
        type: 'location',
        location: {
          latitude: content.latitude,
          longitude: content.longitude,
          ...(content.name ? { name: content.name } : {}),
          ...(content.address ? { address: content.address } : {}),
        },
      };
    case 'reaction':
      return {
        ...base,
        type: 'reaction',
        reaction: { message_id: content.targetWamid, emoji: content.emoji },
      };
    case 'media': {
      const media: Record<string, unknown> = { id: content.metaMediaId };
      // Audio tidak mendukung keterangan; nama berkas hanya untuk dokumen.
      if (content.caption && content.kind !== 'audio') media.caption = content.caption;
      if (content.kind === 'document' && content.filename) media.filename = content.filename;
      return { ...base, type: content.kind, [content.kind]: media };
    }
  }
}

const sendResponseSchema = z.object({
  messages: z
    .array(
      z.object({
        id: z
          .string()
          .min(1)
          .max(256)
          .regex(/^[A-Za-z0-9._=+/:-]+$/),
      }),
    )
    .min(1),
});

/** Mengirim pesan; mengembalikan wamid dari Meta. */
export async function sendWhatsAppMessage(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  phoneNumberId: string,
  envelope: OutboundEnvelope,
): Promise<{ wamid: string }> {
  const response = await client.request(credentials, {
    operation: 'message.send',
    method: 'POST',
    path: [phoneNumberId, 'messages'],
    body: buildOutboundPayload(envelope),
    schema: sendResponseSchema,
    rateLimitGroup: 'messaging',
  });
  const [first] = response.messages;
  if (!first) throw new Error('Jawaban kirim pesan tanpa ID');
  return { wamid: first.id };
}

const uploadResponseSchema = z.object({
  id: z
    .string()
    .min(1)
    .max(256)
    .regex(/^[0-9]+$/),
});

/** Unggah berkas ke Meta (`POST /{phone-number-id}/media`) → ID media (berlaku ±30 hari). */
export async function uploadWhatsAppMedia(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  phoneNumberId: string,
  /** `bytes` (memori) atau `blob` berbasis berkas (`fs.openAsBlob`, dialirkan — review S1). */
  file: { bytes?: Uint8Array; blob?: Blob; mimeType: string; filename: string },
  options: { signal?: AbortSignal } = {},
): Promise<{ id: string }> {
  const form = new FormData();
  form.set('messaging_product', 'whatsapp');
  form.set('type', file.mimeType);
  const blob = file.blob ?? new Blob([file.bytes ?? new Uint8Array()], { type: file.mimeType });
  form.set('file', blob, file.filename);
  return client.request(credentials, {
    operation: 'media.upload',
    method: 'POST',
    path: [phoneNumberId, 'media'],
    form,
    schema: uploadResponseSchema,
    rateLimitGroup: 'messaging',
    signal: options.signal,
  });
}

const mediaInfoSchema = z.object({
  url: z.string().url().max(4096),
  mime_type: z.string().max(256).optional(),
  file_size: z.coerce.number().int().nonnegative().optional(),
});

/** URL unduhan sementara untuk ID media (`GET /{media-id}`); unduh lewat `client.download`. */
export async function readWhatsAppMediaUrl(
  client: MetaGraphClient,
  credentials: MetaCredentials,
  mediaId: string,
  options: { signal?: AbortSignal } = {},
): Promise<{ url: string; fileSize: number | null }> {
  const info = await client.request(credentials, {
    operation: 'media.read',
    method: 'GET',
    path: [mediaId],
    schema: mediaInfoSchema,
    rateLimitGroup: 'messaging',
    signal: options.signal,
  });
  return { url: info.url, fileSize: info.file_size ?? null };
}
