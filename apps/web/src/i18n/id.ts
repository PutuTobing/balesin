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
      'Tiket mencatat pekerjaan lanjutan dari chat, misalnya keluhan yang perlu ditindaklanjuti, lengkap dengan penanggung jawab dan tenggatnya.',
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

  api: {
    network: 'Tidak bisa terhubung ke server. Periksa koneksi internetmu, lalu coba lagi.',
    unreachable: 'Server aplikasi belum bisa dihubungi. Coba lagi beberapa saat lagi.',
    invalidResponse: 'Jawaban server tidak bisa dibaca. Muat ulang halaman, lalu coba lagi.',
    retryIn: (wait: string) => `Bisa dicoba lagi dalam ${wait}.`,
  },

  time: {
    /** Lama tunggu yang ramah dibaca: "45 detik", "3 menit", "1 menit 20 detik". */
    wait: (totalSeconds: number) => {
      const seconds = Math.max(0, Math.ceil(totalSeconds));
      if (seconds < 60) return `${seconds} detik`;
      const minutes = Math.floor(seconds / 60);
      const rest = seconds % 60;
      return rest === 0 ? `${minutes} menit` : `${minutes} menit ${rest} detik`;
    },
  },

  boot: {
    loading: 'Menyiapkan aplikasi…',
    failedTitle: 'Server belum bisa dihubungi',
    failedBody:
      'Aplikasi tidak bisa memeriksa sesimu. Periksa koneksi internet, atau tunggu sebentar bila server sedang dinyalakan ulang.',
  },

  form: {
    optional: 'Opsional',
    required: 'wajib',
    showPassword: 'Tampilkan password',
    hidePassword: 'Sembunyikan password',
    fixErrors: (count: number) =>
      count === 1
        ? 'Ada 1 isian yang perlu diperbaiki.'
        : `Ada ${count} isian yang perlu diperbaiki.`,
    passwordsDiffer: 'Password tidak sama. Ketik ulang password yang sama.',
    repeatRequired: 'Ketik ulang password.',
  },

  auth: {
    login: {
      title: 'Masuk',
      heading: (organization: string | null) =>
        organization ? `Masuk ke ${organization}` : 'Masuk ke akunmu',
      subtitle: 'Pakai email dan password yang didaftarkan untukmu.',
      email: 'Email',
      emailPlaceholder: 'Contoh: nama@perusahaan.co.id',
      password: 'Password',
      submit: 'Masuk',
      submitting: 'Memeriksa…',
      noAccount:
        'Belum punya akun? Akun dibuat lewat undangan. Minta Owner atau Admin timmu mengirim undangan.',
      lockedTitle: 'Masuk dikunci sementara',
      countdownButton: (clock: string) => `Coba lagi dalam ${clock}`,
      unlocked: 'Kamu sudah bisa mencoba masuk lagi.',
      sessionEnded: 'Sesimu sudah berakhir. Masuk lagi untuk melanjutkan.',
      loggedOut: 'Kamu sudah keluar. Sampai jumpa lagi!',
      heroTitle: 'Semua chat pelanggan, satu inbox untuk seluruh tim.',
      heroBody: 'Balas lebih cepat, bagi tugas dengan rapi, dan pantau semuanya dari satu tempat.',
    },
    userMenu: {
      open: (name: string) => `Akun ${name}`,
      signedInAs: 'Masuk sebagai',
      logout: 'Keluar',
      loggingOut: 'Keluar…',
      logoutFailed: 'Gagal keluar. Periksa koneksimu, lalu coba lagi.',
      account: 'Akun',
    },
  },

  setup: {
    documentTitle: 'Setup awal',
    eyebrow: 'Setup awal',
    stepOf: (current: number, total: number) => `Langkah ${current} dari ${total}`,
    stepsLabel: 'Langkah setup',
    stepDone: 'selesai',
    stepCurrent: 'langkah sekarang',
    optional: 'Opsional',
    back: 'Kembali',
    next: 'Lanjut',
    checking: 'Memeriksa…',
    skip: 'Lewati',
    intro: 'Siapkan aplikasi untuk timmu. Butuh sekitar 5 menit; email pengirim bisa diisi nanti.',
    steps: {
      token: {
        nav: 'Token setup',
        title: 'Masukkan token setup',
        body: 'Token ini membuktikan kamu yang memasang server. Lihat isian `SETUP_TOKEN` di berkas `.env` server, atau di tautan yang dicetak installer.',
        label: 'Token setup',
        hint: 'Salin persis, termasuk huruf besar-kecilnya.',
        fromLink: 'Token dari tautan setup sudah terisi.',
      },
      organization: {
        nav: 'Organisasi',
        title: 'Tentang organisasimu',
        body: 'Nama ini tampil di halaman masuk dan di email untuk timmu.',
        name: 'Nama perusahaan',
        namePlaceholder: 'Contoh: PT Maju Jaya',
        timezone: 'Zona waktu',
        timezoneHint: 'Dipakai untuk jam kerja, laporan, dan waktu di chat.',
      },
      owner: {
        nav: 'Akun Owner',
        title: 'Buat akun Owner',
        body: 'Owner memegang semua pengaturan dan bisa mengundang anggota tim lain. Setelah ini kamu langsung masuk dengan akun ini.',
        name: 'Nama lengkap',
        email: 'Email',
        emailHint: 'Untuk masuk dan menerima email penting.',
        password: 'Password',
        repeat: 'Ulangi password',
        strength: {
          label: 'Kekuatan password',
          empty: 'Minimal 10 karakter.',
          tooShort: (missing: number) => `Kurang ${missing} karakter lagi.`,
          weak: 'Lumayan. Tambah panjang atau campur kata yang tidak umum.',
          good: 'Bagus.',
          strong: 'Kuat.',
          checking: 'Memeriksa ke server…',
          accepted: 'Siap dipakai.',
        },
      },
      branding: {
        nav: 'Tampilan',
        title: 'Sesuaikan tampilan',
        body: 'Nama aplikasi dan logo milikmu tampil di halaman masuk, menu, dan email. Keduanya bisa dilewati dan diubah nanti.',
        productName: 'Nama aplikasi',
        productNameHint: (fallback: string) => `Kosongkan untuk memakai “${fallback}”.`,
        logo: 'Logo',
        logoHint:
          'PNG, JPG, atau WebP, maksimal 256 KB. Bentuk melebar atau persegi, latar transparan paling rapi.',
        logoChoose: 'Pilih logo',
        logoReplace: 'Ganti logo',
        logoRemove: 'Hapus logo',
        logoType: 'Logo harus berupa gambar PNG, JPG, atau WebP.',
        logoTooLarge: (kb: number) =>
          `Ukuran logo ${kb} KB, maksimal 256 KB. Perkecil gambarnya lalu coba lagi.`,
        logoUnreadable: 'Berkas logo tidak bisa dibaca. Pilih ulang gambarnya.',
        logoPreviewAlt: 'Pratinjau logo',
        logoSelected: (name: string, kb: number) => `${name} · ${kb} KB`,
      },
      email: {
        nav: 'Email pengirim',
        title: 'Email pengirim',
        body: 'Dipakai untuk mengirim undangan tim dan reset password. Boleh dilewati dan diisi nanti di Pengaturan → Email pengirim.',
        skipNote: 'Tanpa email pengirim, undangan tim dan reset password belum bisa dikirim.',
        skipped: 'Dilewati. Bisa diisi nanti di Pengaturan.',
        noMasterKeyTitle: 'Email pengirim belum bisa disimpan',
        noMasterKeyBody:
          'Server belum punya kunci enkripsi (`BALESIN_MASTER_KEY` di berkas `.env`), jadi password email tidak bisa disimpan dengan aman. Lewati langkah ini dulu; setelah kunci diisi dan server dinyalakan ulang, atur email di Pengaturan.',
      },
      summary: {
        nav: 'Ringkasan',
        title: 'Periksa lalu selesaikan',
        body: 'Pastikan semuanya sudah benar. Setelah selesai, kamu langsung masuk ke Inbox.',
        edit: 'Ubah',
        editSection: (section: string) => `Ubah ${section}`,
        organization: 'Organisasi',
        timezone: 'Zona waktu',
        owner: 'Owner',
        branding: 'Tampilan',
        productName: 'Nama aplikasi',
        logo: 'Logo',
        email: 'Email pengirim',
        defaultValue: 'Bawaan',
        noLogo: 'Tanpa logo',
        logoAttached: 'Terpasang',
        emailSkipped: 'Dilewati, atur nanti',
        sender: 'Pengirim',
        server: 'Server',
        emailTested: 'Tes koneksi berhasil',
        emailUntested: 'Belum dites',
        submit: 'Selesai dan masuk',
        submitting: 'Menyimpan…',
        errorInStep: (step: string) => `Ada yang perlu diperbaiki di langkah ${step}.`,
      },
    },
    blocked: {
      noTokenTitle: 'Setup belum bisa dimulai',
      noTokenBody:
        'Server belum punya token setup. Isi `SETUP_TOKEN` di berkas `.env` server (minimal 32 karakter acak), nyalakan ulang server, lalu muat ulang halaman ini.',
      noTokenCommand: 'Contoh membuat token acak:',
      copy: 'Salin perintah',
      copied: 'Tersalin',
      copiedAnnouncement: 'Perintah tersalin ke clipboard.',
      reload: 'Muat ulang',
      doneTitle: 'Setup sudah selesai',
      doneBody: 'Akun Owner sudah dibuat sebelumnya. Masuk dengan akun yang sudah ada.',
      goToLogin: 'Ke halaman masuk',
      failedTitle: 'Status setup tidak bisa dimuat',
      failedBody:
        'Halaman setup belum bisa menghubungi server. Periksa koneksi internet, atau tunggu sebentar bila server sedang dinyalakan ulang.',
    },
    timezones: {
      'Asia/Jakarta': 'WIB · Asia/Jakarta',
      'Asia/Pontianak': 'WIB · Asia/Pontianak',
      'Asia/Makassar': 'WITA · Asia/Makassar',
      'Asia/Jayapura': 'WIT · Asia/Jayapura',
      'Asia/Singapore': 'Asia/Singapore',
      'Asia/Kuala_Lumpur': 'Asia/Kuala_Lumpur',
      UTC: 'UTC',
    },
  },

  emailSettings: {
    title: 'Email pengirim',
    menuHint: 'Untuk undangan tim, reset password, dan notifikasi.',
    presetLabel: 'Penyedia email',
    senderLegend: 'Pengirim',
    fromName: 'Nama pengirim',
    fromNamePlaceholder: 'Contoh: Tim CS Maju Jaya',
    fromAddress: 'Alamat email pengirim',
    fromAddressPlaceholder: 'Contoh: cs@perusahaan.co.id',
    replyTo: 'Alamat balas-ke',
    replyToHint: 'Balasan penerima diarahkan ke alamat ini.',
    server: 'Server SMTP',
    host: 'Host SMTP',
    hostPlaceholder: 'Contoh: mail.perusahaan.co.id',
    port: 'Port',
    security: 'Keamanan',
    username: 'Username',
    usernameHint: 'Biasanya sama dengan alamat email pengirim.',
    password: 'Password',
    passwordRequired: 'Password wajib diisi.',
    appPassword: 'App password',
    passwordKeep: (hint: string) =>
      `Tersimpan (${hint}). Kosongkan untuk tetap memakai password ini.`,
    passwordKeepNoHint: 'Tersimpan. Kosongkan untuk tetap memakai password ini.',
    passwordReenter:
      'Host, port, keamanan, atau username berubah, jadi password perlu dimasukkan ulang.',
    detecting: 'Mencari server email untuk domain ini…',
    suggestionTitle: 'Saran pengaturan',
    useSuggestion: 'Pakai saran ini',
    suggestionUsed: 'Saran dipakai',
    noSuggestion: (domain: string) =>
      `Tidak ada saran untuk ${domain}. Isi host dan port sesuai petunjuk penyedia emailmu.`,
    testTitle: 'Tes pengaturan',
    testBody: 'Tes dulu sebelum disimpan supaya email undangan pasti terkirim.',
    testConnection: 'Tes koneksi',
    testingConnection: 'Menguji…',
    sendTest: 'Kirim email tes',
    sendingTest: 'Mengirim…',
    sendTestTo: 'Kirim email tes ke',
    sendTestOk: (to: string) => `Email tes terkirim ke ${to}. Cek kotak masuk (atau folder spam).`,
    testedAt: (time: string) => `Dites ${time}`,
    save: 'Simpan',
    saving: 'Menyimpan…',
    saved: 'Pengaturan email tersimpan.',
    status: 'Status',
    lastTest: 'Tes terakhir',
    neverTested: 'Belum pernah dites',
    source: 'Sumber',
    sources: {
      database: 'Diatur di aplikasi',
      env: 'Berkas `.env` server (cadangan)',
      none: 'Belum diatur',
    },
    envNotice:
      'Pengaturan yang berlaku sekarang berasal dari berkas `.env` server. Simpan form ini supaya pengaturan dikelola dari aplikasi; nilai di `.env` lalu tidak dipakai lagi.',
    // Tanpa kunci enkripsi form belum bisa disimpan, jadi tanpa ajakan menyimpan.
    envNoticeReadOnly: 'Pengaturan yang berlaku sekarang berasal dari berkas `.env` server.',
    noMasterKeyTitle: 'Password email belum bisa disimpan',
    noMasterKeyBody:
      'Server belum punya kunci enkripsi. Isi `BALESIN_MASTER_KEY` di berkas `.env` server (32 byte acak, base64), nyalakan ulang server, lalu kembali ke halaman ini.',
    guideTitle: 'Panduan singkat',
    guideSetupTitle: 'Lihat panduan langkah demi langkah',
    guide: (context: 'setup' | 'settings') => [
      'Pilih penyedia emailmu. Host, port, dan keamanan terisi otomatis.',
      'Isi alamat email pengirim. Kami coba tebak server SMTP dari domainnya.',
      'Masukkan password email. Untuk Gmail dan Microsoft 365, buat app password dulu.',
      'Tekan “Tes koneksi”. Bila berhasil, kirim email tes ke dirimu sendiri.',
      context === 'setup'
        ? 'Tekan “Lanjut”. Pengaturan disimpan saat setup selesai.'
        : 'Tekan “Simpan”. Undangan tim dan reset password akan dikirim dari alamat ini.',
    ],
    /**
     * Petunjuk singkat di bawah pilihan penyedia. Tidak mengulang langkah panduan; caranya
     * ada di panduan langkah demi langkah (kritikus N4).
     */
    presetHint: {
      cpanel:
        'Email dari hosting (cPanel). Host biasanya mail.<domain kamu>, port 465 dengan SSL/TLS. Pakai password akun email itu.',
      gmail:
        'Wajib memakai app password (16 karakter), bukan password akun Google. Caranya ada di panduan.',
      outlook:
        'Perlu Authenticated SMTP aktif, dan app password bila akun memakai verifikasi 2 langkah. Caranya ada di panduan.',
      other: 'Isi host, port, dan keamanan sesuai petunjuk penyedia emailmu.',
    },
    /** Langkah khusus penyedia; `link` tampil tepat di bawah langkah yang menyebut halamannya. */
    guidePreset: {
      gmail: {
        title: 'Khusus Gmail / Google Workspace',
        steps: [
          { text: 'Buka Akun Google → Keamanan, lalu aktifkan Verifikasi 2 Langkah.' },
          {
            text: 'Buka halaman Sandi aplikasi, beri nama “Balesin”, lalu tekan Buat.',
            link: {
              label: 'Buka halaman sandi aplikasi Google',
              href: 'https://myaccount.google.com/apppasswords',
            },
          },
          { text: 'Salin 16 karakter yang muncul ke isian App password (spasinya boleh ikut).' },
        ],
      },
      outlook: {
        title: 'Khusus Outlook / Microsoft 365',
        steps: [
          {
            text: 'Pastikan admin mengaktifkan Authenticated SMTP untuk kotak surat ini (Pusat admin Microsoft 365 → Pengguna → Email → Kelola aplikasi email).',
          },
          {
            text: 'Bila akun memakai verifikasi 2 langkah, buat app password di Info keamanan.',
            link: {
              label: 'Buka Info keamanan Microsoft',
              href: 'https://mysignins.microsoft.com/security-info',
            },
          },
        ],
      },
      cpanel: {
        title: 'Khusus cPanel / IDCloudHost',
        steps: [
          {
            text: 'Masuk cPanel → Email Accounts, pilih alamat pengirim, lalu tekan Connect Devices.',
          },
          {
            text: 'Salin “Outgoing Server” ke Host SMTP, dan port SMTP-nya (biasanya 465) ke Port.',
          },
          { text: 'Password = password akun email itu.' },
        ],
      },
    },
    newTab: '(membuka tab baru)',
    setUpNow: 'Atur sekarang',
    suggestionSwitch: (provider: string) =>
      `Domain ini sepertinya memakai ${provider}. Ganti ke pengaturan ini?`,
    switchSuggestion: 'Ganti',

    loadFailed: 'Pengaturan email tidak bisa dimuat',
    unsavedTest:
      'Tes memakai isian form di atas, termasuk yang belum disimpan. Status tersimpan berubah setelah kamu menyimpan lalu menguji.',
  },

  settingsMenu: {
    sectionTitle: 'Pengaturan organisasi',
    open: (name: string) => `Buka ${name}`,
  },
} as const;
