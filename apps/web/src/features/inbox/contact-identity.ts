import {
  CHANNEL_TYPE_LABELS,
  type ChannelType,
  type Contact,
  type ContactSummary,
} from '@balesin/shared';
import { t } from '../../i18n/id';

/**
 * Identitas kontak di Inbox. Nama bisa berasal dari pelanggan sendiri (nama profil WhatsApp,
 * tidak tepercaya — bisa meniru nama orang lain), jadi nomor/@username SELALU tampil di
 * sampingnya (PROGRESS "Web inbox"). Semua nilai dirender sebagai teks biasa.
 */

/**
 * Nomor E.164 yang mudah dibaca. Indonesia: `+6281234567890` → `+62 812-3456-7890`.
 * Nomor negara lain dibiarkan apa adanya.
 */
export function formatPhone(phone: string | null | undefined): string | null {
  if (!phone) return null;
  const match = /^\+62(\d{3})(\d{3,4})(\d{3,5})$/.exec(phone);
  if (!match) return phone;
  return `+62 ${match[1]}-${match[2]}-${match[3]}`;
}

/** `@username` (dengan satu `@` di depan). */
export function formatUsername(username: string | null | undefined): string | null {
  if (!username) return null;
  return username.startsWith('@') ? username : `@${username}`;
}

export interface ContactIdentity {
  /** Nama utama. */
  name: string;
  /** Nomor atau @username yang tampil di samping nama; `null` bila nama itu sendiri nomornya. */
  handle: string | null;
  /** Nama berasal dari profil WhatsApp pelanggan (belum diberi nama oleh tim). */
  fromWhatsApp: boolean;
  /**
   * Nama berasal dari profil channel lain (Telegram/Email/Messenger/Instagram) — sama tidak
   * tepercayanya; `@username`/alamat (`channelHandle`) selalu tampil di sampingnya.
   */
  fromChannel: boolean;
}

/** Hanya angka (untuk membandingkan nama dengan nomor tanpa peduli format). */
function digits(value: string): string {
  return value.replace(/\D/g, '');
}

function isSameHandle(name: string, handle: string, raw: string | null): boolean {
  if (name === handle || name === raw) return true;
  const nameDigits = digits(name);
  return nameDigits.length >= 6 && nameDigits === digits(handle) && /^[\d\s+()-]+$/.test(name);
}

/**
 * Identitas dari ringkasan kontak di daftar. Nomor (atau @username bila tanpa nomor) selalu
 * menyertai nama; `nameSource: 'whatsapp'` = nama kiriman pelanggan → penanda "dari WhatsApp".
 */
export function summaryIdentity(contact: ContactSummary): ContactIdentity {
  const phone = formatPhone(contact.phone);
  const handleValue = phone ?? formatUsername(contact.waUsername) ?? contact.channelHandle ?? null;
  const same =
    handleValue !== null &&
    (isSameHandle(contact.displayName, handleValue, contact.phone) ||
      contact.displayName === contact.waUsername);
  return {
    name: same && handleValue ? handleValue : contact.displayName,
    handle: same ? null : handleValue,
    fromWhatsApp: contact.nameSource === 'whatsapp',
    fromChannel: contact.nameSource === 'channel',
  };
}

/** Identitas dari kontak lengkap (`GET /contacts/:id`). */
export function contactIdentity(contact: Contact): ContactIdentity {
  const phone = formatPhone(contact.phone);
  const username = formatUsername(contact.waUsername);
  const handleValue = phone ?? username ?? contact.channelHandle ?? null;
  const name =
    contact.name?.trim() ||
    contact.profileName?.trim() ||
    handleValue ||
    contact.displayName ||
    `#${contact.number}`;
  const handle =
    handleValue && !isSameHandle(name, handleValue, contact.phone) ? handleValue : null;
  return {
    name,
    handle,
    fromWhatsApp:
      !contact.name?.trim() &&
      Boolean(contact.profileName?.trim()) &&
      contact.channelType === 'whatsapp',
    fromChannel:
      !contact.name?.trim() &&
      Boolean(contact.profileName?.trim()) &&
      contact.channelType !== 'whatsapp',
  };
}

/**
 * Inisial avatar: huruf pertama dua kata pertama yang diawali huruf. Nama tanpa huruf
 * (mis. nomor telepon) → `null`, avatar memakai ikon orang.
 */
export function avatarInitials(name: string): string | null {
  const words = name
    .trim()
    .split(/\s+/)
    .filter((word) => /^\p{L}/u.test(word));
  const letters = words.slice(0, 2).map((word) => Array.from(word)[0] ?? '');
  const text = letters.join('').toLocaleUpperCase('id-ID');
  return text || null;
}

/** "dari WhatsApp" / "dari Telegram" untuk nama kiriman pelanggan; `null` bila nama dari tim. */
export function untrustedNameLabel(
  identity: Pick<ContactIdentity, 'fromWhatsApp' | 'fromChannel'>,
  channelType: ChannelType | undefined,
): string | null {
  if (identity.fromWhatsApp) return t.inbox.item.fromWhatsApp;
  if (identity.fromChannel) {
    return t.inbox.item.fromChannel(CHANNEL_TYPE_LABELS[channelType ?? 'whatsapp']);
  }
  return null;
}
