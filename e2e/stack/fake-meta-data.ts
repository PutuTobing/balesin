/**
 * Data server Meta TIRUAN untuk E2E (`fake-meta-server.ts`). Semua nilai KHUSUS TES — bukan token
 * atau App Secret sungguhan, dan tidak pernah dikirim ke graph.facebook.com: API E2E diarahkan ke
 * server tiruan lewat `META_GRAPH_BASE_URL` (hanya diterima di development/test, alamat loopback).
 *
 * Proyek desktop dan HP berjalan bersamaan dengan Owner yang sama, jadi masing-masing memakai
 * nomor sendiri (Phone Number ID unik per channel, profil bisnis tidak saling menimpa).
 */
export const FAKE_META = {
  /** App Secret aplikasi tiruan (huruf + angka, 32 karakter). */
  appSecret: 'e2eAppSecretTiruan0123456789abcd',
  /** Token System User sah milik aplikasi tiruan. */
  token: 'EAAGe2eTokenSahTiruan_0123456789abcdefghij',
  /** Token sah lain (dipakai saat "ganti token"). */
  replacementToken: 'EAAGe2eTokenPenggantiTiruan_9876543210zyxw',
  /** Format sah, tetapi tidak dikenal server tiruan → Meta 190 → `token_invalid`. */
  wrongToken: 'EAAGe2eTokenSalahTidakDikenal_00000000000',
  wabaId: '200000000000001',
  numbers: {
    desktop: {
      id: '100000000000001',
      display: '+62 811-0000-1001',
      verifiedName: 'Maju Jaya Desktop',
    },
    hp: {
      id: '100000000000002',
      display: '+62 811-0000-1002',
      verifiedName: 'Maju Jaya HP',
    },
    /** Inbox (`inbox-pesan.spec.ts`): satu nomor per tes supaya tidak bentrok dengan Channel. */
    inboxDesktop: {
      id: '100000000000011',
      display: '+62 811-0000-1011',
      verifiedName: 'Maju Jaya Inbox',
    },
    inboxHp: {
      id: '100000000000012',
      display: '+62 811-0000-1012',
      verifiedName: 'Maju Jaya Inbox HP',
    },
    inboxScope: {
      id: '100000000000013',
      display: '+62 811-0000-1013',
      verifiedName: 'Maju Jaya Inbox Cakupan',
    },
    inboxReply: {
      id: '100000000000014',
      display: '+62 811-0000-1014',
      verifiedName: 'Maju Jaya Inbox Balas',
    },
    inboxDetail: {
      id: '100000000000015',
      display: '+62 811-0000-1015',
      verifiedName: 'Maju Jaya Inbox Detail',
    },
    inboxBot: {
      id: '100000000000016',
      display: '+62 811-0000-1016',
      verifiedName: 'Maju Jaya Bot',
    },
  },
  profile: {
    about: 'Internet cepat untuk rumah dan kantor.',
    address: 'Jl. Pahlawan No. 12, Bandar Lampung',
    description: 'Pasang baru, ganti paket, dan laporan gangguan lewat chat ini.',
    email: 'cs@majujaya.test',
    websites: ['https://majujaya.test'],
    vertical: 'PROF_SERVICES',
  },
} as const;

/** Baris yang dicetak server tiruan setelah siap: `FAKE_META_URL=http://127.0.0.1:<port>`. */
export const FAKE_META_READY_PREFIX = 'FAKE_META_URL=';
