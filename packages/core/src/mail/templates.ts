import {
  CHANNEL_CHANGE_LABELS,
  CHANNEL_CREDENTIAL_FIELD_LABELS,
  USER_ROLE_LABELS,
  type ChannelChangeKind,
  type ChannelCredentialField,
  type UserRole,
} from '@balesin/shared';
import { color, contrastRatio } from '@balesin/shared/design-tokens';

import type { LockScope, LockTrigger, SecurityNoticeEvent } from '../queues';
import type { MailContent } from './smtp';

/**
 * Template email sistem bermerek (white-label): nama produk, logo, warna utama, dan nama
 * organisasi dari branding. Setiap email punya versi HTML + teks polos, bahasa Indonesia dengan
 * sapaan "kamu/-mu" (DESIGN.md §4).
 *
 * Aturan keamanan:
 *  - SEMUA nilai dari luar (nama, email, nama organisasi/produk, user agent) di-escape sebelum
 *    masuk HTML; subjek dipaksa satu baris (tanpa CR/LF → tidak ada sisipan header).
 *  - Tautan hanya yang disusun pemanggil dari `APP_URL` (`buildTokenLink`), wajib http(s).
 *  - Logo hanya lewat `logoSrc` (`cid:` di email, `data:` di pratinjau) — tidak ada gambar dari
 *    alamat luar.
 */

type MailBody = Omit<MailContent, 'to' | 'inlineImages'>;

/** Branding yang dipakai template. */
export interface EmailBrand {
  /** Nama produk (bawaan "Balesin"). */
  productName: string;
  /** `null` hanya untuk email tes saat wizard setup (organisasi belum ada). */
  organizationName: string | null;
  /** `cid:…` (email sungguhan) atau `data:image/…` (pratinjau); `null` = tanpa gambar logo. */
  logoSrc: string | null;
  /** Warna utama organisasi `#rrggbb`, atau `null` = warna bawaan. */
  primaryColor: string | null;
}

/** Asal sebuah kejadian (dari audit log): ditampilkan supaya pemilik akun bisa mengenalinya. */
export interface EventOrigin {
  ip: string | null;
  userAgent: string | null;
}

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

/** Satu baris: semua spasi/baris baru/karakter kendali dirapatkan menjadi satu spasi. */
function singleLine(text: string): string {
  // eslint-disable-next-line no-control-regex
  return text.replace(/[\s\u0000-\u001f\u007f]+/g, ' ').trim();
}

/** Perkiraan peramban + sistem operasi dari user agent, mis. "Chrome di Windows". */
export function describeUserAgent(userAgent: string | null): string {
  if (!userAgent) return 'Perangkat tidak dikenal';
  const ua = userAgent.slice(0, 512);
  const browser = /\bEdg(A|iOS)?\//.test(ua)
    ? 'Microsoft Edge'
    : /\bOPR\/|\bOpera\b/.test(ua)
      ? 'Opera'
      : /\bSamsungBrowser\//.test(ua)
        ? 'Samsung Internet'
        : /\bFirefox\/|\bFxiOS\//.test(ua)
          ? 'Firefox'
          : /\bCriOS\/|\bChrome\//.test(ua)
            ? 'Chrome'
            : /\bVersion\/[\d.]+.*\bSafari\//.test(ua)
              ? 'Safari'
              : null;
  const os = /\biPhone\b/.test(ua)
    ? 'iPhone'
    : /\biPad\b/.test(ua)
      ? 'iPad'
      : /\bAndroid\b/.test(ua)
        ? 'Android'
        : /\bWindows NT\b/.test(ua)
          ? 'Windows'
          : /\bCrOS\b/.test(ua)
            ? 'ChromeOS'
            : /\bMac OS X\b|\bMacintosh\b/.test(ua)
              ? 'macOS'
              : /\bLinux\b/.test(ua)
                ? 'Linux'
                : null;
  if (browser && os) return `${browser} di ${os}`;
  return browser ?? os ?? 'Perangkat tidak dikenal';
}

export function formatLocalTime(date: Date, timeZone: string): string {
  const format = (zone: string) =>
    new Intl.DateTimeFormat('id-ID', {
      dateStyle: 'long',
      timeStyle: 'short',
      timeZone: zone,
    }).format(date);
  try {
    return `${format(timeZone)} (${timeZone})`;
  } catch {
    return `${format('UTC')} (UTC)`;
  }
}

// ── Kerangka ────────────────────────────────────────────────────────────────

const HEX_COLOR = /^#[0-9a-f]{6}$/i;
const palette = color.light;

/** Warna tombol + teksnya: warna organisasi bila kontrasnya cukup, selain itu warna bawaan. */
function buttonColors(primaryColor: string | null): { background: string; text: string } {
  if (primaryColor && HEX_COLOR.test(primaryColor)) {
    if (contrastRatio(primaryColor, '#FFFFFF') >= 4.5)
      return { background: primaryColor, text: '#FFFFFF' };
    if (contrastRatio(primaryColor, palette.ink) >= 4.5)
      return { background: primaryColor, text: palette.ink };
  }
  return { background: palette.primary, text: palette.onPrimary };
}

/** Warna tautan di atas latar putih. */
function linkColor(primaryColor: string | null): string {
  return primaryColor &&
    HEX_COLOR.test(primaryColor) &&
    contrastRatio(primaryColor, '#FFFFFF') >= 4.5
    ? primaryColor
    : palette.primary;
}

function assertHttpUrl(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new Error('Tautan email harus http(s)');
  }
  return parsed.toString();
}

interface EmailAction {
  label: string;
  /** Disusun dari `APP_URL` oleh pemanggil. */
  url: string;
}

