import type { TemplatePreset } from './templates';

/**
 * Preset template industri (PRD §3.5 PENTING): draf UMUM siap diajukan — bisa diedit dulu, tetap
 * perlu persetujuan Meta. Generik white-label: tanpa nama perusahaan, tanpa URL/nomor (penyedia mengisi
 * sendiri). Variabel bernomor; contoh nilai realistis untuk tinjauan Meta. ISP dahulu; klinik &
 * sekolah menyusul.
 */

const isp = (preset: Omit<TemplatePreset, 'industry' | 'language'>): TemplatePreset => ({
  industry: 'isp',
  language: 'id',
  ...preset,
});

const quick = (...texts: string[]) => texts.map((text) => ({ type: 'QUICK_REPLY' as const, text }));

export const TEMPLATE_INDUSTRIES: Readonly<Record<string, string>> = {
  isp: 'Penyedia internet (ISP)',
};

export const TEMPLATE_PRESETS: readonly TemplatePreset[] = [
  isp({
    key: 'isp_tagihan_jatuh_tempo',
    title: 'Pengingat tagihan jatuh tempo',
    description: 'Dikirim beberapa hari sebelum / saat jatuh tempo.',
    name: 'tagihan_jatuh_tempo',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: { format: 'TEXT', text: 'Pengingat Tagihan Internet' },
      body: {
        text: 'Halo {{1}}, tagihan internet periode {{2}} sebesar {{3}} jatuh tempo pada {{4}}. Mohon lakukan pembayaran sebelum jatuh tempo agar layanan tetap aktif. Abaikan pesan ini bila sudah membayar.',
        examples: { '1': 'Budi', '2': 'November 2026', '3': 'Rp150.000', '4': '20 November 2026' },
      },
      footer: null,
      buttons: quick('Sudah bayar', 'Butuh bantuan'),
      authentication: null,
    },
  }),
  isp({
    key: 'isp_pembayaran_diterima',
    title: 'Pembayaran diterima',
    description: 'Konfirmasi setelah pembayaran tercatat.',
    name: 'pembayaran_diterima',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Terima kasih {{1}}, pembayaran tagihan {{2}} sebesar {{3}} sudah kami terima pada {{4}}. Layanan internet Anda aktif sampai {{5}}.',
        examples: {
          '1': 'Budi',
          '2': 'November 2026',
          '3': 'Rp150.000',
          '4': '18 November 2026',
          '5': '20 Desember 2026',
        },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
  }),
  isp({
    key: 'isp_layanan_diisolir',
    title: 'Layanan diisolir',
    description: 'Pemberitahuan layanan dinonaktifkan sementara karena tagihan belum dibayar.',
    name: 'layanan_diisolir',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, layanan internet Anda dengan ID {{2}} sementara dinonaktifkan karena tagihan {{3}} sebesar {{4}} belum dibayar. Layanan aktif kembali otomatis setelah pembayaran kami terima.',
        examples: { '1': 'Budi', '2': '100123', '3': 'November 2026', '4': 'Rp150.000' },
      },
      footer: null,
      buttons: quick('Cara bayar', 'Butuh bantuan'),
      authentication: null,
    },
  }),
  isp({
    key: 'isp_layanan_aktif_kembali',
    title: 'Layanan aktif kembali',
    description: 'Setelah isolir dibuka.',
    name: 'layanan_aktif_kembali',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, layanan internet Anda dengan ID {{2}} sudah aktif kembali. Terima kasih atas pembayarannya. Bila internet belum tersambung, matikan lalu nyalakan ulang modem.',
        examples: { '1': 'Budi', '2': '100123' },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
  }),
  isp({
    key: 'isp_gangguan_jaringan',
    title: 'Gangguan jaringan massal',
    description: 'Informasi gangguan di satu area beserta perkiraan pulih.',
    name: 'gangguan_jaringan',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: { format: 'TEXT', text: 'Info Gangguan Jaringan' },
      body: {
        text: 'Halo {{1}}, saat ini terjadi gangguan jaringan di area {{2}} sejak {{3}}. Tim teknisi sedang menangani dengan perkiraan pulih {{4}}. Mohon maaf atas ketidaknyamanannya.',
        examples: { '1': 'Budi', '2': 'Desa Sukamaju', '3': 'pukul 09.00', '4': 'pukul 13.00' },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
  }),
  isp({
    key: 'isp_gangguan_pulih',
    title: 'Gangguan sudah pulih',
    description: 'Kabar bahwa jaringan di area tersebut sudah normal.',
    name: 'gangguan_pulih',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, gangguan jaringan di area {{2}} sudah pulih. Bila internet Anda masih bermasalah, matikan lalu nyalakan ulang modem, atau balas pesan ini.',
        examples: { '1': 'Budi', '2': 'Desa Sukamaju' },
      },
      footer: null,
      buttons: quick('Sudah normal', 'Masih bermasalah'),
      authentication: null,
    },
  }),
  isp({
    key: 'isp_tiket_perbaikan',
    title: 'Tiket perbaikan dibuat',
    description: 'Konfirmasi laporan gangguan pelanggan beserta nomor tiket.',
    name: 'tiket_perbaikan_dibuat',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, laporan gangguan Anda sudah kami terima dengan nomor tiket {{2}}. Kami akan mengabari perkembangan perbaikannya di chat ini.',
        examples: { '1': 'Budi', '2': 'TK-20261118-07' },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
  }),
  isp({
    key: 'isp_jadwal_teknisi',
    title: 'Jadwal kunjungan teknisi',
    description: 'Konfirmasi jadwal kunjungan teknisi ke lokasi pelanggan.',
    name: 'jadwal_teknisi',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, teknisi kami {{2}} dijadwalkan datang ke lokasi Anda pada {{3}} untuk {{4}}. Balas pesan ini bila perlu mengubah jadwal.',
        examples: {
          '1': 'Budi',
          '2': 'Andi',
          '3': 'Kamis, 20 November 2026 pukul 10.00',
          '4': 'perbaikan kabel',
        },
      },
      footer: null,
      buttons: quick('Jadwal sesuai', 'Ubah jadwal'),
      authentication: null,
    },
  }),
  isp({
    key: 'isp_pelanggan_baru',
    title: 'Selamat datang pelanggan baru',
    description: 'Dikirim setelah pemasangan selesai.',
    name: 'pelanggan_baru',
    category: 'UTILITY',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Selamat bergabung, {{1}}! Layanan internet Anda dengan ID pelanggan {{2}} sudah aktif. Simpan nomor ini untuk info tagihan dan bantuan teknis.',
        examples: { '1': 'Budi', '2': '100123' },
      },
      footer: null,
      buttons: [],
      authentication: null,
    },
  }),
  isp({
    key: 'isp_promo_upgrade',
    title: 'Penawaran upgrade paket',
    description:
      'Contoh template pemasaran (tarif Meta lebih mahal; hanya untuk pelanggan yang setuju).',
    name: 'promo_upgrade_paket',
    category: 'MARKETING',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: {
        text: 'Halo {{1}}, nikmati internet lebih cepat! Upgrade ke paket {{2}} cukup tambah {{3}} per bulan. Balas pesan ini untuk info lebih lanjut.',
        examples: { '1': 'Budi', '2': '30 Mbps', '3': 'Rp50.000' },
      },
      footer: { text: 'Balas STOP bila tidak ingin menerima promo.' },
      buttons: quick('Mau upgrade', 'Tidak sekarang'),
      authentication: null,
    },
  }),
  isp({
    key: 'isp_kode_verifikasi',
    title: 'Kode verifikasi (OTP)',
    description: 'Kode masuk aplikasi pelanggan / portal tagihan.',
    name: 'kode_verifikasi',
    category: 'AUTHENTICATION',
    content: {
      parameterFormat: 'positional',
      header: null,
      body: { text: '', examples: {} },
      footer: null,
      buttons: [],
      authentication: { addSecurityRecommendation: true, codeExpirationMinutes: 10 },
    },
  }),
];

export function findTemplatePreset(key: string): TemplatePreset | undefined {
  return TEMPLATE_PRESETS.find((preset) => preset.key === key);
}
