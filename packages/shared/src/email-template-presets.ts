/**
 * Preset template email ISP (Fase 9.1, docs/KONTRAK-API-EMAIL-KIRIM.md §7). Generik white-label:
 * tanpa nama perusahaan, URL, atau nomor — nama organisasi lewat variabel bawaan
 * `{{nama_organisasi}}`, gambar QRIS lewat slot `{{qris}}`. Semua `layout: 'brand'` (bingkai merek +
 * logo Branding). Versi teks dibuat otomatis dari HTML (`text: null`).
 *
 * Variabel opsional tidak dipakai di `href` (nilai kosong = tautan rusak): `tautan_bayar` tampil
 * sebagai teks biasa.
 */
export const EMAIL_TEMPLATE_PRESET_KEYS = [
  'tagihan-bulanan',
  'pengingat-jatuh-tempo',
  'kode-va',
  'pembayaran-diterima',
  'layanan-diisolir',
  'layanan-aktif-kembali',
] as const;
export type EmailTemplatePresetKey = (typeof EMAIL_TEMPLATE_PRESET_KEYS)[number];

export interface EmailTemplatePresetVariable {
  name: string;
  label: string;
  required: boolean;
  example: string;
}

export interface EmailTemplatePreset {
  key: EmailTemplatePresetKey;
  name: string;
  description: string;
  subject: string;
  html: string;
  text: string | null;
  layout: 'brand';
  footerText: string | null;
  variables: readonly EmailTemplatePresetVariable[];
}

const P = 'margin: 0 0 16px 0;';
const CELL = 'padding: 8px 0; border-bottom: 1px solid #e5e7eb;';

const paragraph = (content: string) => `<p style="${P}">${content}</p>`;

/** Tabel rincian dua kolom (label kiri, nilai kanan). */
function details(rows: readonly (readonly [string, string])[]): string {
  const body = rows
    .map(
      ([label, value]) =>
        `<tr><td style="${CELL} color: #6b7280;">${label}</td>` +
        `<td align="right" style="${CELL} font-weight: bold; color: #111827;">${value}</td></tr>`,
    )
    .join('');
  return `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border-collapse: collapse; ${P}">${body}</table>`;
}

const QRIS_SLOT = `<div style="text-align: center; ${P}">{{qris}}</div>`;
const THANKS = paragraph('Terima kasih sudah memakai layanan {{nama_organisasi}}.');
const AUTO_FOOTER =
  'Email ini dikirim otomatis. Abaikan bila pembayaranmu sudah kami terima. Ada pertanyaan? Balas email ini.';

const v = (
  name: string,
  label: string,
  required: boolean,
  example: string,
): EmailTemplatePresetVariable => ({ name, label, required, example });

const NAMA = v('nama', 'Nama pelanggan', true, 'Budi Santoso');
const ID_PELANGGAN = v('id_pelanggan', 'ID pelanggan', true, 'PLG-00873');
const PERIODE = v('periode', 'Periode tagihan', true, 'November 2026');
const TOTAL = v('total', 'Total tagihan', true, 'Rp185.000');
const JATUH_TEMPO = v('jatuh_tempo', 'Tanggal jatuh tempo', true, '25 November 2026');
const BANK_VA = v('bank_va', 'Bank virtual account', false, 'BRI');
const KODE_VA = v('kode_va', 'Nomor virtual account', false, '8808 0000 0000 0001');
const TAUTAN_BAYAR = v(
  'tautan_bayar',
  'Tautan pembayaran',
  false,
  'https://bayar.contoh.example/PLG-00873',
);

