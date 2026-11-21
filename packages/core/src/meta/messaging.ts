import type { InteractiveMessage, OutboundMediaKind } from '@balesin/shared';
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
  | { type: 'reaction'; targetWamid: string; emoji: string }
  | { type: 'interactive'; interactive: InteractiveMessage }
  | {
      type: 'template';
      name: string;
      language: string;
      /** `components` pengiriman (parameter header/body/tombol) — dibangun `templateSendComponents`. */
      components: Record<string, unknown>[];
    };

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
    case 'interactive':
      return { ...base, type: 'interactive', interactive: interactivePayload(content.interactive) };
    case 'template':
      return {
        ...base,
        type: 'template',
        template: {
          name: content.name,
          language: { code: content.language },
          ...(content.components.length > 0 ? { components: content.components } : {}),
        },
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

/** Objek `interactive` Cloud API (`button` → `reply` buttons, `list` → sections/rows). */
export function interactivePayload(message: InteractiveMessage): Record<string, unknown> {
  const shared: Record<string, unknown> = {
    body: { text: message.body },
    ...(message.header?.trim() ? { header: { type: 'text', text: message.header } } : {}),
    ...(message.footer?.trim() ? { footer: { text: message.footer } } : {}),
  };
  if (message.kind === 'button') {
    return {
      type: 'button',
      ...shared,
      action: {
        buttons: message.buttons.map((button) => ({
          type: 'reply',
          reply: { id: button.id, title: button.title },
        })),
      },
    };
  }
  return {
    type: 'list',
    ...shared,
    action: {
      button: message.buttonText,
      sections: message.sections.map((section) => ({
        ...(section.title?.trim() ? { title: section.title } : {}),
        rows: section.rows.map((row) => ({
          id: row.id,
          title: row.title,
          ...(row.description?.trim() ? { description: row.description } : {}),
        })),
      })),
    },
  };
}

/**
 * Parameter pengiriman template (`template.components`): header (teks / media dari ID Meta), body
 * (urut variabel; bernama → `parameter_name`), tombol URL/salin kode per indeks.
 */
export function templateSendComponents(input: {
  named: boolean;
  headerFormat: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT' | null;
  headerVariable: string | null;
  headerText: string | null;
  headerMetaMediaId: string | null;
  bodyVariables: readonly string[];
  values: Readonly<Record<string, string>>;
  buttons: readonly { index: number; type: 'URL' | 'COPY_CODE'; value: string }[];
}): Record<string, unknown>[] {
  const text = (name: string, value: string) => ({
    type: 'text',
    text: value,
    ...(input.named ? { parameter_name: name } : {}),
  });
  const components: Record<string, unknown>[] = [];
  if (input.headerFormat === 'TEXT' && input.headerVariable && input.headerText !== null) {
    components.push({ type: 'header', parameters: [text(input.headerVariable, input.headerText)] });
  } else if (input.headerFormat && input.headerFormat !== 'TEXT' && input.headerMetaMediaId) {
    const kind = input.headerFormat.toLowerCase();
    components.push({
      type: 'header',
      parameters: [{ type: kind, [kind]: { id: input.headerMetaMediaId } }],
    });
  }
  if (input.bodyVariables.length > 0) {
    components.push({
      type: 'body',
      parameters: input.bodyVariables.map((name) => text(name, input.values[name] ?? '')),
    });
  }
  for (const button of input.buttons) {
    components.push({
      type: 'button',
      sub_type: button.type === 'URL' ? 'url' : 'copy_code',
      index: String(button.index),
      parameters: [
        button.type === 'URL'
          ? { type: 'text', text: button.value }
          : { type: 'coupon_code', coupon_code: button.value },
      ],
    });
  }
  return components;
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