interface EmailParts {
  subject: string;
  /** Teks pratinjau di kotak masuk (tersembunyi di badan email). */
  preheader: string;
  heading: string;
  paragraphs: string[];
  action?: EmailAction;
  /** Rincian kejadian: waktu, IP, perangkat. */
  details?: Array<{ label: string; value: string }>;
  /** Paragraf penutup (lebih kecil): mis. "kalau bukan kamu…". */
  notes?: string[];
}

function footerText(brand: EmailBrand): string {
  const organization = brand.organizationName ? ` untuk ${singleLine(brand.organizationName)}` : '';
  return `Email ini dikirim otomatis oleh ${singleLine(brand.productName)}${organization}.`;
}

function renderHtml(brand: EmailBrand, parts: EmailParts): string {
  const button = buttonColors(brand.primaryColor);
  const link = linkColor(brand.primaryColor);
  const productName = escapeHtml(singleLine(brand.productName));
  const logo =
    brand.logoSrc && /^(cid:|data:image\/(png|jpeg|webp);base64,)/.test(brand.logoSrc)
      ? `<img src="${escapeHtml(brand.logoSrc)}" alt="" height="32" style="height:32px;width:auto;max-width:160px;vertical-align:middle;border:0;margin-right:10px">`
      : '';
  const organization = brand.organizationName
    ? `<div style="font-size:13px;color:${palette.ink2};margin-top:2px">${escapeHtml(singleLine(brand.organizationName))}</div>`
    : '';
  const paragraph = (text: string) =>
    `<p style="margin:0 0 14px;font-size:15px;line-height:1.55;color:${palette.ink}">${escapeHtml(text)}</p>`;
  const note = (text: string) =>
    `<p style="margin:0 0 10px;font-size:13px;line-height:1.5;color:${palette.ink2}">${escapeHtml(text)}</p>`;

  let action = '';
  if (parts.action) {
    const url = escapeHtml(assertHttpUrl(parts.action.url));
    action =
      `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:6px 0 18px"><tr>` +
      `<td style="border-radius:8px;background:${button.background}">` +
      `<a href="${url}" style="display:inline-block;padding:12px 22px;font-size:15px;font-weight:bold;color:${button.text};text-decoration:none;border-radius:8px">${escapeHtml(parts.action.label)}</a>` +
      `</td></tr></table>` +
      `<p style="margin:0 0 16px;font-size:13px;line-height:1.5;color:${palette.ink2}">Kalau tombol tidak bisa diklik, salin alamat ini ke browser:<br>` +
      `<a href="${url}" style="color:${link};word-break:break-all">${url}</a></p>`;
  }

  const details = parts.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" style="margin:0 0 16px;font-size:14px;color:${palette.ink}">` +
      parts.details
        .map(
          (row) =>
            `<tr><td style="padding:2px 12px 2px 0;color:${palette.ink2};white-space:nowrap;vertical-align:top">${escapeHtml(row.label)}</td>` +
            `<td style="padding:2px 0;word-break:break-word">${escapeHtml(row.value)}</td></tr>`,
        )
        .join('') +
      `</table>`
    : '';

  const notes = parts.notes?.length
    ? `<div style="border-top:1px solid ${palette.line};padding-top:14px;margin-top:4px">${parts.notes.map(note).join('')}</div>`
    : '';

  return (
    '<!doctype html><html lang="id"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<meta name="color-scheme" content="light"><meta name="supported-color-schemes" content="light">' +
    `<title>${escapeHtml(singleLine(parts.subject))}</title></head>` +
    `<body style="margin:0;padding:0;background:${palette.bg};font-family:Arial,Helvetica,sans-serif">` +
    `<div style="display:none;max-height:0;overflow:hidden;opacity:0">${escapeHtml(parts.preheader)}</div>` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:${palette.bg}"><tr><td align="center" style="padding:24px 12px">` +
    `<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:${palette.surface};border:1px solid ${palette.line};border-radius:12px">` +
    `<tr><td style="padding:22px 28px 6px">${logo}<span style="font-size:17px;font-weight:bold;color:${palette.ink};vertical-align:middle">${productName}</span>${organization}</td></tr>` +
    `<tr><td style="padding:12px 28px 4px"><h1 style="margin:0 0 14px;font-size:20px;line-height:1.3;color:${palette.ink}">${escapeHtml(parts.heading)}</h1>` +
    parts.paragraphs.map(paragraph).join('') +
    details +
    action +
    notes +
    `</td></tr>` +
    `<tr><td style="padding:6px 28px 22px"><p style="margin:0;font-size:12px;line-height:1.5;color:${palette.ink2}">${escapeHtml(footerText(brand))}</p></td></tr>` +
    `</table></td></tr></table></body></html>`
  );
}

function renderText(brand: EmailBrand, parts: EmailParts): string {
  const blocks = [parts.heading, ...parts.paragraphs];
  if (parts.details?.length) {
    blocks.push(parts.details.map((row) => `${row.label}: ${row.value}`).join('\n'));
  }
  if (parts.action) blocks.push(`${parts.action.label}:\n${assertHttpUrl(parts.action.url)}`);
  if (parts.notes?.length) blocks.push(...parts.notes);
  const signature = brand.organizationName
    ? `— ${singleLine(brand.productName)} · ${singleLine(brand.organizationName)}`
    : `— ${singleLine(brand.productName)}`;
  return `${blocks.join('\n\n')}\n\n${signature}\n${footerText(brand)}\n`;
}

function compose(brand: EmailBrand, parts: EmailParts): MailBody {
  return {
    subject: singleLine(parts.subject),
    text: renderText(brand, parts),
    html: renderHtml(brand, parts),
  };
}

