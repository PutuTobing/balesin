/**
 * Design token Balesin: sumber kebenaran tunggal (docs/DESIGN.md §1).
 *
 * Berkas ini diubah otomatis menjadi CSS variables oleh plugin Vite di
 * `apps/web/vite/design-tokens-plugin.ts`. Nilainya tidak pernah disalin tangan ke CSS;
 * komponen hanya memakai `var(--nama-token)`.
 *
 * Jangan impor modul Node di sini: berkas ini ikut ter-bundle ke browser.
 */

export type ThemeName = 'light' | 'dark';

export interface ThemeColors {
  /** Latar aplikasi (kertas hangat). */
  bg: string;
  /** Kartu, panel. */
  surface: string;
  /** Hover, area sekunder. */
  surface2: string;
  /** Teks utama. */
  ink: string;
  /** Teks sekunder. */
  ink2: string;
  /** Garis. */
  line: string;
  /** Aksi utama, link. */
  primary: string;
  /** Aksen kecil, badge baru, maskot. Bukan untuk teks. */
  accent: string;
  /** Terkirim, selesai. Untuk isian dan ikon; teks memakai `successInk`. */
  success: string;
  /** Jendela 24 jam hampir habis. Untuk isian; teks dan ikon memakai `warningInk`. */
  warning: string;
  /** Gagal, hapus. Untuk isian dan ikon; teks memakai `dangerInk`. */
  danger: string;
  /** Bubble pesan dari tim. */
  bubbleOut: string;
  /** Bubble pesan pelanggan (sama dengan `surface`). */
  bubbleIn: string;

  // Turunan: tidak ada di tabel DESIGN.md, ditambahkan supaya pasangan teks/latar
  // yang dipakai lolos kontras 4.5:1 (lihat `contrastPairs`).
  /** Teks di atas isian `primary` (tombol utama). */
  onPrimary: string;
  /** Teks di atas isian `accent` (badge). */
  onAccent: string;
  /** Isian lembut bernuansa primary: item navigasi aktif, pilihan terpilih. */
  primarySoft: string;
  /** `success` yang aman dipakai sebagai teks. */
  successInk: string;
  /** `warning` yang aman dipakai sebagai teks dan ikon. */
  warningInk: string;
  /** `danger` yang aman dipakai sebagai teks. */
  dangerInk: string;
}

const lightSurface = '#FFFFFF';
const lightInk = '#14202E';
const lightBubbleOut = '#E3EEFF';

const darkBg = '#0F1620';
const darkSurface = '#16202C';
// DESIGN.md menulis #1B3557; digelapkan sedikit supaya link (`primary`) di dalam bubble
// keluar lolos 4.5:1 (4.40 → 4.53).
const darkBubbleOut = '#1A3354';

export const color: Record<ThemeName, ThemeColors> = {
  light: {
    bg: '#F6F4EF',
    surface: lightSurface,
    surface2: '#EFECE5',
    ink: lightInk,
    ink2: '#4A5869',
    line: '#E2DED5',
    primary: '#1167D8',
    accent: '#FF7A59',
    success: '#1F9D6B',
    warning: '#D99413',
    danger: '#D64545',
    bubbleOut: lightBubbleOut,
    bubbleIn: lightSurface,
    onPrimary: '#FFFFFF',
    onAccent: lightInk,
    primarySoft: lightBubbleOut,
    successInk: '#15784F',
    warningInk: '#8F5F00',
    dangerInk: '#C03535',
  },
  dark: {
    bg: darkBg,
    surface: darkSurface,
    surface2: '#1C2735',
    ink: '#E8EDF3',
    ink2: '#9FB0C3',
    line: '#263345',
    primary: '#4D9BFF',
    accent: '#FF8F72',
    success: '#3CC48D',
    warning: '#F2B544',
    danger: '#F07070',
    bubbleOut: darkBubbleOut,
    bubbleIn: darkSurface,
    onPrimary: darkBg,
    onAccent: darkBg,
    primarySoft: darkBubbleOut,
    // Di mode gelap warna status sudah cukup terang untuk teks.
    successInk: '#3CC48D',
    warningInk: '#F2B544',
    dangerInk: '#F07070',
  },
};

