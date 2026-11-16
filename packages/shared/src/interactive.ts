import { z } from 'zod';

/**
 * Pesan interaktif WhatsApp (Fase 3 — PRD §3.3 "Pesan interaktif"): tombol balasan (≤ 3) dan daftar
 * pilihan (≤ 10 baris total). Batas = WhatsApp Cloud API "Interactive messages" (dibaca 19 Nov 2026):
 *  - body ≤ 1.024, header teks ≤ 60, footer ≤ 60 karakter;
 *  - tombol: 1–3, judul ≤ 20, ID ≤ 256, ID unik;
 *  - daftar: teks tombol pembuka ≤ 20, 1–10 bagian, total baris 1–10, judul bagian ≤ 24 (WAJIB bila
 *    lebih dari satu bagian), judul baris ≤ 24, deskripsi baris ≤ 72, ID baris ≤ 200, ID unik.
 * Dipakai web (pemilih di composer), API web/v1, lapisan MobiChat, dan worker (bangun payload Meta).
 * Hanya di dalam jendela 24 jam (pesan sesi, bukan template).
 */

export const INTERACTIVE_LIMITS = {
  body: 1024,
  header: 60,
  footer: 60,
  buttonsMax: 3,
  buttonTitle: 20,
  buttonId: 256,
  listButton: 20,
  sectionsMax: 10,
  rowsMax: 10,
  sectionTitle: 24,
  rowTitle: 24,
  rowDescription: 72,
  rowId: 200,
} as const;

const text = (max: number, label: string, required = true) => {
  const base = z
    .string({ error: `${label} wajib diisi.` })
    .max(max, `${label} maksimal ${String(max)} karakter.`)
    .refine((value) => !value.includes('\u0000'), `${label} memuat karakter yang tidak didukung.`);
  return required ? base.refine((value) => value.trim().length > 0, `${label} wajib diisi.`) : base;
};

/** Isian opsional; string kosong/spasi = tidak ada (tanpa `transform`: skema juga dipakai di respons). */
const optionalText = (max: number, label: string) => text(max, label, false).optional();

const idOf = (max: number, label: string) =>
  z
    .string({ error: `${label} wajib diisi.` })
    .trim()
    .min(1, `${label} wajib diisi.`)
    .max(max, `${label} maksimal ${String(max)} karakter.`)
    .refine((value) => !/\p{Cc}/u.test(value), `${label} memuat karakter khusus.`);

export const interactiveButtonSchema = z.object({
  id: idOf(INTERACTIVE_LIMITS.buttonId, 'ID tombol'),
  title: text(INTERACTIVE_LIMITS.buttonTitle, 'Judul tombol'),
});

export const interactiveRowSchema = z.object({
  id: idOf(INTERACTIVE_LIMITS.rowId, 'ID pilihan'),
  title: text(INTERACTIVE_LIMITS.rowTitle, 'Judul pilihan'),
  description: optionalText(INTERACTIVE_LIMITS.rowDescription, 'Keterangan pilihan'),
});

export const interactiveSectionSchema = z.object({
  title: optionalText(INTERACTIVE_LIMITS.sectionTitle, 'Judul bagian'),
  rows: z.array(interactiveRowSchema).min(1, 'Setiap bagian butuh minimal satu pilihan.'),
});

const common = {
  body: text(INTERACTIVE_LIMITS.body, 'Isi pesan'),
  header: optionalText(INTERACTIVE_LIMITS.header, 'Judul pesan'),
  footer: optionalText(INTERACTIVE_LIMITS.footer, 'Catatan kaki'),
};

const unique = (ids: readonly string[]) => new Set(ids).size === ids.length;

export const interactiveMessageSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('button'),
    ...common,
    buttons: z
      .array(interactiveButtonSchema)
      .min(1, 'Isi minimal satu tombol.')
      .max(
        INTERACTIVE_LIMITS.buttonsMax,
        `Maksimal ${String(INTERACTIVE_LIMITS.buttonsMax)} tombol.`,
      )
      .refine(
        (buttons) => unique(buttons.map((button) => button.id)),
        'ID tombol tidak boleh kembar.',
      )
      .refine(
        (buttons) => unique(buttons.map((button) => button.title.trim().toLowerCase())),
        'Judul tombol tidak boleh kembar.',
      ),
  }),
  z.object({
    kind: z.literal('list'),
    ...common,
    /** Teks tombol yang membuka daftar (mis. "Pilih paket"). */
    buttonText: text(INTERACTIVE_LIMITS.listButton, 'Teks tombol daftar'),
    sections: z
      .array(interactiveSectionSchema)
      .min(1, 'Isi minimal satu bagian.')
      .max(
        INTERACTIVE_LIMITS.sectionsMax,
        `Maksimal ${String(INTERACTIVE_LIMITS.sectionsMax)} bagian.`,
      )
      .refine(
        (sections) =>
          sections.reduce((total, section) => total + section.rows.length, 0) <=
          INTERACTIVE_LIMITS.rowsMax,
        `Maksimal ${String(INTERACTIVE_LIMITS.rowsMax)} pilihan di seluruh daftar.`,
      )
      .refine(
        (sections) => unique(sections.flatMap((section) => section.rows.map((row) => row.id))),
        'ID pilihan tidak boleh kembar.',
      )
      .refine(
        (sections) => sections.length === 1 || sections.every((section) => section.title?.trim()),
        'Judul bagian wajib diisi bila daftar punya lebih dari satu bagian.',
      ),
  }),
]);
export type InteractiveMessage = z.infer<typeof interactiveMessageSchema>;
export type InteractiveMessageInput = z.input<typeof interactiveMessageSchema>;