function hello(name: string | null): string {
  return name ? `Halo ${singleLine(name)},` : 'Halo,';
}

function originDetails(
  when: string,
  origin: EventOrigin | undefined,
): Array<{ label: string; value: string }> {
  const rows = [{ label: 'Waktu', value: when }];
  if (origin) {
    rows.push({ label: 'Alamat IP', value: origin.ip ?? 'tidak diketahui' });
    rows.push({ label: 'Perangkat', value: describeUserAgent(origin.userAgent) });
  }
  return rows;
}

const NOT_YOU = 'Kalau bukan kamu yang melakukannya, segera kabari Owner atau Admin di tempatmu.';

// ── Email tes ───────────────────────────────────────────────────────────────

export interface TestEmailInput {
  brand: EmailBrand;
}

/** Email untuk tombol "Kirim email tes". */
export function renderTestEmail(input: TestEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  return compose(input.brand, {
    subject: `Email tes dari ${product}`,
    preheader: 'Pengaturan email pengirim sudah benar.',
    heading: 'Email tes berhasil',
    paragraphs: [
      'Halo,',
      `Ini email tes dari ${product}. Kalau kamu menerima email ini, pengaturan email pengirim sudah benar.`,
    ],
    notes: [
      'Email ini dikirim karena ada yang menekan tombol "Kirim email tes" di pengaturan. Tidak ada yang perlu kamu lakukan.',
    ],
  });
}

// ── Undangan ────────────────────────────────────────────────────────────────

export interface InvitationEmailInput {
  brand: EmailBrand;
  timeZone: string;
  inviterName: string;
  role: UserRole;
  email: string;
  /** `buildTokenLink(APP_URL, 'invitation', token)`. */
  link: string;
  expiresAt: Date;
  twoFactorRequired: boolean;
}

export function renderInvitationEmail(input: InvitationEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const organization = singleLine(input.brand.organizationName ?? product);
  const role = USER_ROLE_LABELS[input.role];
  const inviter = singleLine(input.inviterName);
  const paragraphs = [
    'Halo,',
    `${inviter} mengundangmu bergabung ke tim ${organization} di ${product} sebagai ${role}.`,
    `Buka tautan di bawah untuk membuat password dan mengaktifkan akunmu (${singleLine(input.email)}). Tautan ini berlaku sampai ${formatLocalTime(input.expiresAt, input.timeZone)} dan hanya bisa dipakai sekali.`,
  ];
  if (input.twoFactorRequired) {
    paragraphs.push(
      `Peran ${role} wajib memakai verifikasi dua langkah. Siapkan aplikasi autentikator di ponselmu (mis. Google Authenticator atau Microsoft Authenticator): kamu langsung diminta mendaftarkannya setelah membuat password.`,
    );
  }
  return compose(input.brand, {
    subject: `${inviter} mengundangmu ke ${organization} di ${product}`,
    preheader: `Undangan bergabung sebagai ${role}. Berlaku 72 jam.`,
    heading: `Kamu diundang bergabung ke ${organization}`,
    paragraphs,
    action: { label: 'Terima undangan', url: input.link },
    notes: [
      'Jangan teruskan email ini: siapa pun yang membuka tautannya bisa membuat akun atas namamu.',
      `Kalau kamu tidak mengenal ${organization} atau tidak merasa diundang, abaikan saja email ini. Tidak ada akun yang dibuat tanpa tautan ini dibuka.`,
    ],
  });
}

// ── Atur ulang password ─────────────────────────────────────────────────────

export interface PasswordResetEmailInput {
  brand: EmailBrand;
  timeZone: string;
  userName: string;
  email: string;
  /** `buildTokenLink(APP_URL, 'passwordReset', token)`. */
  link: string;
  expiresAt: Date;
  requestedAt: Date;
  /** Asal permintaan (IP + perangkat yang meminta tautan). */
  origin?: EventOrigin;
  twoFactorEnabled: boolean;
}

export function renderPasswordResetEmail(input: PasswordResetEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const paragraphs = [
    hello(input.userName),
    `Ada permintaan untuk mengatur ulang password akun ${product}-mu (${singleLine(input.email)}). Buka tautan di bawah untuk membuat password baru. Tautan berlaku 30 menit, sampai ${formatLocalTime(input.expiresAt, input.timeZone)}, dan hanya bisa dipakai sekali.`,
  ];
  if (input.twoFactorEnabled) {
    paragraphs.push(
      'Akunmu memakai verifikasi dua langkah, jadi kamu juga perlu memasukkan kode dari aplikasi autentikator atau salah satu kode cadangan.',
    );
  }
  paragraphs.push('Setelah password diganti, semua perangkat yang sedang masuk akan dikeluarkan.');
  return compose(input.brand, {
    subject: `Atur ulang password ${product}`,
    preheader: 'Tautan atur ulang password, berlaku 30 menit.',
    heading: 'Atur ulang password',
    paragraphs,
    details: originDetails(formatLocalTime(input.requestedAt, input.timeZone), input.origin).map(
      (row) => (row.label === 'Waktu' ? { label: 'Diminta', value: row.value } : row),
    ),
    action: { label: 'Buat password baru', url: input.link },
    notes: [
      'Kalau bukan kamu yang meminta, abaikan email ini. Password-mu tidak berubah selama tautan ini tidak dibuka. Jangan teruskan email ini ke siapa pun.',
    ],
  });
}

// ── Verifikasi email ────────────────────────────────────────────────────────

export interface EmailVerificationEmailInput {
  brand: EmailBrand;
  timeZone: string;
  userName: string;
  email: string;
  /** `buildTokenLink(APP_URL, 'emailVerification', token)`. */
  link: string;
  expiresAt: Date;
}