/** Bayangan: maksimal dua level, halus. */
export const shadow: Record<ThemeName, { 1: string; 2: string }> = {
  light: {
    1: '0 1px 2px rgb(20 32 46 / 0.08)',
    2: '0 12px 32px -8px rgb(20 32 46 / 0.18), 0 2px 6px rgb(20 32 46 / 0.06)',
  },
  dark: {
    1: '0 1px 2px rgb(0 0 0 / 0.4)',
    2: '0 12px 32px -8px rgb(0 0 0 / 0.6), 0 2px 6px rgb(0 0 0 / 0.3)',
  },
};

/**
 * Keluarga font. Nama pertama = font self-host, nama kedua = fallback lokal dengan
 * metrik yang disamakan (didefinisikan di `apps/web/src/styles/fonts.css`) supaya
 * tidak ada lompatan layout saat font selesai dimuat.
 */
export const font = {
  sans: "'Plus Jakarta Sans Variable', 'Plus Jakarta Sans Fallback', system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif",
  mono: "'JetBrains Mono Variable', 'JetBrains Mono Fallback', ui-monospace, 'Cascadia Mono', Consolas, monospace",
} as const;

/** Skala huruf dalam px (dasar 14). Dikeluarkan sebagai rem supaya ikut pengaturan browser. */
export const fontSizes = [12, 13, 14, 16, 20, 24, 32] as const;

export const fontWeight = { regular: 400, medium: 500, semibold: 600, bold: 700 } as const;

export const lineHeight = { text: 1.45, title: 1.2 } as const;

export const letterSpacing = { title: '-0.01em' } as const;

/** Spasi: kelipatan 4px. */
export const spaces = [4, 8, 12, 16, 24, 32, 48] as const;

export const radius = { input: 6, card: 10, bubble: 16, pill: 999 } as const;

/** Ukuran kerangka layar (DESIGN.md §2) dan kontrol, dalam px. */
export const size = {
  /** Rail navigasi desktop. */
  rail: 64,
  /** Daftar percakapan. */
  list: 360,
  /** Panel detail. */
  detail: 340,
  /** Target sentuh minimal di HP. */
  touch: 44,
  /** Tinggi header layar dan navigasi bawah. */
  bar: 56,
  /** Tinggi tombol dan input di desktop. */
  control: 36,
  iconSm: 16,
  iconMd: 20,
} as const;

/** Batas lebar layar (px). Dipakai di media query CSS dan `useMediaQuery`. */
export const breakpoints = {
  /** HP: lebar ≤ nilai ini memakai navigasi bawah. */
  hpMax: 640,
  /** Desktop: lebar ≥ nilai ini memakai tiga kolom. */
  desktopMin: 1024,
} as const;

/** Ikon: satu set (Lucide), stroke 1.75, ukuran 16 atau 20. */
export const icon = { strokeWidth: 1.75, sizes: [16, 20] } as const;

/** Gerak: 120–200ms, ease-out. `pulse` hanya untuk denyut skeleton. */
export const motion = {
  duration: { fast: 120, base: 160, slow: 200, pulse: 1400 },
  easeOut: 'cubic-bezier(0.2, 0, 0, 1)',
} as const;

// ---------------------------------------------------------------------------
// Token → CSS variables
// ---------------------------------------------------------------------------

export type CssVariables = Record<`--${string}`, string>;

/** `surface2` → `surface-2`, `bubbleOut` → `bubble-out`. */
function kebab(name: string): string {
  return name.replace(/([a-z])([A-Z0-9])/g, '$1-$2').toLowerCase();
}

/** Variabel yang nilainya bergantung tema: warna dan bayangan. */
export function themeVariables(theme: ThemeName): CssVariables {
  const vars: CssVariables = {};
  const colors: Record<string, string> = { ...color[theme] };
  for (const [name, value] of Object.entries(colors)) vars[`--${kebab(name)}`] = value;
  for (const [level, value] of Object.entries(shadow[theme])) vars[`--shadow-${level}`] = value;
  return vars;
}

