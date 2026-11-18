import type { ChannelType } from './channels';
import type { MessageType } from './inbox';

/**
 * Aturan per jenis channel (Fase 6, docs/KONTRAK-API-CHANNEL-LAIN.md "Kemampuan per channel").
 *
 * Inbox, penanganan, panel, laporan, webhook keluar, dan bot bekerja di SEMUA jenis channel. Yang
 * berbeda hanya aturan kirim berikut — dipakai api (validasi kirim), worker (pemeriksaan ulang saat
 * kirim, jendela), dan web (menyembunyikan tombol yang tidak berlaku).
 *
 * - `customerWindow`: pesan biasa hanya boleh dalam 24 jam sejak pesan pelanggan terakhir.
 *   WhatsApp (di luarnya: template), Messenger & Instagram (di luarnya: tag pesan — BELUM didukung
 *   v1, jadi pesan ditolak `WINDOW_CLOSED`). Telegram & Email tidak punya jendela.
 * - `templates`: template Meta (WhatsApp saja).
 * - `broadcast`: kampanye broadcast (v1: WhatsApp saja).
 * - `initiate`: memulai percakapan baru ke pelanggan yang belum pernah menghubungi (v1: WhatsApp
 *   lewat template saja; channel lain hanya membalas).
 * - `messageTypes`: jenis pesan KELUAR yang bisa dikirim agen/API.
 */
export interface ChannelCapabilities {
  customerWindow: boolean;
  templates: boolean;
  broadcast: boolean;
  initiate: boolean;
  /** Balas-kutip pesan tertentu. */
  quoteReply: boolean;
  messageTypes: readonly OutboundMessageKind[];
  /** Batas ukuran satu berkas keluar (byte) — juga dipotong batas per jenis media WhatsApp. */
  maxOutboundMediaBytes: number;
}

/** Jenis isi pesan KELUAR (`SendMessageRequest.type` + jenis media). */
export type OutboundMessageKind =
  'text' | 'media' | 'location' | 'reaction' | 'interactive' | 'template';

export const CHANNEL_CAPABILITIES: Readonly<Record<ChannelType, ChannelCapabilities>> = {
  whatsapp: {
    customerWindow: true,
    templates: true,
    broadcast: true,
    initiate: true,
    quoteReply: true,
    messageTypes: ['text', 'media', 'location', 'reaction', 'interactive', 'template'],
    maxOutboundMediaBytes: 100 * 1024 * 1024,
  },
  telegram: {
    customerWindow: false,
    templates: false,
    broadcast: false,
    initiate: false,
    quoteReply: true,
    // Tombol/daftar → tombol inline (callback). Reaksi bot dibatasi Telegram → belum didukung.
    messageTypes: ['text', 'media', 'location', 'interactive'],
    // Bot API: unggah berkas maks. 50 MB.
    maxOutboundMediaBytes: 50 * 1024 * 1024,
  },
  email: {
    customerWindow: false,
    templates: false,
    broadcast: false,
    initiate: false,
    // Email selalu membalas utas (In-Reply-To/References); kutipan pesan tertentu tidak perlu.
    quoteReply: false,
    messageTypes: ['text', 'media'],
    // Banyak server email menolak email > 25 MB setelah base64 (±33% lebih besar).
    maxOutboundMediaBytes: 15 * 1024 * 1024,
  },
  messenger: {
    customerWindow: true,
    templates: false,
    broadcast: false,
    initiate: false,
    quoteReply: false,
    messageTypes: ['text', 'media'],
    maxOutboundMediaBytes: 25 * 1024 * 1024,
  },
  instagram: {
    customerWindow: true,
    templates: false,
    broadcast: false,
    initiate: false,
    quoteReply: false,
    messageTypes: ['text', 'media'],
    maxOutboundMediaBytes: 25 * 1024 * 1024,
  },
};

/** Jendela 24 jam berlaku untuk channel ini. */
export function channelHasCustomerWindow(type: ChannelType): boolean {
  return CHANNEL_CAPABILITIES[type].customerWindow;
}

/** Jenis pesan keluar boleh dikirim di channel ini. */
export function channelSupportsOutbound(type: ChannelType, kind: OutboundMessageKind): boolean {
  return CHANNEL_CAPABILITIES[type].messageTypes.includes(kind);
}

/** Jenis baris pesan (`messages.type`) → jenis isi keluar untuk pemeriksaan kemampuan. */
export function outboundKindOfMessageType(type: MessageType): OutboundMessageKind | null {
  switch (type) {
    case 'text':
    case 'location':
    case 'reaction':
    case 'interactive':
    case 'template':
      return type;
    case 'image':
    case 'audio':
    case 'video':
    case 'document':
      return 'media';
    default:
      return null;
  }
}

/**
 * Jenis channel non-WhatsApp yang SIAP dibuat. Messenger & Instagram DM disiapkan (adaptor + tes
 * dengan server tiruan) tetapi bawaannya nonaktif: aplikasi Meta perlu lolos App Review
 * (`pages_messaging` / `instagram_manage_messages`) sebelum bisa melayani pelanggan umum.
 */
export const CHANNEL_TYPE_AVAILABILITY: Readonly<
  Record<ChannelType, { available: boolean; reason: string | null }>
> = {
  whatsapp: { available: true, reason: null },
  telegram: { available: true, reason: null },
  email: { available: true, reason: null },
  messenger: {
    available: true,
    reason:
      'Butuh App Review Meta (izin pages_messaging). Channel dibuat dalam keadaan nonaktif; aktifkan setelah aplikasi Meta-mu disetujui dan tes koneksi berhasil.',
  },
  instagram: {
    available: true,
    reason:
      'Butuh App Review Meta (izin instagram_manage_messages) dan akun Instagram profesional yang terhubung ke Halaman Facebook. Channel dibuat dalam keadaan nonaktif; aktifkan setelah disetujui dan tes koneksi berhasil.',
  },
};