export function renderEmailVerificationEmail(input: EmailVerificationEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  return compose(input.brand, {
    subject: `Verifikasi alamat email ${product}-mu`,
    preheader: 'Konfirmasi bahwa alamat email ini milikmu.',
    heading: 'Verifikasi alamat email',
    paragraphs: [
      hello(input.userName),
      `Buka tautan di bawah untuk memastikan ${singleLine(input.email)} adalah alamat email akun ${product}-mu. Email ini dipakai untuk mengatur ulang password dan pemberitahuan keamanan.`,
      `Tautan berlaku sampai ${formatLocalTime(input.expiresAt, input.timeZone)} dan hanya bisa dipakai sekali.`,
    ],
    action: { label: 'Verifikasi email', url: input.link },
    notes: [
      `Kalau kamu tidak merasa memakai ${product}, abaikan email ini. Alamat ini tidak akan dianggap terverifikasi tanpa tautan ini dibuka.`,
    ],
  });
}

// ── Kunci percobaan masuk ───────────────────────────────────────────────────

export interface AccountLockedEmailInput {
  brand: EmailBrand;
  userName: string;
  failedAttempts: number;
  lockMinutes: number;
  /** Waktu kunci berakhir. */
  lockedUntil: Date;
  /** Zona waktu IANA organisasi, untuk menampilkan jam setempat. */
  timeZone: string;
  /** Lingkup kunci; bawaan `account`. */
  scope?: LockScope;
  /** Untuk `two_factor`: sumber kode salah (bawaan `login`). */
  trigger?: LockTrigger;
}

/** Pemberitahuan ke pemilik akun saat percobaan masuk ke akunnya dikunci sementara (SECURITY.md §1). */
export function renderAccountLockedEmail(input: AccountLockedEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const until = formatLocalTime(input.lockedUntil, input.timeZone);
  const scope = input.scope ?? 'account';
  if (scope === 'two_factor') {
    const trigger = input.trigger ?? 'login';
    const what =
      trigger === 'reauth'
        ? `Kode verifikasi dua langkah yang salah dimasukkan berulang kali saat mengonfirmasi identitas di halaman Keamanan akun, dari sesi yang sedang masuk ke akunmu dan dengan password yang BENAR. Langkah verifikasi untuk akunmu dihentikan sementara selama ${input.lockMinutes} menit, sampai ${until}.`
        : trigger === 'password_reset'
          ? `Kode verifikasi dua langkah yang salah dimasukkan berulang kali saat mengatur ulang password akunmu lewat tautan dari email. Langkah verifikasi untuk akunmu dihentikan sementara selama ${input.lockMinutes} menit, sampai ${until}.`
          : `Ada ${input.failedAttempts} kali percobaan masuk ke akunmu dengan password yang BENAR, tetapi kode verifikasi dua langkahnya salah. Langkah verifikasi untuk akunmu dihentikan sementara selama ${input.lockMinutes} menit, sampai ${until}.`;
    const notYou =
      trigger === 'reauth'
        ? 'Kalau bukan kamu, berarti ada orang lain yang sedang masuk ke akunmu dan tahu password-mu. Verifikasi dua langkah masih menahannya. Segera kabari Owner atau Admin di tempatmu.'
        : trigger === 'password_reset'
          ? 'Kalau bukan kamu, berarti ada orang lain yang bisa membuka email akunmu. Verifikasi dua langkah masih menahannya. Segera amankan kotak email-mu dan kabari Owner atau Admin di tempatmu.'
          : 'Kalau bukan kamu, berarti password-mu sudah diketahui orang lain. Verifikasi dua langkah masih menahannya. Segera kabari Owner atau Admin di tempatmu.';
    return compose(input.brand, {
      subject: `Kode verifikasi akun ${product}-mu salah berulang kali`,
      preheader: 'Langkah verifikasi dua langkah dihentikan sementara.',
      heading: 'Kode verifikasi salah berulang kali',
      paragraphs: [
        hello(input.userName),
        what,
        'Kalau itu memang kamu, tunggu sampai waktunya lalu masukkan kode terbaru dari aplikasi autentikatormu (pastikan jam di ponselmu tepat), atau pakai salah satu kode cadangan.',
      ],
      notes: [notYou],
    });
  }
  const what =
    scope === 'source'
      ? `Ada ${input.failedAttempts} kali percobaan masuk ke akunmu dengan password yang salah dari satu jaringan. Percobaan masuk dari jaringan itu dihentikan sementara selama ${input.lockMinutes} menit.`
      : scope === 'device'
        ? `Ada ${input.failedAttempts} kali percobaan masuk ke akunmu dengan password yang salah dari perangkat yang pernah kamu pakai. Percobaan dari perangkat itu dihentikan sementara selama ${input.lockMinutes} menit.`
        : `Ada banyak percobaan masuk ke akunmu dengan password yang salah dari berbagai jaringan. Akunmu dikunci sementara selama ${input.lockMinutes} menit untuk perangkat yang belum pernah dipakai masuk.`;
  const access =
    scope === 'account'
      ? `Dari perangkat yang biasa kamu pakai untuk masuk, kamu tetap bisa masuk seperti biasa. Dari perangkat lain, coba lagi setelah ${until}.`
      : `Dari jaringan dan perangkat lain kamu tetap bisa masuk seperti biasa. Dari asal yang dihentikan, coba lagi setelah ${until}.`;
  return compose(input.brand, {
    subject: `Percobaan masuk ke akun ${product}-mu dihentikan sementara`,
    preheader: 'Ada percobaan masuk dengan password yang salah.',
    heading: 'Percobaan masuk dihentikan sementara',
    paragraphs: [
      hello(input.userName),
      what,
      access,
      'Kalau itu memang kamu, tunggu sampai waktunya lalu masuk dengan password yang benar.',
    ],
    notes: [
      'Kalau bukan kamu, ada orang lain yang mencoba masuk ke akunmu. Password-mu tetap aman selama belum pernah dibagikan. Segera kabari Owner atau Admin di tempatmu, dan atur ulang password bila kamu ragu.',
    ],
  });
}