export const EMAIL_TEMPLATE_PRESETS: readonly EmailTemplatePreset[] = [
  {
    key: 'tagihan-bulanan',
    name: 'Tagihan bulanan',
    description: 'Tagihan internet bulanan berisi total, jatuh tempo, virtual account, dan QRIS.',
    subject: 'Tagihan {{periode}} — {{id_pelanggan}}',
    html: [
      paragraph('Halo {{nama}},'),
      paragraph('Tagihan internetmu untuk periode {{periode}} sudah terbit. Berikut rinciannya:'),
      details([
        ['ID pelanggan', '{{id_pelanggan}}'],
        ['Periode', '{{periode}}'],
        ['Total tagihan', '{{total}}'],
        ['Jatuh tempo', '{{jatuh_tempo}}'],
        ['Bank virtual account', '{{bank_va}}'],
        ['Nomor virtual account', '{{kode_va}}'],
      ]),
      paragraph('Bayar lewat tautan: {{tautan_bayar}}'),
      paragraph(
        'Bisa juga pindai kode QRIS di bawah ini dengan aplikasi bank atau dompet digital (bila tersedia).',
      ),
      QRIS_SLOT,
      paragraph('Bayar sebelum tanggal jatuh tempo supaya layananmu tetap lancar, ya.'),
      THANKS,
    ].join(''),
    text: null,
    layout: 'brand',
    footerText: AUTO_FOOTER,
    variables: [NAMA, ID_PELANGGAN, PERIODE, TOTAL, JATUH_TEMPO, BANK_VA, KODE_VA, TAUTAN_BAYAR],
  },
  {
    key: 'pengingat-jatuh-tempo',
    name: 'Pengingat jatuh tempo',
    description: 'Pengingat sebelum tagihan jatuh tempo, lengkap dengan cara bayar.',
    subject: 'Pengingat: tagihan {{id_pelanggan}} jatuh tempo {{jatuh_tempo}}',
    html: [
      paragraph('Halo {{nama}},'),
      paragraph(
        'Kami ingin mengingatkan, tagihan internetmu akan jatuh tempo pada {{jatuh_tempo}}. Kalau sudah bayar, abaikan saja email ini.',
      ),
      details([
        ['ID pelanggan', '{{id_pelanggan}}'],
        ['Total tagihan', '{{total}}'],
        ['Jatuh tempo', '{{jatuh_tempo}}'],
        ['Bank virtual account', '{{bank_va}}'],
        ['Nomor virtual account', '{{kode_va}}'],
      ]),
      paragraph('Bayar lewat tautan: {{tautan_bayar}}'),
      paragraph(
        'Bisa juga pindai kode QRIS di bawah ini dengan aplikasi bank atau dompet digital (bila tersedia).',
      ),
      QRIS_SLOT,
      THANKS,
    ].join(''),
    text: null,
    layout: 'brand',
    footerText: AUTO_FOOTER,
    variables: [NAMA, ID_PELANGGAN, TOTAL, JATUH_TEMPO, BANK_VA, KODE_VA, TAUTAN_BAYAR],
  },
  {
    key: 'kode-va',
    name: 'Kode virtual account',
    description: 'Nomor virtual account untuk membayar tagihan.',
    subject: 'Nomor virtual account untuk pembayaranmu',
    html: [
      paragraph('Halo {{nama}},'),
      paragraph('Berikut nomor virtual account untuk membayar tagihanmu:'),
      details([
        ['ID pelanggan', '{{id_pelanggan}}'],
        ['Bank', '{{bank_va}}'],
        ['Nomor virtual account', '{{kode_va}}'],
        ['Total yang dibayar', '{{total}}'],
        ['Berlaku sampai', '{{berlaku_sampai}}'],
      ]),
      paragraph(
        'Bayar dengan nominal yang sama persis lewat ATM, mobile banking, atau internet banking. Pembayaran tercatat otomatis.',
      ),
      THANKS,
    ].join(''),
    text: null,
    layout: 'brand',
    footerText: AUTO_FOOTER,
    variables: [
      NAMA,
      ID_PELANGGAN,
      { ...BANK_VA, required: true },
      { ...KODE_VA, required: true },
      TOTAL,
      v('berlaku_sampai', 'Berlaku sampai', false, '25 November 2026 23.59 WIB'),
    ],
  },
  {
    key: 'pembayaran-diterima',
    name: 'Pembayaran diterima',
    description: 'Bukti pembayaran tagihan sudah diterima.',
    subject: 'Pembayaran {{periode}} sudah kami terima',
    html: [
      paragraph('Halo {{nama}},'),
      paragraph('Terima kasih, pembayaranmu untuk periode {{periode}} sudah kami terima.'),
      details([
        ['ID pelanggan', '{{id_pelanggan}}'],
        ['Periode', '{{periode}}'],
        ['Total dibayar', '{{total}}'],
        ['Tanggal bayar', '{{tanggal_bayar}}'],
        ['Metode bayar', '{{metode_bayar}}'],
        ['Nomor transaksi', '{{nomor_transaksi}}'],
      ]),
      paragraph('Simpan email ini sebagai bukti pembayaran.'),
      THANKS,
    ].join(''),
    text: null,
    layout: 'brand',
    footerText: 'Email ini dikirim otomatis. Ada pertanyaan? Balas email ini.',
    variables: [
      NAMA,
      ID_PELANGGAN,
      PERIODE,
      { ...TOTAL, label: 'Total dibayar' },
      v('tanggal_bayar', 'Tanggal bayar', true, '20 November 2026'),
      v('metode_bayar', 'Metode bayar', false, 'Virtual account BRI'),
      v('nomor_transaksi', 'Nomor transaksi', false, 'TRX-2611-0042'),
    ],
  },
  {
    key: 'layanan-diisolir',
    name: 'Layanan dihentikan sementara',
    description: 'Pemberitahuan layanan diisolir karena tagihan belum dibayar.',
    subject: 'Layanan internet {{id_pelanggan}} dihentikan sementara',
    html: [
      paragraph('Halo {{nama}},'),
      paragraph(
        'Layanan internetmu dihentikan sementara karena tagihan belum kami terima. Layanan aktif kembali otomatis setelah pembayaran masuk.',
      ),
      details([
        ['ID pelanggan', '{{id_pelanggan}}'],
        ['Total tagihan', '{{total}}'],
      ]),
      paragraph('Bayar lewat tautan: {{tautan_bayar}}'),
      paragraph(
        'Bisa juga pindai kode QRIS di bawah ini dengan aplikasi bank atau dompet digital (bila tersedia).',
      ),
      QRIS_SLOT,
      paragraph('Butuh bantuan? Hubungi layanan pelanggan kami: {{kontak_cs}}'),
      THANKS,
    ].join(''),
    text: null,
    layout: 'brand',
    footerText: AUTO_FOOTER,
    variables: [
      NAMA,
      ID_PELANGGAN,
      TOTAL,
      TAUTAN_BAYAR,
      v('kontak_cs', 'Kontak layanan pelanggan', false, 'cs@contoh.example'),
    ],
  },
  {
    key: 'layanan-aktif-kembali',
    name: 'Layanan aktif kembali',
    description: 'Pemberitahuan layanan sudah aktif lagi setelah pembayaran.',
    subject: 'Layanan internet {{id_pelanggan}} aktif kembali',
    html: [
      paragraph('Halo {{nama}},'),
      paragraph('Kabar baik: layanan internetmu sudah aktif kembali. Selamat berselancar lagi!'),
      details([
        ['ID pelanggan', '{{id_pelanggan}}'],
        ['Paket', '{{paket}}'],
      ]),
      paragraph(
        'Kalau internet belum tersambung dalam beberapa menit, coba matikan lalu nyalakan lagi modem atau router-mu.',
      ),
      THANKS,
    ].join(''),
    text: null,
    layout: 'brand',
    footerText: 'Email ini dikirim otomatis. Ada pertanyaan? Balas email ini.',
    variables: [NAMA, ID_PELANGGAN, v('paket', 'Paket layanan', false, 'Internet 30 Mbps')],
  },
];
