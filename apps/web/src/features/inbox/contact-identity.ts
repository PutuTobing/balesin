import type { Contact, ContactSummary } from '@balesin/shared';

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
 * Identitas dari ringkasan kontak di daftar (`displayName` + `phone`). Sumber nama tidak
 * diketahui dari ringkasan, jadi penanda "dari WhatsApp" hanya tampil di ruang chat/detail
 * (yang memuat kontak lengkap).
 */
export function summaryIdentity(contact: ContactSummary): ContactIdentity {
  const phone = formatPhone(contact.phone);
  const handle = phone && !isSameHandle(contact.displayName, phone, contact.phone) ? phone : null;
  return {
    name: phone && !handle ? phone : contact.displayName,
    handle,
    fromWhatsApp: false,
  };
}

/** Identitas dari kontak lengkap (`GET /contacts/:id`). */
export function contactIdentity(contact: Contact): ContactIdentity {
  const phone = formatPhone(contact.phone);
  const username = formatUsername(contact.waUsername);
  const handleValue = phone ?? username;
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
    fromWhatsApp: !contact.name?.trim() && Boolean(contact.profileName?.trim()),
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