// ── Pemberitahuan keamanan akun ─────────────────────────────────────────────

export interface SecurityNoticeEmailInput {
  brand: EmailBrand;
  userName: string;
  event: SecurityNoticeEvent;
  occurredAt: Date;
  /** Zona waktu IANA organisasi, untuk menampilkan jam setempat. */
  timeZone: string;
  /** Untuk `backup_code_used`. */
  backupCodesRemaining?: number;
  /** IP + perangkat dari audit log, bila tersedia. */
  origin?: EventOrigin;
  /** Untuk `two_factor_reset`: nama + peran Owner/Admin yang mengatur ulang. */
  actor?: { name: string; role: UserRole };
}

/**
 * Pemberitahuan perubahan keamanan akun: 2FA diaktifkan/dinonaktifkan, kode cadangan dipakai,
 * kode cadangan dibuat ulang (semua kode lama batal — jalur yang bisa dipakai penyerang untuk
 * bertahan di akun, jadi pemiliknya harus tahu), dan password diubah lewat atur ulang password.
 */
export function renderSecurityNoticeEmail(input: SecurityNoticeEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const when = formatLocalTime(input.occurredAt, input.timeZone);
  const details = originDetails(when, input.origin);
  const greeting = hello(input.userName);
  switch (input.event) {
    case 'two_factor_enabled':
      return compose(input.brand, {
        subject: `Verifikasi dua langkah akun ${product}-mu sudah aktif`,
        preheader: 'Mulai sekarang masuk butuh kode dari aplikasi autentikator.',
        heading: 'Verifikasi dua langkah aktif',
        paragraphs: [
          greeting,
          `Verifikasi dua langkah untuk akunmu diaktifkan pada ${when}. Mulai sekarang, setiap kali masuk kamu perlu memasukkan kode dari aplikasi autentikator selain password.`,
          'Simpan kode cadangan yang ditampilkan saat itu di tempat yang aman. Kode cadangan dipakai kalau ponselmu hilang atau tidak bisa dibuka.',
        ],
        details,
        notes: [NOT_YOU],
      });
    case 'two_factor_disabled':
      return compose(input.brand, {
        subject: `Verifikasi dua langkah akun ${product}-mu dinonaktifkan`,
        preheader: 'Akunmu kini bisa dimasuki hanya dengan password.',
        heading: 'Verifikasi dua langkah dinonaktifkan',
        paragraphs: [
          greeting,
          `Verifikasi dua langkah untuk akunmu dinonaktifkan pada ${when}. Sekarang akunmu bisa dimasuki hanya dengan password.`,
          'Semua kode cadangan lama tidak berlaku lagi. Kamu bisa mengaktifkannya kembali kapan saja dari halaman keamanan akun.',
        ],
        details,
        notes: [NOT_YOU],
      });
    case 'backup_code_used': {
      const remaining = input.backupCodesRemaining ?? 0;
      return compose(input.brand, {
        subject: `Kode cadangan akun ${product}-mu dipakai`,
        preheader: 'Satu kode cadangan baru saja dipakai.',
        heading: 'Kode cadangan dipakai',
        paragraphs: [
          greeting,
          `Salah satu kode cadangan dipakai untuk akunmu pada ${when}. Kode itu tidak bisa dipakai lagi.`,
          remaining > 0
            ? `Sisa kode cadangan yang masih berlaku: ${remaining}. Kalau tinggal sedikit, buat kode cadangan baru dari halaman Keamanan akun.`
            : 'Kode cadangan yang masih berlaku sudah habis. Selagi aplikasi autentikator di ponselmu masih bisa dipakai, buat kode cadangan baru dari halaman Keamanan akun sekarang.',
          'Simpan kode cadangan di tempat yang aman selain ponselmu: tanpa ponsel dan tanpa kode cadangan, kamu tidak bisa masuk ke akunmu.',
        ],
        details,
        notes: [NOT_YOU],
      });
    }
    case 'backup_codes_regenerated':
      return compose(input.brand, {
        subject: `Kode cadangan akun ${product}-mu dibuat ulang`,
        preheader: 'Semua kode cadangan lama tidak berlaku lagi.',
        heading: 'Kode cadangan dibuat ulang',
        paragraphs: [
          greeting,
          `Kode cadangan verifikasi dua langkah untuk akunmu dibuat ulang pada ${when}. Semua kode cadangan lama tidak berlaku lagi.`,
          'Simpan kode cadangan yang baru di tempat yang aman.',
        ],
        details,
        notes: [NOT_YOU],
      });
    case 'password_changed':
      return compose(input.brand, {
        subject: `Password akun ${product}-mu sudah diganti`,
        preheader: 'Password diganti lewat tautan atur ulang password.',
        heading: 'Password sudah diganti',
        paragraphs: [
          greeting,
          `Password akunmu diganti pada ${when} lewat tautan atur ulang password yang dikirim ke email ini. Semua perangkat yang sedang masuk sudah dikeluarkan; masuk lagi dengan password baru.`,
        ],
        details,
        notes: [
          'Kalau bukan kamu yang menggantinya, segera atur ulang password lagi dari halaman masuk, amankan kotak email-mu, dan kabari Owner atau Admin di tempatmu.',
        ],
      });
    case 'two_factor_reset': {
      const by = input.actor
        ? `${singleLine(input.actor.name)} (${USER_ROLE_LABELS[input.actor.role]})`
        : 'Owner atau Admin di tempatmu';
      return compose(input.brand, {
        subject: `Verifikasi dua langkah akun ${product}-mu diatur ulang`,
        preheader: 'Aplikasi autentikator dan kode cadangan lamamu tidak berlaku lagi.',
        heading: 'Verifikasi dua langkah diatur ulang',
        paragraphs: [
          greeting,
          `${by} mengatur ulang verifikasi dua langkah akunmu pada ${when}. Entri akun ini di aplikasi autentikatormu dan semua kode cadangan lama tidak berlaku lagi, dan semua perangkat yang sedang masuk sudah dikeluarkan.`,
          'Saat masuk berikutnya, daftarkan lagi aplikasi autentikator. Kalau peranmu wajib memakai verifikasi dua langkah, kamu langsung diminta mendaftarkannya setelah memasukkan password.',
        ],
        details,
        notes: [
          `Kalau bukan kamu yang meminta pengaturan ulang ini, hubungi ${by} lewat jalur lain sekarang.`,
        ],
      });
    }
  }
}