/** Variabel yang sama di semua tema: huruf, spasi, radius, ukuran, gerak. */
export function staticVariables(): CssVariables {
  const vars: CssVariables = {
    '--font-sans': font.sans,
    '--font-mono': font.mono,
  };
  for (const px of fontSizes) vars[`--text-${px}`] = `${px / 16}rem`;
  for (const [name, value] of Object.entries(fontWeight)) vars[`--weight-${name}`] = `${value}`;
  for (const [name, value] of Object.entries(lineHeight)) vars[`--leading-${name}`] = `${value}`;
  for (const [name, value] of Object.entries(letterSpacing)) vars[`--tracking-${name}`] = value;
  for (const px of spaces) vars[`--space-${px}`] = `${px}px`;
  for (const [name, value] of Object.entries(radius)) vars[`--radius-${name}`] = `${value}px`;
  for (const [name, value] of Object.entries(size)) vars[`--size-${kebab(name)}`] = `${value}px`;
  for (const [name, value] of Object.entries(motion.duration)) {
    vars[`--duration-${name}`] = `${value}ms`;
  }
  vars['--ease-out'] = motion.easeOut;
  return vars;
}

// ---------------------------------------------------------------------------
// Kontras (WCAG 2.x)
// ---------------------------------------------------------------------------

function channelToLinear(channel: number): number {
  const c = channel / 255;
  return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
}

/** Luminans relatif warna `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!match?.[1]) throw new Error(`Warna harus berformat #RRGGBB, diterima: ${hex}`);
  const value = Number.parseInt(match[1], 16);
  return (
    0.2126 * channelToLinear((value >> 16) & 255) +
    0.7152 * channelToLinear((value >> 8) & 255) +
    0.0722 * channelToLinear(value & 255)
  );
}

/** Rasio kontras dua warna `#RRGGBB`, 1 sampai 21. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x) as [
    number,
    number,
  ];
  return (lighter + 0.05) / (darker + 0.05);
}

/** Minimal untuk teks (DESIGN.md §1). */
export const MIN_TEXT_CONTRAST = 4.5;
/** Minimal untuk ikon bermakna, cincin fokus, penanda aktif (WCAG 1.4.11). */
export const MIN_GRAPHIC_CONTRAST = 3;

export interface ContrastPair {
  fg: keyof ThemeColors;
  bg: keyof ThemeColors;
  min: number;
}

function pairs(
  min: number,
  fg: keyof ThemeColors,
  backgrounds: (keyof ThemeColors)[],
): ContrastPair[] {
  return backgrounds.map((bg) => ({ fg, bg, min }));
}

/**
 * Pasangan depan/latar yang BOLEH dipakai. Dites otomatis untuk kedua tema di
 * `apps/web/src/theme/contrast.test.ts`. Pasangan di luar daftar ini belum terjamin:
 * tambahkan di sini dulu sebelum dipakai di layar.
 */
export const contrastPairs: readonly ContrastPair[] = [
  ...pairs(MIN_TEXT_CONTRAST, 'ink', [
    'bg',
    'surface',
    'surface2',
    'bubbleOut',
    'bubbleIn',
    'primarySoft',
  ]),
  ...pairs(MIN_TEXT_CONTRAST, 'ink2', ['bg', 'surface', 'surface2', 'bubbleOut', 'bubbleIn']),
  // `primary` sebagai teks/link. Di atas `surface2` rasionya pas di ambang (4.50 pada
  // tema terang), jadi sengaja tidak didaftarkan sebagai teks.
  ...pairs(MIN_TEXT_CONTRAST, 'primary', ['bg', 'surface', 'bubbleOut', 'bubbleIn']),
  ...pairs(MIN_TEXT_CONTRAST, 'successInk', ['bg', 'surface', 'surface2']),
  ...pairs(MIN_TEXT_CONTRAST, 'warningInk', ['bg', 'surface', 'surface2']),
  ...pairs(MIN_TEXT_CONTRAST, 'dangerInk', ['bg', 'surface', 'surface2']),
  ...pairs(MIN_TEXT_CONTRAST, 'onPrimary', ['primary']),
  ...pairs(MIN_TEXT_CONTRAST, 'onAccent', ['accent']),
  // Tooltip: warna dibalik (latar `ink`, teks `bg`).
  ...pairs(MIN_TEXT_CONTRAST, 'bg', ['ink']),

  // Grafis non-teks: cincin fokus, penanda dan ikon navigasi aktif, ikon status.
  ...pairs(MIN_GRAPHIC_CONTRAST, 'primary', ['surface2', 'primarySoft']),
  ...pairs(MIN_GRAPHIC_CONTRAST, 'success', ['bg', 'surface']),
  ...pairs(MIN_GRAPHIC_CONTRAST, 'danger', ['bg', 'surface']),
  ...pairs(MIN_GRAPHIC_CONTRAST, 'warningInk', ['bg', 'surface', 'surface2']),
];
