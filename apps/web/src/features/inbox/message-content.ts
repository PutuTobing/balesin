import type { Message, MessagePreview, MessageType } from '@balesin/shared';
import {
  Contact,
  File,
  FileText,
  Image as ImageIcon,
  Info,
  LayoutTemplate,
  MapPin,
  Mic,
  MousePointerClick,
  Music,
  SmilePlus,
  Sticker,
  TriangleAlert,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { t } from '../../i18n/id';

/**
 * Isi pesan sebagai TEKS: jenis selain teks diberi label ("Gambar", "Dokumen: nama.pdf").
 * Semua isi dari pelanggan (teks, keterangan, nama berkas, alamat) dikembalikan apa adanya
 * untuk dirender sebagai teks React biasa — tidak pernah sebagai HTML.
 */

const typeIcons: Partial<Record<MessageType, LucideIcon>> = {
  image: ImageIcon,
  video: Video,
  audio: Music,
  document: FileText,
  sticker: Sticker,
  location: MapPin,
  contacts: Contact,
  interactive: MousePointerClick,
  reaction: SmilePlus,
  system: Info,
  template: LayoutTemplate,
  unsupported: TriangleAlert,
};

const c = t.inbox.content;

function typeLabel(type: MessageType): string | null {
  switch (type) {
    case 'text':
      return null;
    case 'image':
      return c.image;
    case 'video':
      return c.video;
    case 'audio':
      return c.audio;
    case 'document':
      return c.document;
    case 'sticker':
      return c.sticker;
    case 'location':
      return c.location;
    case 'contacts':
      return c.contacts(1);
    case 'interactive':
      return c.interactive;
    case 'reaction':
      return c.reaction;
    case 'system':
      return c.system;
    case 'unsupported':
      return c.unsupported;
    case 'template':
      return c.template;
  }
}

export interface PreviewContent {
  icon: LucideIcon | null;
  /** Teks cuplikan (input pelanggan atau label jenis). */
  text: string;
}

/** Cuplikan pesan terakhir di baris daftar chat. */
export function previewContent(preview: MessagePreview | null): PreviewContent {
  if (!preview) return { icon: null, text: t.inbox.item.noMessage };
  const icon = typeIcons[preview.type] ?? null;
  const text = preview.text?.trim();
  if (preview.type === 'text') return { icon: null, text: text || '' };
  return { icon, text: text || (typeLabel(preview.type) ?? '') };
}

export interface MessageBody {
  icon: LucideIcon | null;
  /** Label jenis (mis. "Gambar", "Dokumen: tagihan.pdf"); `null` untuk pesan teks. */
  label: string | null;
  /** Keterangan tambahan di bawah label (alamat lokasi, deskripsi pilihan), sebagai teks. */
  detail: string | null;
  /** Teks/keterangan dari pelanggan. */
  text: string | null;
}

function coordinate(value: number): string {
  return value.toFixed(5);
}

/** Isi gelembung pesan di ruang chat. */
export function messageBody(message: Message): MessageBody {
  const text = message.text?.trim() ? message.text : null;
  const icon = typeIcons[message.type] ?? null;
  switch (message.type) {
    case 'text':
      return { icon: null, label: null, detail: null, text };
    case 'audio':
      return {
        icon: message.media?.voice ? Mic : Music,
        label: message.media?.voice ? c.voice : c.audio,
        detail: null,
        text,
      };
    case 'document': {
      const filename = message.media?.filename?.trim();
      return {
        icon: filename ? FileText : File,
        label: filename ? c.documentNamed(filename) : c.document,
        detail: null,
        text,
      };
    }
    case 'sticker':
      return {
        icon,
        label: message.media?.animated ? c.animatedSticker : c.sticker,
        detail: null,
        text: null,
      };
    case 'location': {
      const location = message.location;
      const place = [location?.name, location?.address].filter(Boolean).join(' · ');
      return {
        icon,
        label: c.location,
        detail: location
          ? place || c.coordinates(coordinate(location.latitude), coordinate(location.longitude))
          : null,
        text,
      };
    }
    case 'contacts':
      return { icon, label: c.contacts(message.sharedContactsCount), detail: null, text };
    case 'interactive': {
      // Keluar (tombol/daftar dari agen/bot): isi pesan = body; pilihannya dirender terpisah.
      const outgoing = message.interactiveMessage;
      if (outgoing) {
        return {
          icon,
          label: outgoing.kind === 'list' ? c.outList : c.outButtons,
          detail: outgoing.header?.trim() ? outgoing.header : null,
          text,
        };
      }
      const reply = message.interactive;
      const label =
        reply?.kind === 'list_reply'
          ? c.listReply
          : reply?.kind === 'nfm_reply'
            ? c.flowReply
            : c.interactive;
      return {
        icon,
        label,
        detail: reply?.description ?? null,
        text: text ?? reply?.title ?? null,
      };
    }
    case 'template':
      // Template Meta: nama template sebagai label; isi = body yang sudah diisi (OTP tersamar).
      return {
        icon: LayoutTemplate,
        label: message.template ? c.templateNamed(message.template.name) : c.template,
        detail: null,
        text,
      };
    case 'system':
      return { icon, label: text ? null : c.system, detail: null, text };
    case 'unsupported':
      return {
        icon,
        label: c.unsupported,
        detail: unsupportedKind(message.rawType),
        text,
      };
    default:
      return { icon, label: typeLabel(message.type), detail: null, text };
  }
}

/**
 * Jenis Meta yang belum didukung, dalam bahasa Indonesia. Nama mentah tidak ditampilkan (cukup di
 * `title`); jenis yang tidak dikenal tidak diberi keterangan.
 */
export function unsupportedKind(rawType: string | null): string | null {
  if (!rawType) return null;
  return (c.unsupportedKinds as Readonly<Record<string, string>>)[rawType] ?? null;
}

/**
 * Nama host tautan iklan, untuk DITONJOLKAN di samping URL lengkap (URL tetap teks biasa,
 * bukan tautan yang bisa diklik — `sourceUrl` tidak tepercaya).
 */
export function linkHost(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.hostname : null;
  } catch {
    return null;
  }
}