// ── Ke Owner/Admin: 2FA peran wajib baru aktif ──────────────────────────────

export interface AdminTwoFactorNoticeEmailInput {
  brand: EmailBrand;
  timeZone: string;
  recipientName: string;
  subject: { name: string; email: string; role: UserRole };
  occurredAt: Date;
  origin?: EventOrigin;
}

/**
 * Mitigasi trust-on-first-use (review 2FA R5): siapa pun yang PERTAMA mendaftarkan autentikator
 * untuk akun ber-peran wajib menjadi pemegang faktor kedua akun itu. Owner/Admin lain diberi tahu
 * kapan, dari mana, dan dengan perangkat apa — supaya pendaftaran yang tidak disangka ketahuan.
 */
export function renderAdminTwoFactorNoticeEmail(input: AdminTwoFactorNoticeEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const name = singleLine(input.subject.name);
  const role = USER_ROLE_LABELS[input.subject.role];
  const when = formatLocalTime(input.occurredAt, input.timeZone);
  return compose(input.brand, {
    subject: `Verifikasi dua langkah ${name} (${role}) di ${product} sudah aktif`,
    preheader: `${name} baru saja mendaftarkan aplikasi autentikator.`,
    heading: `Verifikasi dua langkah ${name} aktif`,
    paragraphs: [
      hello(input.recipientName),
      `${name} (${singleLine(input.subject.email)}, peran ${role}) baru saja mendaftarkan verifikasi dua langkah. Aplikasi autentikator yang didaftarkan sekarang menjadi kunci kedua akun itu.`,
      'Kamu menerima email ini karena kamu Owner atau Admin. Biasanya ini terjadi tepat setelah orang itu menerima undangannya atau masuk pertama kali.',
    ],
    details: [{ label: 'Akun', value: `${name} · ${role}` }, ...originDetails(when, input.origin)],
    notes: [
      `Kalau ini tidak kamu duga (misalnya ${name} belum membuka undangannya, atau lokasi/perangkatnya asing), hubungi ${name} lewat jalur lain sekarang dan kabari Owner.`,
    ],
  });
}

export interface AdminAccountNoticeEmailInput {
  brand: EmailBrand;
  timeZone: string;
  recipientName: string;
  event:
    'two_factor_reset' | 'password_reset_without_two_factor' | 'role_changed' | 'user_disabled';
  subject: { name: string; email: string; role: UserRole };
  /** Untuk `two_factor_reset`, `role_changed`, `user_disabled`: pelakunya. */
  actor?: { name: string; role: UserRole };
  /** Untuk `role_changed`: peran lama → baru. */
  roleChange?: { from: UserRole; to: UserRole };
  occurredAt: Date;
  origin?: EventOrigin;
}

/**
 * Ke Owner/Admin lain:
 *  - `two_factor_reset` — 2FA seseorang diatur ulang (hanya ke Owner): jalan yang bisa dipakai akun
 *    Owner/Admin yang dibobol untuk mengambil alih akun lain, jadi Owner lain harus tahu.
 *  - `password_reset_without_two_factor` — akun ber-peran wajib yang belum mendaftar 2FA mengatur
 *    ulang password-nya (review undangan R3): siapa pun yang menguasai kotak masuk akun itu bisa
 *    menjadi pemegang faktor keduanya.
 */
