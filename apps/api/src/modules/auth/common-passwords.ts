import { createRequire } from 'node:module';

/**
 * Daftar password umum (SECURITY.md §1: "cek terhadap daftar password umum").
 *
 * Sumber utama: daftar `passwords` dari `@zxcvbn-ts/language-common` (±49 ribu password yang
 * paling sering muncul di kebocoran data), ditambah daftar kecil kata yang umum dipakai di
 * Indonesia. Dimuat saat pertama kali dipakai (berkasnya ±2 MB), lalu disimpan sebagai `Set`.
 *
 * Paket itu berformat CommonJS tanpa peta `exports`, jadi dimuat lewat `require` supaya
 * bentuknya sama di tsx (dev), Vitest, dan bundle produksi.
 */

/** Kata dasar yang sering dijadikan password di Indonesia (huruf kecil, tanpa angka). */
const INDONESIAN_COMMON_WORDS = [
  'admin',
  'administrator',
  'akusayangkamu',
  'akucintakamu',
  'alhamdulillah',
  'allahuakbar',
  'anakku',
  'assalamualaikum',
  'bandung',
  'bismillah',
  'bismillahirrahmanirrahim',
  'cintaku',
  'cintakamu',
  'garuda',
  'indonesia',
  'indonesiaku',
  'internet',
  'jakarta',
  'kata sandi',
  'katasandi',
  'keluarga',
  'komputer',
  'kucing',
  'makanan',
  'merdeka',
  'pelanggan',
  'perusahaan',
  'rahasia',
  'sandi',
  'sayang',
  'sayangku',
  'sayangkamu',
  'selamat',
  'sukses',
  'surabaya',
  'terserah',
  'tidaktahu',
  'whatsapp',
  'customer',
  'customerservice',
  'support',
  'helpdesk',
  'welcome',
  'selamatdatang',
];

interface LanguageCommonModule {
  dictionary?: { passwords?: unknown };
  default?: { dictionary?: { passwords?: unknown } };
}

let cached: ReadonlySet<string> | undefined;

function loadPasswords(): string[] {
  const requireModule = createRequire(import.meta.url);
  const loaded = requireModule('@zxcvbn-ts/language-common') as LanguageCommonModule;
  const passwords = loaded.dictionary?.passwords ?? loaded.default?.dictionary?.passwords;
  if (!Array.isArray(passwords) || passwords.length < 10_000) {
    // Gagal keras: lebih baik aplikasi tidak bisa membuat password daripada diam-diam
    // menerima password umum karena daftarnya kosong.
    throw new Error('Daftar password umum tidak bisa dimuat dari @zxcvbn-ts/language-common');
  }
  return passwords.filter((entry): entry is string => typeof entry === 'string');
}

/** Semua entri sudah huruf kecil. */
export function commonPasswords(): ReadonlySet<string> {
  cached ??= new Set([
    ...loadPasswords().map((entry) => entry.toLowerCase()),
    ...INDONESIAN_COMMON_WORDS.map((entry) => entry.replaceAll(' ', '')),
  ]);
  return cached;
}
