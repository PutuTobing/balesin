/**
 * Semua teks UI (bahasa Indonesia, gaya docs/DESIGN.md §4): santai-profesional, singkat,
 * tombol berupa kata kerja, pesan error menjelaskan jalan keluarnya.
 *
 * Nama produk dan maskot tidak ditulis di sini; teks yang membutuhkannya berupa fungsi
 * dan diisi dari konfigurasi merek (src/brand/brand.ts) supaya aman untuk white-label.
 */
export const t = {
  common: {
    skipToContent: 'Lewati ke konten',
    loading: 'Memuat…',
    retry: 'Coba lagi',
    backToInbox: 'Kembali ke Inbox',
    backTo: (page: string) => `Kembali ke ${page}`,
    documentTitle: (page: string, product: string) => `${page} · ${product}`,
    version: (product: string, version: string) => `${product} versi ${version}`,
  },

  nav: {
    label: 'Navigasi utama',
    home: (product: string) => `${product}, buka Inbox`,
    inbox: 'Inbox',
    contacts: 'Kontak',
    broadcast: 'Broadcast',
    tickets: 'Tiket',
    reports: 'Laporan',
    settings: 'Pengaturan',
    more: 'Lainnya',
  },

  theme: {
    title: 'Tema',
    change: 'Ganti tema',
    light: 'Terang',
    dark: 'Gelap',
    system: 'Ikuti sistem',
  },

  inbox: {
    title: 'Inbox',
    listLabel: 'Daftar chat',
    searchLabel: 'Cari chat',
    searchPlaceholder: 'Cari nama atau nomor',
    clearSearch: 'Hapus pencarian',
    tabsLabel: 'Saring chat menurut status',
    tabs: {
      semua: 'Semua',
      bot: 'Bot',
      'belum-dilayani': 'Belum dilayani',
      dilayani: 'Dilayani',
      selesai: 'Selesai',
    },
    empty: {
      semua: {
        title: 'Belum ada chat',
        body: (mascot: string) => `Tenang, ${mascot} jaga inbox-nya.`,
      },
      bot: {
        title: 'Bot sedang tidak memegang chat',
        body: () => 'Chat yang dijawab bot terkumpul di sini.',
      },
      'belum-dilayani': {
        title: 'Tidak ada chat yang menunggu',
        body: () => 'Chat baru yang belum diambil agen muncul di sini.',
      },
      dilayani: {
        title: 'Belum ada chat yang dilayani',
        body: () => 'Chat yang sedang ditangani agen terkumpul di sini.',
      },
      selesai: {
        title: 'Belum ada chat selesai',
        body: () => 'Chat yang sudah ditandai selesai tersimpan di sini.',
      },
    },
    searchEmpty: {
      title: (query: string) => `Tidak ketemu chat untuk “${query}”`,
      body: 'Coba nama atau nomor lain.',
    },
    chat: {
      label: 'Ruang chat',
      emptyTitle: 'Belum ada chat yang dibuka',
      emptyBody: 'Pilih chat dari daftar untuk membaca dan membalasnya di sini.',
    },
    detail: {
      label: 'Detail kontak',
      title: 'Detail',
      show: 'Tampilkan detail',
      hide: 'Sembunyikan detail',
      emptyBody:
        'Info kontak, agen yang menangani, tag, dan catatan tampil di sini saat chat dibuka.',
    },
  },

  contacts: {
    emptyTitle: 'Belum ada kontak',
    emptyBody: 'Kontak tersimpan otomatis begitu pelanggan mengirim chat pertama.',
  },

  broadcast: {
    emptyTitle: 'Belum ada broadcast',
    emptyBody:
      'Broadcast mengirim satu pesan template ke banyak pelanggan sekaligus, misalnya pengingat tagihan atau pengumuman.',
  },

  tickets: {
    emptyTitle: 'Belum ada tiket',
    emptyBody:
      'Tiket mencatat pekerjaan lanjutan dari chat, misalnya kunjungan teknisi, lengkap dengan penanggung jawab dan tenggatnya.',
  },

  reports: {
    emptyTitle: 'Belum ada yang bisa dilaporkan',
    emptyBody:
      'Jumlah chat, waktu respons, dan biaya pesan dirangkum di sini setelah ada chat masuk.',
  },

  settings: {
    appearance: {
      title: 'Tampilan',
      hint: 'Tema berlaku untuk perangkat ini saja.',
      themeLabel: 'Tema',
    },
  },

  more: {
    menuLabel: 'Menu lainnya',
  },

  notFound: {
    title: 'Halaman tidak ditemukan',
    body: 'Alamat ini tidak ada. Mungkin salah ketik, atau halamannya sudah dipindah.',
    pathLabel: 'Alamat yang dibuka',
  },

  error: {
    title: 'Halaman ini gagal dimuat',
    body: 'Biasanya karena koneksi terputus. Periksa internetmu, lalu coba lagi.',
    details: 'Detail teknis',
  },
} as const;