export function renderAdminAccountNoticeEmail(input: AdminAccountNoticeEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const name = singleLine(input.subject.name);
  const role = USER_ROLE_LABELS[input.subject.role];
  const when = formatLocalTime(input.occurredAt, input.timeZone);
  const account = `${name} (${singleLine(input.subject.email)}, peran ${role})`;
  const details = [
    { label: 'Akun', value: `${name} · ${role}` },
    ...originDetails(when, input.origin),
  ];
  if (input.event === 'role_changed' || input.event === 'user_disabled') {
    const by = input.actor
      ? `${singleLine(input.actor.name)} (${USER_ROLE_LABELS[input.actor.role]})`
      : 'Seorang Admin';
    const change = input.roleChange
      ? `${USER_ROLE_LABELS[input.roleChange.from]} → ${USER_ROLE_LABELS[input.roleChange.to]}`
      : null;
    const roleChanged = input.event === 'role_changed';
    const what = roleChanged
      ? `mengubah peran ${account}${change ? ` (${change})` : ''}`
      : `menonaktifkan akun ${account}`;
    return compose(input.brand, {
      subject: roleChanged
        ? `Peran ${name} di ${product} diubah oleh ${by}`
        : `${name} di ${product} dinonaktifkan oleh ${by}`,
      preheader: `${by} ${roleChanged ? 'mengubah peran' : 'menonaktifkan'} ${name}.`,
      heading: roleChanged ? 'Peran pengguna diubah' : 'Pengguna dinonaktifkan',
      paragraphs: [
        hello(input.recipientName),
        `${by} ${what}. Semua sesi akun itu sudah dikeluarkan.`,
        'Kamu menerima email ini karena kamu Owner. Perubahan wewenang tim oleh selain Owner selalu diberitahukan.',
      ],
      details: [...details, ...(change ? [{ label: 'Perubahan peran', value: change }] : [])],
      notes: [
        `Kalau perubahan ini tidak kamu duga, masuk ke ${product}, periksa halaman Tim dan Audit log, lalu nonaktifkan akun ${by} bila perlu.`,
      ],
    });
  }
  if (input.event === 'two_factor_reset') {
    const by = input.actor
      ? `${singleLine(input.actor.name)} (${USER_ROLE_LABELS[input.actor.role]})`
      : 'Owner atau Admin lain';
    return compose(input.brand, {
      subject: `Verifikasi dua langkah ${name} (${role}) di ${product} diatur ulang`,
      preheader: `${by} mengatur ulang verifikasi dua langkah ${name}.`,
      heading: `Verifikasi dua langkah ${name} diatur ulang`,
      paragraphs: [
        hello(input.recipientName),
        `${by} mengatur ulang verifikasi dua langkah ${account}. Semua sesi akun itu sudah dikeluarkan; saat masuk berikutnya ${name} harus mendaftarkan aplikasi autentikator lagi.`,
        'Kamu menerima email ini karena kamu Owner.',
      ],
      details,
      notes: [
        `Kalau pengaturan ulang ini tidak kamu duga, hubungi ${name} dan ${by} lewat jalur lain sekarang, lalu periksa Audit log di ${product}.`,
      ],
    });
  }
  return compose(input.brand, {
    subject: `${name} (${role}) mengatur ulang password tanpa verifikasi dua langkah`,
    preheader: `${name} belum mendaftarkan verifikasi dua langkah, padahal perannya wajib.`,
    heading: 'Password diatur ulang sebelum 2FA didaftarkan',
    paragraphs: [
      hello(input.recipientName),
      `Password ${account} baru saja diatur ulang lewat tautan email. Akun ini wajib memakai verifikasi dua langkah tetapi belum mendaftarkannya, jadi siapa pun yang menguasai kotak masuk email itu bisa menjadi pemegang faktor keduanya.`,
      'Kamu menerima email ini karena kamu Owner atau Admin.',
    ],
    details,
    notes: [
      `Kalau ini tidak kamu duga, hubungi ${name} lewat jalur lain sekarang. Bila perlu, nonaktifkan akunnya dari halaman Tim di ${product} sampai jelas.`,
    ],
  });
}

export interface EmailSettingsChangedEmailInput {
  brand: EmailBrand;
  timeZone: string;
  recipientName: string | null;
  actor: { name: string; email: string; role: UserRole };
  /** `null` = sebelumnya belum ada pengaturan tersimpan. */
  previous: { host: string; port: number; fromAddress: string } | null;
  next: { host: string; port: number; fromAddress: string };
  occurredAt: Date;
  origin?: EventOrigin;
}

/**
 * Ke Owner: email pengirim (server SMTP / alamat pengirim) diubah pengguna lain. Dikirim lewat
 * pengaturan LAMA — bila perubahannya bukan dari orang yang berhak, server baru bisa menelan
 * semua email keamanan berikutnya (atur ulang password, undangan, pemberitahuan 2FA).
 */
export function renderEmailSettingsChangedEmail(input: EmailSettingsChangedEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const name = singleLine(input.actor.name);
  const role = USER_ROLE_LABELS[input.actor.role];
  const when = formatLocalTime(input.occurredAt, input.timeZone);
  const server = (value: { host: string; port: number }) =>
    `${singleLine(value.host)}:${String(value.port)}`;
  return compose(input.brand, {
    subject: `Email pengirim ${product} diubah oleh ${name} (${role})`,
    preheader: `Server email pengirim sekarang ${server(input.next)}.`,
    heading: 'Email pengirim diubah',
    paragraphs: [
      hello(input.recipientName),
      `${name} (${singleLine(input.actor.email)}, peran ${role}) baru saja mengubah pengaturan email pengirim. Semua email dari ${product} — undangan, atur ulang password, dan pemberitahuan keamanan — sekarang dikirim lewat server yang baru.`,
      'Kamu menerima email ini karena kamu Owner. Email ini sengaja dikirim lewat pengaturan yang LAMA.',
    ],
    details: [
      {
        label: 'Server sebelumnya',
        value: input.previous ? server(input.previous) : 'Belum diatur',
      },
      { label: 'Server sekarang', value: server(input.next) },
      {
        label: 'Alamat pengirim',
        value: input.previous
          ? `${singleLine(input.previous.fromAddress)} → ${singleLine(input.next.fromAddress)}`
          : singleLine(input.next.fromAddress),
      },
      ...originDetails(when, input.origin),
    ],
    notes: [
      `Kalau perubahan ini tidak kamu duga, masuk ke ${product} sekarang, periksa Pengaturan → Email pengirim, dan nonaktifkan akun ${name} bila perlu. Server email yang salah bisa membaca tautan atur ulang password dan undangan.`,
    ],
  });
}

