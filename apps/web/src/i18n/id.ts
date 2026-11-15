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
    close: 'Tutup',
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
    title: 'Halaman ini belum bisa dimuat',
    body: 'Biasanya karena koneksi terputus. Periksa internetmu, lalu coba lagi.',
    details: 'Detail teknis',
  },

  api: {
    network: 'Tidak bisa terhubung ke server. Periksa koneksi internetmu, lalu coba lagi.',
    /** Hitung mundur 429 sudah habis (pola semua form, kecuali halaman masuk yang punya teks sendiri). */
    unlocked: 'Sudah bisa dicoba lagi.',
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

  /** Password baru (setup, undangan, atur ulang password). */
  password: {
    strength: {
      label: 'Kekuatan password',
      empty: 'Ketik password untuk melihat kekuatannya.',
      tooShort: (missing: number) => `Kurang ${missing} karakter lagi.`,
      weak: 'Lumayan. Tambah panjang atau campur kata yang tidak umum.',
      good: 'Bagus.',
      strong: 'Kuat.',
      checking: 'Memeriksa ke server…',
      accepted: 'Siap dipakai.',
      rejected: 'Belum bisa dipakai. Pilih password lain.',
    },
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
        'Belum punya akun? Akun dibuat lewat undangan. Minta Owner atau Admin di tempatmu mengirim undangan.',
      lockedTitle: 'Masuk dikunci sementara',
      enrollmentExpiredTitle: 'Pendaftaran verifikasi dua langkah sudah ditutup',
      countdownButton: (clock: string) => `Coba lagi dalam ${clock}`,
      unlocked: 'Kamu sudah bisa mencoba masuk lagi.',
      sessionEnded: 'Sesimu sudah berakhir. Masuk lagi untuk melanjutkan.',
      loggedOut: 'Kamu sudah keluar. Sampai jumpa lagi!',
      forgot: 'Lupa password?',
      passwordReset:
        'Password sudah diganti dan semua perangkat sudah dikeluarkan. Masuk dengan password barumu.',
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
      security: 'Keamanan akun',
    },
  },

  /** Halaman dari tautan email bertoken (undangan, atur ulang password, verifikasi email). */
  links: {
    toLogin: 'Ke halaman masuk',
    lockedTitle: 'Dibatasi sementara',
    failedTitle: 'Tautan belum bisa diperiksa',
  },

  invitation: {
    documentTitle: 'Undangan',
    eyebrow: 'Undangan bergabung',
    title: (organization: string) => `Bergabung dengan ${organization}`,
    subtitle: (inviter: string, role: string, product: string) =>
      `${inviter} mengundangmu sebagai ${role} di ${product}.`,
    email: 'Email',
    emailHint: 'Dari undangan, tidak bisa diubah. Dipakai untuk masuk.',
    expires: (time: string) => `Undangan berlaku sampai ${time}.`,
    twoFactor: (role: string) =>
      `Peran ${role} wajib verifikasi dua langkah. Siapkan aplikasi autentikator di ponselmu; kamu langsung diminta mendaftarkannya setelah akun dibuat.`,
    name: 'Nama lengkap',
    nameHint: 'Tampil ke rekan setim di inbox dan tiket.',
    password: 'Password',
    repeat: 'Ulangi password',
    submit: 'Buat akun',
    submitting: 'Membuat akun…',
    signedIn: {
      title: (name: string) => `Kamu sedang masuk sebagai ${name}`,
      body: 'Menerima undangan akan mengeluarkanmu dari akun itu.',
      logout: 'Keluar dulu',
      loggingOut: 'Keluar…',
      loggedOut: 'Kamu sudah keluar dari akun sebelumnya. Lanjutkan membuat akun di bawah.',
      logoutFailed: 'Gagal keluar. Periksa koneksimu, lalu coba lagi.',
    },
    invalidTitle: 'Undangan tidak bisa dipakai',
    missing:
      'Tautan undangan ini tidak lengkap. Buka lagi tautan dari email undangan, atau minta Owner atau Admin di tempatmu mengirim undangan baru.',
  },

  forgotPassword: {
    title: 'Lupa password',
    heading: 'Atur ulang password',
    subtitle:
      'Masukkan email akunmu. Bila terdaftar, tautan untuk membuat password baru dikirim ke email itu.',
    email: 'Email',
    submit: 'Kirim tautan',
    submitting: 'Mengirim…',
    sentTitle: 'Periksa email-mu',
    sent: (email: string, minutes: number) =>
      `Kalau ${email} terdaftar, tautan atur ulang password sudah dikirim. Periksa kotak masuk dan folder spam. Tautan berlaku ${minutes} menit. Kalau ada beberapa email, pakai yang terbaru.`,
    otherEmail: 'Pakai email lain',
    unavailableTitle: 'Atur ulang password belum tersedia',
    unavailable:
      'Email pengirim di tempatmu belum diatur, jadi tautan atur ulang tidak bisa dikirim. Minta Owner atau Admin untuk membantu.',
    back: 'Kembali ke halaman masuk',
    lockedTitle: 'Permintaan dibatasi sementara',
    loadFailedTitle: 'Halaman ini belum bisa dimuat',
  },

  resetPassword: {
    title: 'Atur ulang password',
    heading: 'Buat password baru',
    subtitle: (email: string) =>
      `Untuk akun ${email}. Semua perangkat yang sedang masuk akan dikeluarkan.`,
    expires: (time: string) => `Tautan berlaku sampai ${time}.`,
    password: 'Password baru',
    repeat: 'Ulangi password baru',
    twoFactorTitle: 'Akun ini memakai verifikasi dua langkah',
    twoFactorBody:
      'Demi keamanan, password hanya bisa diganti bersama kode dari aplikasi autentikatormu.',
    code: 'Kode verifikasi',
    codeHintTotp: 'Kode di aplikasi berganti setiap 30 detik.',
    codeHintAny: '6 digit dari aplikasi autentikator, atau salah satu kode cadangan.',
    submit: 'Simpan password baru',
    submitting: 'Menyimpan…',
    invalidTitle: 'Tautan tidak bisa dipakai',
    missing:
      'Tautan atur ulang password ini tidak lengkap. Buka lagi tautan dari email, atau minta tautan baru.',
    requestNew: 'Minta tautan baru',
  },

  verifyEmail: {
    title: 'Verifikasi email',
    doneTitle: 'Email sudah terverifikasi',
    done: (email: string) =>
      `Mulai sekarang, pemberitahuan keamanan dan tautan atur ulang password dikirim ke ${email}.`,
    toApp: 'Buka aplikasi',
    invalidTitle: 'Tautan verifikasi tidak bisa dipakai',
    missing:
      'Tautan verifikasi ini tidak lengkap. Buka lagi tautan dari email, atau kirim ulang email verifikasi dari Keamanan akun.',
    toSecurity: 'Ke Keamanan akun',
  },

  /** Pengaturan → Tim (Owner & Admin). */
  team: {
    title: 'Tim',
    menuHint: 'Anggota, peran, sesi, dan undangan',
    menuStatus: (count: number) =>
      count === 0 ? 'Belum ada undangan terbuka' : `${count} undangan terbuka`,
    menuMembers: (count: number) => `${count} anggota`,
    invite: {
      title: 'Undang anggota tim',
      viaEmail:
        'Undangan dikirim ke email penerima. Mereka membuat password sendiri lewat tautan di email itu, yang berlaku 72 jam.',
      viaLink:
        'Email pengirim belum diatur, jadi tautan undangan ditampilkan untuk kamu salin dan kirim sendiri.',
      setUpEmail: 'Atur email pengirim',
      email: 'Email',
      emailPlaceholder: 'Contoh: nama@perusahaan.co.id',
      role: 'Peran',
      roleHints: {
        admin: 'Mengelola channel, pengguna, dan template. Wajib verifikasi dua langkah.',
        supervisor:
          'Memantau semua chat, membuat broadcast, dan mengelola template. Wajib verifikasi dua langkah.',
        cs: 'Membalas chat pelanggan dan mengurus tiket.',
        teknisi: 'Membalas chat yang ditugaskan kepadanya dan mengurus tiket miliknya.',
      },
      submitEmail: 'Kirim undangan',
      submitLink: 'Buat tautan undangan',
      submitting: 'Memproses…',
      lockedTitle: 'Undangan dibatasi sementara',
      /** Konfirmasi identitas sebelum undangan dibuat (semua peran, Owner juga). */
      confirmTitle: 'Kirim undangan ini?',
      confirmTitleLink: 'Buat tautan undangan ini?',
      confirmBody: (email: string, role: string) =>
        `${email} bisa membuat akun sebagai ${role} di organisasimu.`,
      sent: (email: string) => `Undangan untuk ${email} dibuat dan email-nya sedang dikirim.`,
      created: (email: string) => `Undangan untuk ${email} dibuat.`,
    },
    list: {
      title: 'Undangan terbuka',
      hint: 'Belum diterima. Kirim ulang membuat tautan baru dan membatalkan tautan lama.',
      emptyTitle: 'Belum ada undangan terbuka',
      emptyBody:
        'Undangan yang belum diterima tampil di sini, lengkap dengan status pengiriman email-nya.',
      expired: 'Kedaluwarsa',
      expiresAt: (date: string) => `berlaku sampai ${date}`,
      expiredAt: (date: string) =>
        date.startsWith('pukul')
          ? `kedaluwarsa sejak hari ini ${date}`
          : `kedaluwarsa sejak ${date}`,
      invitedBy: (name: string) => `Diundang ${name}`,
      resend: 'Kirim ulang',
      resending: 'Mengirim…',
      resendTitle: 'Kirim ulang undangan ini?',
      resendBody: (email: string) =>
        `Tautan lama untuk ${email} langsung tidak berlaku; tautan baru berlaku 72 jam.`,
      revoke: 'Batalkan',
      revokeTitle: 'Batalkan undangan?',
      revokeBody: (email: string) =>
        `Tautan undangan untuk ${email} langsung tidak berlaku. Kamu bisa mengundangnya lagi kapan saja.`,
      revokeConfirm: 'Batalkan undangan',
      keep: 'Kembali',
      revoked: (email: string) => `Undangan untuk ${email} sudah dibatalkan.`,
      resent: (email: string) =>
        `Undangan baru untuk ${email} sedang dikirim. Tautan lama sudah tidak berlaku.`,
      reissued: (email: string) =>
        `Tautan baru untuk ${email} dibuat. Tautan lama sudah tidak berlaku.`,
      managedByOwner: 'Hanya Owner yang bisa mengirim ulang atau membatalkan undangan Admin.',
      deliveryHint: {
        failed: 'Periksa Pengaturan → Email pengirim, lalu kirim ulang.',
        skipped: 'Email pengirim belum diatur saat undangan diproses. Kirim ulang.',
      },
      actionsFor: (email: string) => `Undangan untuk ${email}`,
    },
    members: {
      title: 'Anggota tim',
      hint: 'Buka anggota untuk mengubah peran, mengeluarkan sesinya, atau menonaktifkan akunnya.',
      listLabel: 'Daftar anggota tim',
      searchLabel: 'Cari anggota',
      searchPlaceholder: 'Cari nama atau email',
      searchEmpty: (query: string) => `Tidak ada anggota dengan nama atau email “${query}”.`,
      disabledGroup: (count: number) => `Nonaktif (${count})`,
      you: 'Kamu',
      lastLogin: (time: string) => `Terakhir masuk ${time}`,
      neverLoggedIn: 'Belum pernah masuk',
      sessions: (count: number) => (count === 0 ? 'Tanpa sesi aktif' : `${count} sesi aktif`),
      viewOnly: 'Hanya dilihat',
      loadFailedTitle: 'Daftar anggota belum bisa dimuat',
    },
    /** Lencana status anggota (daftar & detail). */
    badges: {
      locked: 'Terkunci sementara',
      disabled: 'Nonaktif',
      twoFactorOn: '2FA aktif',
      twoFactorOff: 'Tanpa 2FA',
      twoFactorPending: 'Belum daftar 2FA',
      twoFactorExpired: 'Batas daftar 2FA lewat',
      emailUnverified: 'Email belum diverifikasi',
    },
    linkDialog: {
      title: 'Salin tautan undangan',
      body: (email: string) =>
        `Kirim tautan ini sendiri ke ${email}. Tautan hanya ditampilkan sekarang dan berlaku 72 jam.`,
      keyTitle: 'Tautan ini setara kunci akses',
      keyBody: (role: string) =>
        `Siapa pun yang membukanya bisa membuat akun ${role} di organisasimu. Kirim langsung ke orangnya lewat chat pribadi, jangan di grup atau tempat umum.`,
      linkLabel: 'Tautan undangan',
      copy: 'Salin tautan',
      copied: 'Tersalin',
      copiedAnnouncement: 'Tautan undangan tersalin ke clipboard.',
      done: 'Selesai',
      notCopied:
        'Tautan belum disalin. Setelah dialog ini ditutup, tautan tidak bisa dilihat lagi; untuk tautan baru, kirim ulang undangannya.',
      closeAnyway: 'Tutup tanpa menyalin',
    },
  },

  /** Verifikasi dua langkah (2FA): langkah kedua saat masuk, pendaftaran, kode cadangan. */
  twoFactor: {
    login: {
      totpTitle: 'Masukkan kode verifikasi',
      totpSubtitle: (email: string) =>
        `Buka aplikasi autentikator di ponselmu, lalu masukkan 6 digit kode untuk ${email}.`,
      backupTitle: 'Masukkan kode cadangan',
      backupSubtitle: (email: string) =>
        `Pakai salah satu kode cadangan yang kamu simpan untuk ${email}. Setiap kode hanya berlaku sekali.`,
      totpLabel: 'Kode verifikasi',
      totpHint: 'Kode di aplikasi berganti setiap 30 detik.',
      backupLabel: 'Kode cadangan',
      backupHint: 'Contoh: k7m2p-x9q4r. Huruf besar-kecil dan tanda hubung tidak berpengaruh.',
      submit: 'Verifikasi',
      submitting: 'Memeriksa…',
      useBackupPrompt: 'Tidak bisa membuka aplikasi autentikator?',
      useBackup: 'Pakai kode cadangan',
      useTotpPrompt: 'Aplikasi autentikator sudah bisa dibuka?',
      useTotp: 'Pakai kode dari aplikasi',
      noBackupCodes:
        'Kode cadanganmu sudah habis. Bila aplikasi autentikator tidak bisa dibuka, minta Owner atau Admin di tempatmu mengatur ulang verifikasi dua langkahmu.',
      back: 'Kembali ke email dan password',
      expired: 'Waktu memasukkan kode sudah habis. Masukkan password-mu lagi untuk melanjutkan.',
      lockedTitle: 'Verifikasi dikunci sementara',
      unlocked: 'Kamu sudah bisa mencoba masuk lagi. Masukkan password-mu.',
      backupUsed: {
        title: 'Kamu masuk dengan kode cadangan',
        body: (remaining: number) =>
          remaining === 0
            ? 'Kode yang baru dipakai sudah tidak berlaku, dan kode cadanganmu kini habis.'
            : `Kode yang baru dipakai sudah tidak berlaku. Sisa ${remaining} kode cadangan.`,
        low: 'Buat kode cadangan baru sekarang supaya kamu tetap bisa masuk bila ponselmu hilang.',
        makeNew: 'Buat kode baru',
        later: 'Nanti saja',
        continue: 'Lanjut',
      },
    },
    enroll: {
      eyebrow: 'Satu langkah lagi',
      title: 'Aktifkan verifikasi dua langkah',
      requiredBody: (role: string) =>
        `Sebagai ${role}, kamu wajib memakai verifikasi dua langkah. Setiap kali masuk, selain password kamu juga memasukkan kode dari aplikasi di ponselmu. Jadi akunmu tetap aman walau password-nya bocor.`,
      voluntaryBody:
        'Setiap kali masuk, selain password kamu juga memasukkan kode dari aplikasi di ponselmu. Jadi akunmu tetap aman walau password-nya bocor.',
      signedInAs: (email: string) => `Masuk sebagai ${email}`,
      stepsLabel: 'Langkah mengaktifkan',
      install: {
        title: 'Pasang aplikasi autentikator',
        body: 'Misalnya Google Authenticator, Microsoft Authenticator, Authy, atau 1Password. Sudah punya? Lanjut ke langkah berikutnya.',
      },
      add: {
        title: 'Tambahkan akunmu ke aplikasi',
        bodyQr: 'Di aplikasi, pilih tambah akun, lalu pindai kode QR ini.',
        bodyHp:
          'Ketuk tombol di bawah untuk menambahkan akun langsung di aplikasi autentikator. Aplikasinya ada di perangkat lain? Pindai kode QR ini.',
        openApp: 'Buka aplikasi autentikator',
        qrLabel: 'Kode QR untuk ditambahkan ke aplikasi autentikator',
        manualTitle: 'Tidak bisa memindai? Ketik kunci ini di aplikasi',
        manualLabel: 'Kunci pengaturan',
        entryName: (issuer: string, account: string) =>
          `Tampil di aplikasi sebagai ${issuer} (${account}).`,
        copy: 'Salin kunci',
        copied: 'Tersalin',
        copiedAnnouncement: 'Kunci pengaturan tersalin ke clipboard.',
        validity: (minutes: number) => `Kode QR dan kunci ini berlaku ${minutes} menit.`,
      },
      confirm: {
        title: 'Masukkan kode dari aplikasi',
        body: 'Aplikasi langsung menampilkan kode 6 digit untuk akun ini. Masukkan kode yang sedang tampil.',
        label: 'Kode 6 digit',
        submit: 'Aktifkan',
        submitting: 'Mengaktifkan…',
        waiting: 'Isian kode muncul lagi setelah kode QR baru siap.',
      },
      preparing: 'Menyiapkan kode QR…',
      expiredTitle: 'Kode QR sudah kedaluwarsa',
      expiredBody: (minutes: number) =>
        `Demi keamanan, kode QR hanya berlaku ${minutes} menit. Buat yang baru, lalu tambahkan ulang akunmu di aplikasi (hapus dulu entri lama bila sudah sempat ditambahkan).`,
      restart: 'Buat kode QR baru',
      restarting: 'Membuat…',
      startFailedTitle: 'Kode QR belum bisa dibuat',
      /** Sama dengan halaman masuk; pesan server menjelaskan langkahnya (tanpa kalimat tambahan). */
      closedTitle: 'Pendaftaran verifikasi dua langkah sudah ditutup',
      lockedTitle: 'Pendaftaran dikunci sementara',
      password: {
        title: 'Konfirmasi password',
        body: 'Masukkan password-mu dulu untuk mulai mengaktifkan verifikasi dua langkah.',
        label: 'Password',
        submit: 'Lanjut',
        submitting: 'Memeriksa…',
      },
    },
    backupCodes: {
      eyebrow: 'Verifikasi dua langkah aktif',
      title: 'Simpan kode cadangan',
      newTitle: 'Kode cadangan baru',
      body: 'Pakai salah satu kode ini untuk masuk bila ponselmu hilang atau aplikasi autentikator tidak bisa dibuka. Setiap kode hanya berlaku sekali.',
      onlyOnce: 'Kode ini hanya ditampilkan sekarang',
      onlyOnceBody:
        'Setelah layar ini ditutup, kode tidak bisa dilihat lagi. Salin atau unduh, lalu simpan di tempat aman seperti pengelola password.',
      replacedBody:
        'Kode cadangan lama sudah tidak berlaku. Setelah layar ini ditutup, kode baru tidak bisa dilihat lagi.',
      listLabel: 'Daftar kode cadangan',
      copyAll: 'Salin semua',
      copied: 'Tersalin',
      copiedAnnouncement: 'Semua kode cadangan tersalin ke clipboard.',
      download: 'Unduh .txt',
      confirm: 'Saya sudah menyimpan kode ini di tempat yang aman',
      confirmRequired: 'Simpan kode cadangan dulu, lalu centang kotak ini.',
      leave: {
        title: 'Tinggalkan kode cadangan?',
        body: 'Kode ini hanya ditampilkan sekali. Kalau kamu pergi sekarang sebelum menyimpannya, kode tidak bisa dilihat lagi.',
        bodyRegenerated:
          'Kode ini hanya ditampilkan sekali, dan kode lama sudah tidak berlaku. Kalau kamu pergi sekarang sebelum menyimpannya, kamu harus membuat kode baru lagi.',
        stay: 'Tetap di sini',
        leave: 'Tinggalkan',
      },
      continueTo: (page: string) => `Lanjut ke ${page}`,
      done: 'Selesai',
      fileName: (product: string) => `kode-cadangan-${product}.txt`,
      file: {
        heading: (product: string) => `Kode cadangan verifikasi dua langkah ${product}`,
        account: (email: string) => `Akun: ${email}`,
        generated: (time: string) => `Dibuat: ${time}`,
        usage:
          'Setiap kode hanya bisa dipakai sekali, untuk masuk saat aplikasi autentikator tidak bisa dibuka.',
        keepSafe:
          'Simpan berkas ini di tempat aman, misalnya pengelola password. Jangan bagikan ke siapa pun.',
      },
    },
  },

  /** Pengaturan → Keamanan akun (semua peran). */
  security: {
    title: 'Keamanan akun',
    menuHint: 'Verifikasi dua langkah, kode cadangan, email, dan sesi aktif',
    sectionTitle: 'Akunmu',
    email: {
      title: 'Email akun',
      verified: 'Terverifikasi',
      unverified: 'Belum diverifikasi',
      verifiedAt: (date: string) => `Diverifikasi ${date}`,
      unverifiedBody:
        'Verifikasi membuktikan email ini benar milikmu, supaya pemberitahuan keamanan dan tautan atur ulang password sampai ke orang yang tepat.',
      send: 'Kirim email verifikasi',
      resend: 'Kirim ulang',
      sending: 'Mengirim…',
      sent: (email: string) =>
        `Email verifikasi sedang dikirim ke ${email}. Buka tautan di dalamnya dalam 24 jam.`,
      noSender:
        'Email verifikasi belum bisa dikirim karena email pengirim belum diatur. Minta Owner atau Admin di tempatmu mengaturnya.',
      noSenderCanSetUp: 'Email verifikasi belum bisa dikirim karena email pengirim belum diatur.',
      setUpSender: 'Atur email pengirim',
      lockedTitle: 'Pengiriman dibatasi sementara',
    },
    twoFactor: {
      title: 'Verifikasi dua langkah',
      body: 'Setiap kali masuk, selain password kamu juga memasukkan kode 6 digit dari aplikasi autentikator di ponselmu.',
      on: 'Aktif',
      off: 'Belum aktif',
      since: (date: string) => `Sejak ${date}`,
      required: (role: string) =>
        `Sebagai ${role}, kamu wajib memakai verifikasi dua langkah, jadi fitur ini tidak bisa dinonaktifkan. Simpan kode cadangan di tempat aman untuk berjaga-jaga bila ponselmu hilang.`,
      recommended:
        'Tidak wajib untuk peranmu, tetapi sangat disarankan: akunmu tetap aman walau password-nya bocor.',
      enable: 'Aktifkan',
      enabledNotice: 'Verifikasi dua langkah sudah aktif.',
    },
    backupCodes: {
      title: 'Kode cadangan',
      body: 'Untuk masuk saat aplikasi autentikator tidak bisa dibuka. Setiap kode berlaku sekali.',
      remaining: (count: number, total: number) => `${count} dari ${total} kode tersisa`,
      generated: (date: string) => `Dibuat ${date}`,
      emptyTitle: 'Kode cadangan sudah habis',
      lowBody:
        'Kode cadangan tinggal sedikit. Buat kode baru supaya kamu tetap bisa masuk bila ponselmu hilang.',
      regenerate: 'Buat kode baru',
      regenerateTitle: 'Buat kode cadangan baru?',
      regenerateBody: 'Semua kode cadangan lama langsung tidak berlaku.',
      regenerating: 'Membuat…',
    },
    disable: {
      action: 'Nonaktifkan',
      title: 'Nonaktifkan verifikasi dua langkah',
      dialogTitle: 'Nonaktifkan verifikasi dua langkah?',
      body: 'Setelah dinonaktifkan, akunmu hanya dilindungi password dan semua kode cadangan dihapus.',
      submitting: 'Menonaktifkan…',
      done: 'Verifikasi dua langkah sudah dinonaktifkan.',
    },
    sessions: {
      title: 'Sesi aktif',
      hint: 'Perangkat yang sedang masuk ke akunmu. Keluarkan yang tidak kamu kenali.',
      onlyThis: 'Hanya sesi ini yang aktif. Akunmu tidak sedang dibuka di perangkat lain.',
      revokeOthers: 'Keluarkan semua sesi lain',
      revokeOthersTitle: 'Keluarkan semua sesi lain?',
      revokeOthersBody:
        'Semua perangkat lain langsung keluar dari akunmu, termasuk proses masuk yang sedang menunggu kode verifikasi. Undangan yang dibuat dari sesi lain ikut dibatalkan. Sesi ini tetap berjalan.',
      revokeOthersConfirm: 'Keluarkan sesi lain',
      revokeOthersPending: 'Mengeluarkan…',
      revokedOthers: (count: number) =>
        count === 0
          ? 'Tidak ada sesi lain yang perlu dikeluarkan.'
          : `${count} sesi lain sudah dikeluarkan.`,
      loadFailedTitle: 'Sesi aktif belum bisa dimuat',
      revokeNewerTitle: (device: string) => `Keluarkan sesi ${device}?`,
      revokeNewerBody:
        'Sesi itu dibuka setelah sesi yang sedang kamu pakai. Perangkat itu langsung keluar dari akunmu.',
      revokeNewerConfirm: 'Keluarkan sesi',
    },
  },

  /** Dialog konfirmasi ulang identitas (password + kode 2FA) sebelum aksi sensitif. */
  identity: {
    password: 'Password',
    code: 'Kode verifikasi',
    codeHint: '6 digit dari aplikasi autentikator, atau salah satu kode cadangan.',
    codeRequired: 'Masukkan kode dari aplikasi autentikator atau salah satu kode cadangan.',
    why: 'Konfirmasi dulu bahwa ini memang kamu.',
    cancel: 'Batal',
    lockedTitle: 'Konfirmasi dikunci sementara',
  },

  /** Sesi aktif (daftar milik sendiri dan milik anggota lain). */
  sessions: {
    listLabel: 'Daftar sesi aktif',
    current: 'Sesi ini',
    limited: 'Pendaftaran 2FA',
    unknownIp: 'IP tidak tercatat',
    ip: (ip: string) => `IP ${ip}`,
    signedIn: (time: string) => `Masuk ${time}`,
    lastSeen: (time: string) => `Aktif ${time}`,
    revoke: 'Keluarkan',
    revoking: 'Mengeluarkan…',
    revokeLabel: (device: string) => `Keluarkan sesi ${device}`,
    revoked: (device: string) => `Sesi ${device} sudah dikeluarkan.`,
  },

  /** Pengaturan → Tim → detail anggota. */
  teamUser: {
    title: 'Detail anggota',
    notFoundTitle: 'Anggota tidak ditemukan',
    notFoundBody:
      'Mungkin alamatnya salah ketik. Anggota tidak pernah dihapus, hanya dinonaktifkan, jadi cari dari daftar Tim.',
    backToTeam: 'Lihat daftar anggota',
    loadFailedTitle: 'Data anggota belum bisa dimuat',
    facts: {
      role: 'Peran',
      joined: 'Bergabung',
      lastLogin: 'Terakhir masuk',
      never: 'Belum pernah',
      twoFactor: 'Verifikasi dua langkah',
      twoFactorSince: (date: string) => `Aktif sejak ${date}`,
      twoFactorOff: 'Belum aktif',
      twoFactorDue: (time: string) => `Belum aktif, wajib didaftarkan sebelum ${time}`,
      twoFactorExpired: 'Belum aktif, batas waktu pendaftarannya sudah lewat',
      twoFactorRequiredNoDue: 'Belum aktif, wajib didaftarkan saat masuk berikutnya',
      email: 'Email',
      emailVerified: 'Terverifikasi',
      emailUnverified:
        'Belum diverifikasi. Tautan atur ulang password tetap dikirim ke alamat ini.',
    },
    viewOnly: {
      self: 'Ini akunmu. Akun sendiri dikelola dari Keamanan akun.',
      selfLink: 'Buka Keamanan akun',
      adminLimit:
        'Admin hanya bisa mengelola Supervisor, CS, dan Teknisi. Akun Owner dan Admin dikelola Owner.',
      other: 'Kamu bisa melihat anggota ini, tetapi tidak bisa mengelolanya.',
    },
    done: {
      role: (name: string, role: string, sessions: number) =>
        sessions > 0
          ? `Peran ${name} sekarang ${role}. ${sessions} sesinya dikeluarkan, jadi ia perlu masuk lagi.`
          : `Peran ${name} sekarang ${role}.`,
      invitationsRevoked: (count: number) =>
        `${count} undangan yang ia kirim dibatalkan karena tidak lagi sesuai perannya.`,
      disabled: (name: string) =>
        `Akun ${name} sudah dinonaktifkan dan dikeluarkan dari semua perangkat.`,
      enabled: (name: string) => `Akun ${name} aktif lagi. Ia sudah bisa masuk.`,
      /** `required`: peran wajib 2FA → diminta mendaftar lagi saat masuk; selain itu opsional. */
      twoFactorReset: (name: string, required: boolean) =>
        required
          ? `Verifikasi dua langkah ${name} sudah diatur ulang. Ia perlu mendaftarkan aplikasi autentikator lagi saat masuk.`
          : `Verifikasi dua langkah ${name} sudah diatur ulang. Ia bisa masuk dengan password saja, dan mengaktifkannya lagi dari Keamanan akun bila mau.`,
      reopened: (name: string) =>
        `Pendaftaran verifikasi dua langkah ${name} dibuka lagi selama 72 jam. Minta ia masuk sekarang.`,
      unlocked: (name: string) => `Kunci akun ${name} sudah dibuka. Ia bisa mencoba masuk lagi.`,
      sessionsRevoked: (name: string, count: number) =>
        count === 0
          ? `${name} tidak punya sesi aktif.`
          : `${count} sesi ${name} sudah dikeluarkan.`,
    },
    locked: {
      title: 'Akun terkunci sementara',
      body: (time: string) =>
        `Terlalu banyak percobaan masuk atau kode yang salah. Kunci terbuka sendiri ${time}, atau buka sekarang bila kamu yakin itu memang dia.`,
      action: 'Buka kunci',
      /** Buka kunci ditolak kunci 2FA harian: kotak yang sama berganti isi (kritikus butir 6 W4). */
      dailyTitle: 'Kunci verifikasi dua langkah masih berlaku',
      dailyBody: (time: string) =>
        `Terlalu banyak kode verifikasi salah dalam 24 jam, jadi kunci ini tidak bisa dibuka dari sini. Kunci terbuka sendiri ${time}. Bila pemiliknya kehilangan aplikasi autentikator, atur ulang verifikasi dua langkahnya.`,
      dailyAction: 'Atur ulang 2FA',
      dialogTitle: 'Buka kunci akun?',
      dialogBody: (name: string) =>
        `${name} bisa langsung mencoba masuk lagi. Bila percobaan tadi bukan olehnya, atur ulang password-nya juga.`,
      confirm: 'Buka kunci',
      pending: 'Membuka…',
    },
    expired: {
      title: 'Batas waktu pendaftaran sudah lewat',
      body: (name: string) =>
        `${name} tidak bisa masuk sampai pendaftaran verifikasi dua langkahnya dibuka lagi. Setelah dibuka, ia punya 72 jam untuk mendaftar.`,
      action: 'Buka lagi pendaftaran',
      dialogTitle: 'Buka lagi pendaftaran verifikasi dua langkah?',
      dialogBody: (name: string) =>
        `${name} mendapat 72 jam baru untuk mendaftarkan aplikasi autentikator. Pastikan ia sendiri yang akan masuk.`,
      confirm: 'Buka lagi',
      pending: 'Membuka…',
    },
    disabledNotice: {
      title: 'Akun nonaktif',
      body: (time: string) =>
        `Dinonaktifkan ${time}. Ia tidak bisa masuk sampai akunnya diaktifkan lagi.`,
    },
    role: {
      title: 'Peran',
      hint: 'Menentukan apa saja yang bisa ia buka dan kerjakan.',
      label: 'Peran baru',
      submit: 'Ubah peran',
      same: 'Pilih peran yang berbeda dari peran sekarang.',
      dialogTitle: (role: string) => `Ubah peran menjadi ${role}?`,
      dialogBody: (name: string) =>
        `${name} langsung dikeluarkan dari semua perangkat dan perlu masuk lagi dengan peran barunya.`,
      dialogBody2fa: (name: string) =>
        `${name} langsung dikeluarkan dari semua perangkat. Peran baru ini wajib verifikasi dua langkah, jadi ia perlu mendaftarkannya dalam 72 jam setelah masuk.`,
      confirm: 'Ubah peran',
      pending: 'Mengubah…',
      ownerFixed: 'Peran Owner tidak bisa diubah dari sini.',
    },
    twoFactor: {
      title: 'Verifikasi dua langkah',
      hintOn: 'Atur ulang bila ponselnya hilang atau aplikasi autentikatornya terhapus.',
      hintRequired: 'Wajib untuk perannya. Ia diminta mendaftar saat masuk.',
      hintExpired: 'Wajib untuk perannya.',
      hintOptional:
        'Tidak wajib untuk perannya. Ia bisa mengaktifkannya sendiri dari Keamanan akun.',
      reset: 'Atur ulang 2FA',
      resetTitle: 'Atur ulang verifikasi dua langkah?',
      resetBody: (name: string) =>
        `Aplikasi autentikator dan kode cadangan ${name} dihapus, dan ia dikeluarkan dari semua perangkat. Ia dan Owner lain diberi tahu lewat email.`,
      resetConfirm: 'Atur ulang 2FA',
      resetPending: 'Mengatur ulang…',
    },
    sessions: {
      title: 'Sesi aktif',
      hint: (name: string) => `Perangkat tempat ${name} sedang masuk.`,
      empty: 'Tidak ada sesi aktif. Ia sedang tidak masuk di perangkat mana pun.',
      revokeAll: 'Keluarkan semua sesi',
      revokeAllTitle: 'Keluarkan semua sesinya?',
      revokeAllBody: (name: string) =>
        `${name} langsung keluar dari semua perangkat, termasuk proses masuk yang sedang menunggu kode verifikasi.`,
      revokeAllConfirm: 'Keluarkan semua',
      revokeAllPending: 'Mengeluarkan…',
      loadFailed: 'Sesi aktif belum bisa dimuat.',
    },
    access: {
      title: 'Akses akun',
      disableHint:
        'Menonaktifkan akun mengeluarkannya dari semua perangkat dan membatalkan undangan yang ia kirim. Data dan riwayatnya tetap tersimpan.',
      disable: 'Nonaktifkan akun',
      disableTitle: 'Nonaktifkan akun ini?',
      disableBody: (name: string) =>
        `${name} langsung keluar dari semua perangkat dan tidak bisa masuk. Tautan atur ulang password dan undangan yang ia kirim ikut dibatalkan.`,
      disableConfirm: 'Nonaktifkan',
      disablePending: 'Menonaktifkan…',
      enable: 'Aktifkan lagi',
      enableTitle: 'Aktifkan lagi akun ini?',
      enableBody: (name: string) =>
        `${name} bisa masuk lagi dengan password lamanya. Bila perannya wajib verifikasi dua langkah dan belum mendaftar, ia punya 72 jam untuk mendaftar.`,
      enableConfirm: 'Aktifkan',
      enablePending: 'Mengaktifkan…',
    },
    activity: {
      title: 'Riwayat aktivitas',
      hint: 'Tindakan oleh dan terhadap anggota ini, terbaru dulu.',
      empty: 'Belum ada aktivitas tercatat.',
      openAll: 'Buka di Audit log',
      loadFailed: 'Riwayat aktivitas belum bisa dimuat.',
    },
  },

  /** Pengaturan → Audit log (Owner & Admin). */
  audit: {
    title: 'Audit log',
    menuHint: 'Siapa melakukan apa, kapan, dan dari mana',
    filters: {
      label: 'Saringan audit log',
      toggle: 'Saringan',
      toggleCount: (count: number) => `Saringan (${count})`,
      actor: 'Pelaku',
      anyActor: 'Semua pelaku',
      action: 'Aksi',
      anyAction: 'Semua aksi',
      target: 'Jenis target',
      anyTarget: 'Semua target',
      from: 'Dari tanggal',
      to: 'Sampai tanggal',
      rangeError: 'Tanggal akhir tidak boleh sebelum tanggal mulai.',
      /** Di luar panel saringan (di HP panelnya bisa tertutup); juga menjelaskan ekspor yang ditahan. */
      rangeSummary:
        'Rentang tanggal terbalik, jadi saringan tanggal belum dipakai dan ekspor CSV ditahan. Perbaiki tanggalnya di Saringan.',
      clear: 'Hapus saringan',
      chipUser: (name: string) => `Terkait ${name}`,
      chipTarget: (id: string) => `Target ${id}`,
      removeChip: (label: string) => `Hapus saringan ${label}`,
    },
    columns: {
      time: 'Waktu',
      action: 'Aksi',
      actor: 'Pelaku',
      target: 'Target',
      origin: 'Asal',
    },
    listLabel: 'Entri audit log',
    system: 'Sistem',
    unknownTarget: '—',
    noOrigin: 'Tidak tercatat',
    details: 'Rincian',
    yes: 'Ya',
    no: 'Tidak',
    emptyValue: '—',
    loadMore: 'Muat lagi',
    loadingMore: 'Memuat…',
    shown: (count: number) => `${count} entri ditampilkan`,
    end: 'Sudah semua entri yang cocok.',
    emptyTitle: 'Belum ada aktivitas tercatat',
    emptyBody: 'Masuk, perubahan pengaturan, dan pengelolaan tim tercatat di sini.',
    noMatchTitle: 'Tidak ada entri yang cocok',
    noMatchBody: 'Coba longgarkan saringan atau perluas rentang tanggalnya.',
    loadFailedTitle: 'Audit log belum bisa dimuat',
    lockedTitle: 'Audit log dibatasi sementara',
    export: 'Ekspor CSV',
    exporting: 'Mengekspor…',
    exported: (rows: number) =>
      rows === 0
        ? 'Berkas CSV diunduh, tetapi tidak ada entri yang cocok dengan saringan.'
        : `Berkas CSV berisi ${rows.toLocaleString('id-ID')} entri sudah diunduh.`,
    exportTruncated: (max: number) =>
      `Hanya ${max.toLocaleString('id-ID')} entri terbaru yang ikut. Persempit rentang tanggal untuk mengekspor sisanya.`,
    exportLockedTitle: 'Ekspor dibatasi sementara',
    exportFailedTitle: 'Ekspor gagal',
    fileName: (product: string, date: string) => `audit-log-${product}-${date}.csv`,
    /** Label kunci rincian yang dikenal; kunci lain tampil apa adanya. */
    metadata: {
      from: 'Dari',
      to: 'Menjadi',
      reason: 'Alasan',
      scope: 'Cakupan',
      lockedUntil: 'Terkunci sampai',
      revokedSessions: 'Sesi dikeluarkan',
      revokedInvitations: 'Undangan dibatalkan',
      twoFactorEnrollmentRequired: 'Wajib daftar 2FA',
      twoFactorEnrollmentPending: 'Belum daftar 2FA',
      previousHost: 'Server sebelumnya',
      host: 'Server',
      port: 'Port',
      fromAddress: 'Alamat pengirim',
      ownersNotified: 'Owner diberi tahu',
      permission: 'Izin',
      method: 'Metode',
      role: 'Peran',
      email: 'Email',
      by: 'Oleh',
      rows: 'Jumlah baris',
      truncated: 'Terpotong',
      cleared: 'Kunci dilepas',
    } as Readonly<Record<string, string>>,
  },

  /** Banner peringatan keamanan untuk Owner/Admin (ringkasan 7 hari). */
  securityBanner: {
    label: 'Peringatan keamanan',
    title: (count: number) =>
      count === 1 ? 'Ada 1 kejadian keamanan baru' : `Ada ${count} kejadian keamanan baru`,
    /** Satu kalimat: "Terbaru: Email pengirim diubah oleh Agus Pratama (Admin), hari ini, 19.25." */
    latest: (label: string, time: string, actor?: { name: string; role: string }) =>
      actor
        ? `Terbaru: ${label} oleh ${actor.name} (${actor.role}), ${time}.`
        : `Terbaru: ${label}, ${time}.`,
    /** `member_joined`: pelakunya anggota baru itu sendiri, jadi bukan "… oleh …". */
    latestJoined: (name: string, role: string, time: string) =>
      `Terbaru: ${name} (${role}) bergabung lewat undangan, ${time}.`,
    review: 'Periksa di Audit log',
    dismiss: 'Tutup peringatan keamanan',
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
    intro:
      'Siapkan aplikasi untuk tim di tempatmu. Butuh sekitar 5 menit; email pengirim bisa diisi nanti.',
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
        body: 'Nama ini tampil di halaman masuk dan di email untuk tim di tempatmu.',
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
        body: 'Dipakai untuk mengirim undangan tim dan tautan atur ulang password. Boleh dilewati dan diisi nanti di Pengaturan → Email pengirim.',
        skipNote:
          'Tanpa email pengirim, undangan tim dan tautan atur ulang password belum bisa dikirim.',
        skipped: 'Dilewati. Bisa diisi nanti di Pengaturan.',
        noMasterKeyTitle: 'Email pengirim belum bisa disimpan',
        noMasterKeyBody:
          'Server belum punya kunci enkripsi (`BALESIN_MASTER_KEY` di berkas `.env`), jadi password email tidak bisa disimpan dengan aman. Lewati langkah ini dulu; setelah kunci diisi dan server dinyalakan ulang, atur email di Pengaturan.',
      },
      summary: {
        nav: 'Ringkasan',
        title: 'Periksa lalu selesaikan',
        body: 'Pastikan semuanya sudah benar. Setelah selesai, kamu langsung mengaktifkan verifikasi dua langkah untuk akun Owner, lalu masuk ke Inbox.',
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
      failedTitle: 'Status setup belum bisa dimuat',
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
    // Sepanjang teks lama: lebih panjang membuat baris menu patah saat statusnya dimuat (CLS).
    menuHint: 'Untuk undangan, atur ulang password, dan notifikasi',
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
      `Tidak ada saran untuk ${domain}. Isi host dan port sesuai petunjuk penyedia email-mu.`,
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
      'Pilih penyedia email-mu. Host, port, dan keamanan terisi otomatis.',
      'Isi alamat email pengirim. Server SMTP ditebak otomatis dari domainnya.',
      'Masukkan password email. Untuk Gmail dan Microsoft 365, buat app password dulu.',
      'Tekan “Tes koneksi”. Bila berhasil, kirim email tes ke dirimu sendiri.',
      context === 'setup'
        ? 'Tekan “Lanjut”. Pengaturan disimpan saat setup selesai.'
        : 'Tekan “Simpan”. Undangan tim dan tautan atur ulang password akan dikirim dari alamat ini.',
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
        'Perlu Authenticated SMTP aktif, dan app password bila akun memakai verifikasi dua langkah. Caranya ada di panduan.',
      other: 'Isi host, port, dan keamanan sesuai petunjuk penyedia email-mu.',
    },
    /** Langkah khusus penyedia; `link` tampil tepat di bawah langkah yang menyebut halamannya. */
    guidePreset: {
      gmail: {
        title: 'Khusus Gmail / Google Workspace',
        steps: [
          { text: 'Buka Akun Google → Keamanan, lalu aktifkan Verifikasi 2 Langkah.' },
          {
            // Nama produk dari branding (white-label), bukan ditulis langsung.
            text: (product: string) =>
              `Buka halaman Sandi aplikasi, beri nama “${product}”, lalu tekan Buat.`,
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
            text: 'Bila akun memakai verifikasi dua langkah, buat app password di Info keamanan.',
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

    loadFailed: 'Pengaturan email belum bisa dimuat',
    /** Konfirmasi identitas saat jalur kirim berubah / simpan pertama kali (semua peran). */
    confirmTitle: 'Simpan email pengirim?',
    confirmBody:
      'Undangan tim dan tautan atur ulang password akan dikirim lewat pengaturan ini. Semua Owner diberi tahu lewat email.',
    preview: {
      title: 'Pratinjau email',
      body: 'Contoh email yang dikirim ke tim di tempatmu, memakai nama aplikasi dan logo organisasimu. Isi dan tautannya hanya contoh.',
      template: 'Template',
      subject: 'Subjek',
      viewLabel: 'Tampilan pratinjau',
      html: 'Email',
      text: 'Teks polos',
      frameTitle: (label: string) => `Pratinjau email: ${label}`,
      loadFailedTitle: 'Pratinjau belum bisa dimuat',
    },
    /** Admin (bukan Owner) mengubah email pengirim: server memberi tahu semua Owner. */
    ownersNotified: 'Owner akan diberi tahu lewat email bila server atau alamat pengirim diubah.',
    unsavedTest:
      'Tes memakai isian form di atas, termasuk yang belum disimpan. Status tersimpan berubah setelah kamu menyimpan lalu menguji.',
  },

  settingsMenu: {
    sectionTitle: 'Pengaturan organisasi',
    open: (name: string) => `Buka ${name}`,
  },
} as const;
