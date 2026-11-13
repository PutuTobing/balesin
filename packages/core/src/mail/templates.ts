import type { MailContent } from './smtp';

/**
 * Isi email sistem. Sengaja sederhana (teks + HTML polos tanpa gambar/tautan luar); template
 * bermerek dengan logo dan warna organisasi dibuat bersama fitur undangan/reset password.
 *
 * Semua nilai dari luar (nama pengguna, nama organisasi) di-escape sebelum masuk HTML, dan
 * baris baru dibuang dari subjek.
 */

type MailBody = Omit<MailContent, 'to'>;

export function escapeHtml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function singleLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

function htmlDocument(productName: string, paragraphs: string[]): string {
  const body = paragraphs
    .map((paragraph) => `<p style="margin:0 0 14px">${escapeHtml(paragraph)}</p>`)
    .join('');
  return (
    '<!doctype html><html lang="id"><body style="margin:0;padding:24px;background:#f5f6f8;' +
    'font-family:Arial,Helvetica,sans-serif;font-size:15px;line-height:1.55;color:#1c2430">' +
    '<div style="max-width:520px;margin:0 auto;background:#ffffff;border-radius:12px;padding:24px">' +
    `<p style="margin:0 0 18px;font-size:17px;font-weight:bold">${escapeHtml(productName)}</p>` +
    `${body}</div></body></html>`
  );
}

function compose(productName: string, subject: string, paragraphs: string[]): MailBody {
  return {
    subject: singleLine(subject),
    text: `${paragraphs.join('\n\n')}\n\n— ${productName}\n`,
    html: htmlDocument(productName, paragraphs),
  };
}

export interface TestEmailInput {
  productName: string;
}

/** Email untuk tombol "Kirim email tes". */
export function renderTestEmail(input: TestEmailInput): MailBody {
  return compose(input.productName, `Email tes dari ${input.productName}`, [
    'Halo,',
    `Ini email tes dari ${input.productName}. Kalau kamu menerima email ini, pengaturan email pengirim sudah benar.`,
    'Email ini dikirim karena ada yang menekan tombol "Kirim email tes" di pengaturan. Tidak ada yang perlu kamu lakukan.',
  ]);
}

export interface AccountLockedEmailInput {
  productName: string;
  userName: string;
  failedAttempts: number;
  lockMinutes: number;
  /** Waktu kunci berakhir. */
  lockedUntil: Date;
  /** Zona waktu IANA organisasi, untuk menampilkan jam setempat. */
  timeZone: string;
  /** Lingkup kunci; bawaan `account`. */
  scope?: 'source' | 'account' | 'device';
}

function formatLocalTime(date: Date, timeZone: string): string {
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

/** Pemberitahuan ke pemilik akun saat percobaan masuk ke akunnya dikunci sementara (SECURITY.md §1). */
export function renderAccountLockedEmail(input: AccountLockedEmailInput): MailBody {
  const until = formatLocalTime(input.lockedUntil, input.timeZone);
  const scope = input.scope ?? 'account';
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
  return compose(
    input.productName,
    `Percobaan masuk ke akun ${input.productName} kamu dihentikan sementara`,
    [
      `Halo ${singleLine(input.userName)},`,
      what,
      access,
      'Kalau itu memang kamu, tunggu sampai waktunya lalu masuk dengan password yang benar.',
      'Kalau bukan kamu, ada orang lain yang mencoba masuk ke akunmu. Password-mu tetap aman selama belum pernah dibagikan. Segera kabari Owner atau Admin di tempatmu, dan ganti password bila kamu ragu.',
    ],
  );
}