export interface ChannelChangedEmailInput {
  brand: EmailBrand;
  timeZone: string;
  recipientName: string | null;
  /** Pelaku (aktif maupun sudah dinonaktifkan); `null` = tidak diketahui lagi. */
  actor: { name: string; email: string; role: UserRole } | null;
  change: ChannelChangeKind;
  channel: { name: string; phoneNumberId: string | null };
  /** Untuk `credentials_changed`: isian yang diganti (nama saja, tidak pernah nilainya). */
  changedFields?: readonly ChannelCredentialField[];
  /** Untuk `credentials_changed` bila Phone Number ID ikut diganti: nilai sebelumnya. */
  previousPhoneNumberId?: string | null;
  occurredAt: Date;
  origin?: EventOrigin;
}

/**
 * Ke Owner: channel WhatsApp diubah oleh pengguna SELAIN Owner. Mengganti token/App Secret/ID bisa
 * membelokkan pesan agen ke nomor lain atau memungkinkan pemalsuan webhook; menonaktifkan/menghapus
 * menghentikan layanan pelanggan — Admin yang dibobol tidak boleh bisa melakukannya diam-diam.
 * Tidak pernah memuat nilai rahasia.
 */
export function renderChannelChangedEmail(input: ChannelChangedEmailInput): MailBody {
  const product = singleLine(input.brand.productName);
  const channel = `"${singleLine(input.channel.name)}"`;
  const when = formatLocalTime(input.occurredAt, input.timeZone);
  const actorName = input.actor ? singleLine(input.actor.name) : null;
  const by = input.actor
    ? `${actorName ?? ''} (${USER_ROLE_LABELS[input.actor.role]})`
    : 'pengguna selain Owner';
  const byFull = input.actor
    ? `${actorName ?? ''} (${singleLine(input.actor.email)}, peran ${USER_ROLE_LABELS[input.actor.role]})`
    : 'Seorang pengguna selain Owner';
  const fields = (input.changedFields ?? []).map((field) => CHANNEL_CREDENTIAL_FIELD_LABELS[field]);
  const replaced = fields.length > 0 ? fields.join(', ') : 'kredensial';
  const phoneNumberId = input.channel.phoneNumberId
    ? singleLine(input.channel.phoneNumberId)
    : null;
  const previousPhoneNumberId =
    input.change === 'credentials_changed' && input.previousPhoneNumberId
      ? singleLine(input.previousPhoneNumberId)
      : null;

  const subject: Record<ChannelChangeKind, string> = {
    created: `Channel baru ${channel} ditambahkan di ${product} oleh ${by}`,
    credentials_changed: `Kredensial channel ${channel} di ${product} diganti oleh ${by}`,
    verify_token_rotated: `Verify token channel ${channel} di ${product} dibuat ulang oleh ${by}`,
    disabled: `Channel ${channel} di ${product} dinonaktifkan oleh ${by}`,
    deleted: `Channel ${channel} di ${product} dihapus oleh ${by}`,
  };
  const what: Record<ChannelChangeKind, string> = {
    created: `menambahkan channel WhatsApp baru ${channel}`,
    credentials_changed: `mengganti ${replaced} channel ${channel}`,
    verify_token_rotated: `membuat ulang verify token webhook channel ${channel}`,
    disabled: `menonaktifkan channel ${channel}`,
    deleted: `menghapus channel ${channel} beserta kredensialnya`,
  };
  const impact: Record<ChannelChangeKind, string> = {
    created:
      'Nomor yang tidak kamu kenal bisa dipakai untuk menerima dan mengirim pesan atas nama perusahaanmu.',
    credentials_changed:
      'Kredensial atau ID yang salah bisa membelokkan balasan agen ke nomor atau aplikasi Meta lain, atau membuat pesan palsu masuk ke inbox.',
    verify_token_rotated:
      'Verify token lama langsung tidak berlaku. Webhook yang sudah terpasang di Meta tetap jalan, tetapi verifikasi ulang di Meta harus memakai token yang baru.',
    disabled:
      'Channel ini berhenti menerima dan mengirim pesan; pelanggan yang menghubungi nomor ini tidak terlayani sampai channel diaktifkan lagi.',
    deleted:
      'Nomor ini tidak lagi terhubung ke inbox. Untuk memakainya lagi, channel harus ditambahkan ulang dengan token dan App Secret.',
  };

  return compose(input.brand, {
    subject: subject[input.change],
    preheader: `${input.actor ? by : 'Pengguna selain Owner'} ${what[input.change]}.`,
    heading: CHANNEL_CHANGE_LABELS[input.change],
    paragraphs: [
      hello(input.recipientName),
      `${byFull} ${what[input.change]}. ${impact[input.change]}`,
      'Kamu menerima email ini karena kamu Owner. Perubahan channel oleh selain Owner selalu diberitahukan.',
    ],
    details: [
      { label: 'Channel', value: singleLine(input.channel.name) },
      ...(previousPhoneNumberId && phoneNumberId
        ? [{ label: 'Phone Number ID', value: `${previousPhoneNumberId} → ${phoneNumberId}` }]
        : phoneNumberId
          ? [{ label: 'Phone Number ID', value: phoneNumberId }]
          : []),
      ...(input.change === 'credentials_changed' && fields.length > 0
        ? [{ label: 'Yang diganti', value: fields.join(', ') }]
        : []),
      ...originDetails(when, input.origin),
    ],
    notes: [
      `Kalau perubahan ini tidak kamu duga, masuk ke ${product} sekarang, periksa Pengaturan → Channel dan Audit log, lalu nonaktifkan akun ${actorName ?? 'pelakunya'} bila perlu.`,
    ],
  });
}
