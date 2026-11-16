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
      /** Inbox benar-benar kosong (desktop): ajakan lengkap ada di ruang chat. */
      listHint: 'Chat baru muncul di daftar ini.',
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
    /** Kata pencarian baru 1 huruf: daftar tetap tampil apa adanya. */
    searchTooShort: 'Ketik minimal 2 huruf untuk mulai mencari.',
    searchLimited: 'Pencarian dibatasi sementara',
    searchSlowTitle: 'Pencarian terlalu lama',
    searchSlowBody: 'Persempit kata kuncinya, lalu cari lagi.',
    searchAgain: 'Cari lagi',
    filteredEmpty: {
      title: 'Tidak ada chat yang cocok',
      body: 'Coba longgarkan saringannya.',
    },
    failed: {
      title: 'Daftar chat belum bisa dimuat',
    },
    /** Hitungan per tab: lebih dari 99 ditulis "99+". */
    tabCount: (count: number) => (count > 99 ? '99+' : String(count)),
    tabCountLabel: (count: number) => `${count} chat`,
    loadingMore: 'Memuat chat berikutnya…',
    loadMore: 'Muat chat berikutnya',
    rowsHint: 'Pakai panah atas dan bawah untuk berpindah chat.',
    loadMoreFailed: 'Chat berikutnya belum bisa dimuat.',
    endOfList: 'Sudah semua chat.',
    filters: {
      open: 'Saring chat',
      openWithCount: (count: number) => `Saring chat, ${count} saringan aktif`,
      title: 'Saring chat',
      channel: 'Channel',
      allChannels: 'Semua channel',
      assignee: 'Agen',
      anyAssignee: 'Semua agen',
      me: 'Ditangani saya',
      unassigned: 'Belum ada agen',
      window: 'Sesi 24 jam',
      anyWindow: 'Semua sesi',
      /** "Broadcast" (label PRD) membingungkan di grup "Sesi 24 jam": pelanggan belum pernah membalas. */
      windowLabels: {
        open: 'Terbuka',
        expiring: 'Hampir habis',
        expired: 'Kedaluwarsa',
        none: 'Belum pernah membalas',
      },
      unreadOnly: 'Hanya yang belum dibaca',
      clearAll: 'Hapus semua saringan',
      activeLabel: 'Saringan aktif',
      remove: (label: string) => `Hapus saringan ${label}`,
      chipChannel: (name: string) => `Channel: ${name}`,
      chipTag: (name: string) => `Tag: ${name}`,
      tag: 'Tag kontak',
      anyTag: 'Semua tag',
      unknownTag: 'Tag lain',
      chipAssignee: (name: string) => `Agen: ${name}`,
      chipUnread: 'Belum dibaca',
      unknownChannel: 'Channel lain',
      unknownAgent: 'Agen lain',
    },
    item: {
      fromWhatsApp: 'dari WhatsApp',
      fromWhatsAppHint: 'Nama dari profil WhatsApp pelanggan, belum diberi nama oleh tim',
      unread: (count: number) => `${count} pesan belum dibaca`,
      unreadShort: (count: number) => (count > 99 ? '99+' : String(count)),
      assignee: (name: string) => `Ditangani ${name}`,
      unassigned: 'Belum ada agen',
      noMessage: 'Belum ada pesan',
      outbound: 'Kamu: ',
      status: {
        bot: 'Bot',
        unserved: 'Belum dilayani',
        served: 'Dilayani',
        resolved: 'Selesai',
      },
    },
    /** Jendela layanan 24 jam WhatsApp (sesi). */
    window: {
      remainingShort: (text: string) => text,
      expiredShort: 'Sesi habis',
      remainingLong: (text: string) => `Sesi WhatsApp tersisa ${text}`,
      expiredLong: 'Sesi WhatsApp sudah habis. Hanya pesan template yang bisa dikirim.',
      noneLong: 'Pelanggan belum pernah mengirim pesan, jadi belum ada sesi WhatsApp.',
      endsAt: (time: string) => `Berakhir ${time}`,
      hours: (h: number) => `${h} jam`,
      hoursMinutes: (h: number, m: number) => `${h} jam ${m} mnt`,
      minutes: (m: number) => `${m} mnt`,
      underMinute: '< 1 mnt',
      hoursLong: (h: number) => `${h} jam`,
      hoursMinutesLong: (h: number, m: number) => `${h} jam ${m} menit`,
      minutesLong: (m: number) => `${m} menit`,
      underMinuteLong: 'kurang dari 1 menit',
    },
    time: {
      yesterday: 'Kemarin',
      today: 'Hari ini',
    },
    chat: {
      label: 'Ruang chat',
      emptyTitle: 'Pilih chat untuk mulai membaca',
      emptyBody: 'Riwayat pesan pelanggan tampil di sini begitu kamu memilih chat dari daftar.',
      inboxEmptyTitle: 'Inbox masih kosong',
      inboxEmptyBody: (mascot: string) =>
        `Tenang, ${mascot} jaga inbox-nya. Chat pelanggan muncul di sini begitu ada yang masuk.`,
      connectChannel: 'Sambungkan nomor WhatsApp',
      back: 'Kembali ke daftar chat',
      openDetail: (name: string) => `Lihat detail ${name}`,
      history: 'Riwayat pesan',
      loadingOlder: 'Memuat pesan sebelumnya…',
      loadOlder: 'Muat pesan sebelumnya',
      olderFailed: 'Pesan sebelumnya belum bisa dimuat.',
      start: 'Awal percakapan',
      jumpToLatest: 'Ke pesan terbaru',
      newMessages: 'Ada pesan baru',
      failedTitle: 'Chat ini belum bisa dimuat',
      notFoundTitle: 'Chat tidak ditemukan',
      notFoundBody:
        'Mungkin chat ini sudah dialihkan ke agen lain atau dihapus. Pilih chat lain dari daftar.',
      messagesFailedTitle: 'Pesan belum bisa dimuat',
      noMessages: 'Belum ada pesan di chat ini.',
      senders: {
        customer: 'Pelanggan',
        agent: 'Tim',
        bot: 'Bot',
        broadcast: 'Broadcast',
        system: 'Sistem',
      },
      deliveryStatus: {
        pending: 'Mengirim',
        sent: 'Terkirim',
        delivered: 'Diterima',
        read: 'Dibaca',
        played: 'Diputar',
        failed: 'Gagal terkirim',
      },
      failedCode: (code: number) => `Gagal terkirim (kode ${code})`,
      forwarded: 'Diteruskan',
      replyTo: 'Membalas pesan',
      replyToUnknown: 'Membalas pesan sebelumnya',
      reaction: (emoji: string) => `Reaksi ${emoji}`,
      reactionRemoved: 'Reaksi dihapus',
      reactionToOlder: (emoji: string) => `Memberi reaksi ${emoji} ke pesan sebelumnya`,
      referral: 'Dari iklan',
      referralLink: (host: string) => `Tautan iklan: ${host}`,
      sentAt: (time: string) => `pukul ${time}`,
    },
    /** Composer (butir 6): kirim teks, lampiran, balas-kutip. */
    compose: {
      label: 'Tulis balasan',
      placeholder: 'Tulis pesan…',
      captionPlaceholder: 'Tambahkan keterangan (opsional)…',
      send: 'Kirim',
      sending: 'Mengirim…',
      attach: 'Lampirkan berkas',
      removeAttachment: 'Batalkan lampiran',
      cancelReply: 'Batal membalas',
      replyingTo: (who: string) => `Membalas ${who}`,
      enterHint: 'Enter untuk kirim, Shift+Enter untuk baris baru.',
      tooLong: (count: number) => `${count.toLocaleString('id-ID')} / 4.096`,
      fileTooLarge: (limit: string) => `Berkas terlalu besar. Batasnya ${limit} untuk jenis ini.`,
      fileUnsupported:
        'Jenis berkas ini tidak bisa dikirim. Pakai gambar JPG/PNG, video MP4, audio, PDF, atau dokumen Office.',
      limitedTitle: 'Pengiriman dibatasi sementara',
      failedTitle: 'Pesan belum terkirim',
      uploading: 'Mengunggah…',
      notSent: 'Belum terkirim',
      resend: 'Kirim ulang',
      discard: 'Hapus',
      readOnly: 'Kamu hanya bisa membaca chat ini.',
      resolved: 'Chat ini sudah selesai. Pesan baru dari pelanggan akan membuka chat baru.',
      windowClosedTitle: 'Sesi 24 jam sudah habis',
      windowClosedBody:
        'Pesan biasa hanya bisa dikirim dalam 24 jam sejak pesan terakhir pelanggan. Tunggu pelanggan membalas.',
      windowNoneTitle: 'Pelanggan belum pernah membalas',
      windowNoneBody: 'Pesan biasa baru bisa dikirim setelah pelanggan mengirim pesan.',
      pausedTitle: 'Pengiriman sedang dihentikan',
      pausedBody:
        'Rem darurat sedang ditarik, jadi pesan baru tidak dikirim. Owner atau Admin di tempatmu bisa melanjutkan pengiriman setelah keadaannya aman.',
      pausedReason: (reason: string) => `Alasan: ${reason}`,
      pausedManage: 'Buka Batas kirim',
      unassigned: 'Belum ada yang menangani. Ambil supaya tim tahu kamu yang membalas.',
      handledBy: (name: string) => `Ditangani ${name}`,
      pausedPlaceholder: 'Pengiriman sedang dihentikan — tulis draf dulu…',
      withBot: 'Chat ini sedang dipegang bot.',
      claim: 'Ambil chat',
      takeOver: 'Ambil alih',
      claiming: 'Mengambil…',
      claimFailedTitle: 'Chat belum bisa diambil',
    },
    /** Media pesan (unduh lewat fetch → Blob). */
    media: {
      loadVideo: 'Putar video',
      loadAudio: 'Putar audio',
      download: 'Unduh',
      downloading: 'Mengunduh…',
      loading: 'Memuat berkas…',
      failed: 'Berkas belum bisa dimuat.',
      gone: 'Berkas sudah tidak tersedia.',
      busy: 'Terlalu banyak unduhan berjalan. Coba lagi sebentar lagi.',
      retry: 'Muat ulang',
      imageAlt: (caption: string | null) => (caption ? `Gambar: ${caption}` : 'Gambar dari chat'),
      stickerAlt: 'Stiker',
    },
    /** Balasan cepat `/` di composer. */
    quickReplies: {
      title: 'Balasan cepat',
      empty: 'Belum ada balasan cepat.',
      notFound: (search: string) => `Tidak ada balasan cepat untuk “/${search}”.`,
      failed: 'Balasan cepat belum bisa dimuat. Hapus "/" lalu ketik lagi.',
      manage: 'Kelola balasan cepat',
      keysHint: '↑ ↓ pilih · Enter pakai · Esc tutup',
      using: 'Memasukkan balasan cepat…',
    },
    /** Panel detail (butir 8): tab, tag, ubah kontak, catatan sesi, berkas, log. */
    panel: {
      tabsLabel: 'Bagian detail',
      tabs: { info: 'Info', notes: 'Catatan', files: 'Berkas', log: 'Log' },
      tags: 'Tag',
      noTags: 'Belum ada tag.',
      addTag: 'Tambah tag',
      removeTag: (name: string) => `Lepas tag ${name}`,
      tagSearch: 'Cari atau buat tag',
      tagCreate: (name: string) => `Buat tag “${name}”`,
      tagNone: 'Belum ada tag di organisasi ini.',
      tagFailed: 'Tag belum bisa diubah.',
      editContact: 'Ubah kontak',
      email: 'Email',
      notes: 'Catatan kontak',
      attributes: 'Atribut',
      noAttributes: 'Belum ada atribut.',
      contactEditTitle: 'Ubah kontak',
      teamNameHint: 'Kosongkan untuk memakai nama profil WhatsApp.',
      useWhatsAppName: 'Pakai nama WhatsApp',
      notesHint: 'Catatan tentang pelanggan ini, terlihat di semua chat-nya.',
      attributeKey: 'Nama atribut',
      attributeValue: 'Nilai',
      addAttribute: 'Tambah atribut',
      removeAttribute: (key: string) => `Hapus atribut ${key || 'ini'}`,
      save: 'Simpan',
      saving: 'Menyimpan…',
      cancel: 'Batal',
      saved: 'Kontak disimpan.',
      sessionNotes: 'Catatan sesi',
      sessionNotesHint: 'Catatan internal untuk tim. Tidak pernah terkirim ke pelanggan.',
      notePlaceholder: 'Tulis catatan internal…',
      addNote: 'Simpan catatan',
      noNotes: 'Belum ada catatan di chat ini.',
      edited: 'diubah',
      editNote: 'Ubah catatan',
      deleteNote: 'Hapus catatan',
      deleteNoteTitle: 'Hapus catatan ini?',
      deleteNoteBody:
        'Catatan dihapus untuk semua anggota tim. Log tetap mencatat bahwa ada catatan yang dihapus.',
      deleteNoteConfirm: 'Hapus catatan',
      notesFailed: 'Catatan belum bisa dimuat.',
      media: 'Media',
      files: 'File',
      starred: 'Ditandai',
      filesLabel: 'Jenis berkas',
      noMedia: 'Belum ada gambar atau video di chat ini.',
      noFiles: 'Belum ada dokumen atau audio di chat ini.',
      noStarred: 'Belum ada pesan yang ditandai. Tandai lewat menu aksi pesan.',
      filesFailed: 'Berkas belum bisa dimuat.',
      loadMore: 'Muat lagi',
      logFailed: 'Log belum bisa dimuat.',
      noLog: 'Belum ada catatan kejadian.',
      system: 'Sistem',
      logAssignee: (name: string) => `ke ${name}`,
      logFrom: (name: string) => `dari ${name}`,
      logFields: (fields: string) => `(${fields})`,
      privacy: 'Data pribadi',
      privacyHint: 'Untuk permintaan akses atau penghapusan data dari pelanggan (UU PDP).',
      exportContact: 'Ekspor data kontak',
      exporting: 'Menyiapkan…',
      exported: 'Data kontak diunduh (JSON).',
      deleteContact: 'Hapus kontak',
      deleteContactTitle: 'Hapus kontak ini beserta datanya?',
      deleteContactBody:
        'Semua chat, pesan, catatan, dan berkas kontak ini dihapus permanen untuk seluruh tim. Tindakan ini tidak bisa dibatalkan.',
      deleteContactConfirm: 'Hapus permanen',
      deletingContact: 'Menghapus…',
    },
    /** Penanganan percakapan (butir 7). */
    handling: {
      menu: 'Tindakan chat',
      resolve: 'Tandai selesai',
      reopen: 'Buka lagi',
      assign: 'Tugaskan ke agen…',
      reassign: 'Alihkan ke agen lain…',
      unassign: 'Kembalikan ke antrian',
      nothing: 'Tidak ada tindakan lain',
      working: 'Memproses…',
      cancel: 'Batal',
      assignTitle: 'Tugaskan chat ini',
      reassignTitle: 'Alihkan chat ini',
      assignBody: 'Pilih agen yang akan menangani chat ini.',
      currentAssignee: (name: string) => `Sekarang ditangani ${name}. Pilih agen penggantinya.`,
      agentsLabel: 'Agen',
      assignConfirm: 'Tugaskan',
      load: (count: number) => (count === 0 ? 'Belum pegang chat' : `${count} chat terbuka`),
      noAgents: 'Belum ada agen lain yang bisa ditugaskan.',
      agentsFailed: 'Daftar agen belum bisa dimuat. Tutup lalu coba lagi.',
      failedTitle: 'Tindakan belum berhasil',
    },
    /** Aksi per pesan: balas & reaksi. */
    actions: {
      open: 'Aksi pesan',
      openAt: (time: string) => `Aksi untuk pesan pukul ${time}`,
      reply: 'Balas',
      react: 'Beri reaksi',
      reactWith: (emoji: string) => `Reaksi ${emoji}`,
      removeReaction: 'Hapus reaksimu',
      star: 'Tandai pesan',
      unstar: 'Lepas tanda',
      starred: 'Ditandai',
      you: 'Kamu',
      customer: 'pelanggan',
    },
    /** Label isi pesan selain teks. Isi dari pelanggan (nama berkas, alamat) tetap teks biasa. */
    content: {
      image: 'Gambar',
      video: 'Video',
      audio: 'Audio',
      voice: 'Pesan suara',
      document: 'Dokumen',
      documentNamed: (filename: string) => `Dokumen: ${filename}`,
      sticker: 'Stiker',
      animatedSticker: 'Stiker bergerak',
      location: 'Lokasi',
      contacts: (count: number) =>
        count > 1 ? `${count} kartu kontak` : count === 1 ? 'Kartu kontak' : 'Kartu kontak',
      interactive: 'Balasan tombol',
      listReply: 'Pilihan dari daftar',
      flowReply: 'Jawaban formulir',
      reaction: 'Reaksi',
      system: 'Pemberitahuan sistem',
      unsupported: 'Jenis pesan ini belum bisa ditampilkan',
      unsupportedKinds: {
        order: 'Pesanan dari katalog',
        ephemeral: 'Pesan sementara',
        poll: 'Polling',
        event: 'Undangan acara',
        request_welcome: 'Pelanggan membuka chat pertama kali',
        group_invite: 'Undangan grup',
        product: 'Produk dari katalog',
      },
      coordinates: (lat: string, lng: string) => `${lat}, ${lng}`,
    },
    detail: {
      label: 'Detail kontak',
      title: 'Detail',
      show: 'Tampilkan detail',
      hide: 'Sembunyikan detail',
      backToChat: 'Kembali ke chat',
      emptyBody:
        'Info kontak, agen yang menangani, tag, dan catatan tampil di sini saat chat dibuka.',
      conversation: 'Percakapan',
      contact: 'Kontak',
      status: 'Status',
      assignee: 'Ditangani',
      channel: 'Channel',
      window: 'Sesi WhatsApp',
      startedAt: 'Dimulai',
      phone: 'Nomor',
      username: 'Username WhatsApp',
      profileName: 'Nama profil WhatsApp',
      teamName: 'Nama di tim',
      notSet: 'Belum diisi',
      createdAt: 'Tercatat sejak',
      failed: 'Detail kontak belum bisa dimuat.',
      unavailable: 'Detail chat ini tidak tersedia lagi untukmu.',
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
    /** Kejadian tanpa pelaku pada satu channel (mis. webhook ditolak berulang). */
    onChannel: (label: string, channel: string) => `${label} di channel ${channel}`,
    review: 'Periksa di Audit log',
    reviewChannel: 'Periksa channel',
    reviewSending: 'Buka Batas kirim',
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
      body: 'Contoh email yang dikirim ke timmu, memakai nama aplikasi dan logo organisasimu. Isi dan tautannya hanya contoh.',
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

  /**
   * Pengaturan → Channel: daftar nomor, wizard tambah nomor (docs/SETUP-META.md), halaman nomor,
   * dan profil bisnis. "WhatsApp" di sini nama layanan/channel Meta, bukan nama produk.
   */
  channels: {
    title: 'Channel',
    // Pendek: status di kanan tidak boleh membuat petunjuk patah baris saat dimuat (CLS).
    menuHint: 'Nomor WhatsApp untuk inbox',
    menuCount: (count: number) => `${count} nomor`,
    /** "1 koneksi gagal", "2 belum dites": hanya sebagian channel aktif yang berstatus itu. */
    menuWorst: (count: number, label: string) => `${count} ${label.toLocaleLowerCase('id-ID')}`,
    /** Sama dengan pola Email pengirim ("Belum diatur · Atur sekarang"). */
    menuNone: 'Belum diatur',
    connectNow: 'Hubungkan',
    disabled: 'Nonaktif',
    newTab: '(membuka tab baru)',
    ownersNotified: 'Owner akan diberi tahu lewat email tentang perubahan ini.',

    list: {
      sectionTitle: 'WhatsApp',
      sectionHint: 'Lewat WhatsApp Cloud API resmi Meta. Satu channel untuk satu nomor.',
      listLabel: 'Daftar nomor WhatsApp',
      add: 'Tambah nomor',
      noNumber: 'Nomor belum diketahui',
      noNumberHint: 'Tes koneksi untuk mengambil data nomor dari Meta.',
      quality: (label: string) => `Kualitas ${label}`,
      emptyTitle: 'Belum ada nomor WhatsApp',
      emptyBody:
        'Hubungkan nomor WhatsApp Business lewat Cloud API resmi Meta, supaya chat pelanggan masuk ke inbox timmu.',
      emptyAction: 'Hubungkan nomor pertama',
      loadFailedTitle: 'Channel belum bisa dimuat',
      limitTitle: 'Batas nomor sudah tercapai',
      limitBody: (max: number) =>
        `Satu organisasi bisa memakai paling banyak ${max} nomor. Hapus nomor yang tidak dipakai lagi untuk menambah yang baru.`,
      noMasterKeyTitle: 'Token Meta belum bisa disimpan',
      noMasterKeyBody:
        '`BALESIN_MASTER_KEY` belum diisi di berkas `.env` server, jadi token dan App Secret tidak bisa disimpan terenkripsi. Isi dengan 32 byte acak (base64) dari perintah di bawah, nyalakan ulang server, lalu kembali ke halaman ini.',
      masterKeyCommand: 'openssl rand -base64 32',
      copyCommand: 'Salin perintah',
      copiedCommand: 'Perintah tersalin.',
      deleted: (name: string) =>
        `Channel ${name} sudah dihapus. Cabut juga webhook-nya di Meta (WhatsApp → Konfigurasi → Webhook).`,
    },

    /** Ringkasan nomor (kartu daftar, langkah Tes di wizard, halaman nomor). */
    number: {
      quality: 'Kualitas',
      status: 'Status di Meta',
      limit: 'Batas pesan',
      verifiedName: 'Nama tampilan',
      lastTest: 'Tes terakhir',
      neverTested: 'Belum pernah dites',
      /** Fakta di atas bisa basi bila tes terakhir gagal: sebut kapan dibaca. */
      fetchedAt: (time: string) => `Data dari Meta, dibaca ${time}.`,
      nameStatus: (label: string) => `Persetujuan nama: ${label}`,
    },

    test: {
      action: 'Tes koneksi',
      pending: 'Menguji…',
      pendingNote: 'Menghubungi Meta. Paling lama sekitar 25 detik.',
      lockedTitle: 'Tes koneksi dibatasi sementara',
      failedTitle: 'Koneksi gagal',
      warningsTitle: 'Perlu dibereskan di Meta',
    },

    webhook: {
      title: 'Webhook',
      hint: 'Meta mengirim pesan pelanggan ke alamat ini. Di WhatsApp → Konfigurasi → Webhook → Edit, tempel URL webhook ke Callback URL dan verify token ke Verify token, lalu tekan Verifikasi dan simpan.',
      callbackUrl: 'URL webhook',
      verifyToken: 'Verify token',
      copy: 'Salin',
      copied: 'Tersalin',
      copyUrlLabel: 'Salin URL webhook',
      copyTokenLabel: 'Salin verify token',
      copiedUrl: 'URL webhook tersalin.',
      copiedToken: 'Verify token tersalin.',
      fieldsTitle: 'Kolom webhook yang perlu dilanggani',
      fieldsHint:
        'Setelah verifikasi, klik Berlangganan pada ketiga kolom ini di daftar Kolom webhook.',
      notes: [
        {
          title: 'Beberapa nomor dalam satu aplikasi Meta',
          body: 'Meta hanya punya satu Callback URL per aplikasi. Pakai App Secret yang sama di semua channel nomor itu; pesan tetap diarahkan ke channel yang benar. Nomor dari aplikasi Meta lain memakai URL-nya sendiri.',
        },
        {
          title: 'Verifikasi berhasil, tetapi pesan tidak masuk?',
          body: 'Biasanya App Secret di sini tidak sama dengan milik aplikasi Meta, dan banner keamanan menampilkan “Webhook WhatsApp ditolak berulang”.',
        },
      ],
      /** Kalimat penutup catatan App Secret: di wizard menunjuk halaman nomor, di halaman nomor kartunya. */
      fixAppSecret: {
        wizard: 'Ganti App Secret di Kredensial Meta pada halaman nomor.',
        detail: 'Ganti App Secret di kartu Kredensial Meta di bawah.',
      },
      warningTitle: 'URL ini belum bisa dipakai Meta',
      proofTitle: 'Aktifkan juga “Require App Secret Proof”',
      proofBody: (product: string) =>
        `Di Pengaturan Aplikasi → Lanjutan. ${product} selalu mengirim appsecret_proof, jadi token yang bocor tidak bisa dipakai tanpa App Secret.`,
      rotatedAt: (time: string) => `Dibuat ${time}`,
      loadFailedTitle: 'Webhook belum bisa dimuat',
      rotate: 'Buat ulang verify token',
      rotating: 'Membuat…',
      rotateTitle: 'Buat ulang verify token?',
      rotateBody:
        'Verify token lama langsung tidak berlaku. Setelah ini, tempel verify token baru di Meta (WhatsApp → Konfigurasi → Webhook → Edit).',
      rotateConfirm: 'Buat ulang',
      rotateCancel: 'Batal',
      rotated:
        'Verify token baru sudah dibuat. Tempel di Meta (WhatsApp → Konfigurasi → Webhook → Edit), lalu tekan Verifikasi dan simpan.',
    },

    /** Diagnosis webhook 24 jam (hanya hitungan, tanpa isi pesan). */
    webhookHealth: {
      title: 'Diagnosis 24 jam terakhir',
      recheck: 'Periksa lagi',
      checking: 'Memeriksa…',
      failedTitle: 'Diagnosis belum bisa dimuat',
      okTitle: 'Webhook menerima data',
      okBody: 'Meta mengirim data ke channel ini dan semuanya sudah diproses.',
      idleTitle: 'Belum ada data masuk 24 jam terakhir',
      idleBody:
        'Kalau seharusnya ada pesan pelanggan, pastikan webhook sudah diverifikasi dan kolom messages sudah dilanggani di Meta.',
      attentionTitle: 'Ada yang perlu dicek',
      signatureFailures: (count: number, when: string | null) =>
        `${count.toLocaleString('id-ID')} kiriman ditolak karena tanda tangan Meta tidak cocok${when ? ` (terakhir ${when})` : ''}. Cocokkan App Secret di Kredensial Meta.`,
      failed: (count: number) =>
        `${count.toLocaleString('id-ID')} kejadian gagal diproses setelah beberapa percobaan.`,
      rejected: (count: number) =>
        `${count.toLocaleString('id-ID')} kejadian ditolak karena isinya tidak bisa disimpan.`,
      stalled: (count: number) =>
        `${count.toLocaleString('id-ID')} kejadian menunggu lebih dari 10 menit. Periksa apakah layanan worker berjalan.`,
      expired: (count: number) =>
        `${count.toLocaleString('id-ID')} kejadian kedaluwarsa sebelum sempat diproses.`,
      received: 'Diterima',
      processed: 'Diproses',
      pending: 'Menunggu',
      failedLabel: 'Gagal',
      lastReceived: 'Terakhir diterima',
      lastProcessed: 'Terakhir diproses',
      never: 'Belum pernah',
      checkedAt: (when: string) => `Diperiksa ${when}.`,
    },

    wizard: {
      title: 'Tambah nomor WhatsApp',
      stepsLabel: 'Langkah menghubungkan nomor',
      stepOf: (step: number, total: number) => `Langkah ${step} dari ${total}`,
      stepCurrent: 'langkah sekarang',
      stepDone: 'selesai',
      next: 'Lanjut',
      back: 'Kembali',
      save: 'Simpan channel',
      saving: 'Menyimpan…',
      finish: 'Selesai',
      savedNote: (name: string) =>
        `Channel ${name} sudah tersimpan. Isian sebelumnya bisa diubah dari halaman nomor.`,
      saveNote: 'Setelah disimpan, channel tercatat dengan status Belum dites.',
      confirmTitle: 'Simpan channel baru?',
      confirmBody:
        'Token dan App Secret disimpan terenkripsi di server. Chat dari nomor ini akan masuk ke inbox timmu.',
      leave: {
        title: 'Batal menambah nomor?',
        body: 'Isian yang belum disimpan, termasuk token dan App Secret, akan hilang.',
        stay: 'Tetap di sini',
        leave: 'Tinggalkan',
      },
      steps: {
        business: {
          nav: 'Meta Business',
          title: 'Siapkan Meta Business',
          intro:
            'Nomor dihubungkan lewat portofolio bisnis perusahaanmu di Meta. Pastikan aksesnya siap dulu.',
          items: [
            {
              text: 'Masuk ke Meta Business Suite dengan akun yang menjadi admin portofolio bisnis perusahaan.',
              link: { label: 'Buka business.facebook.com', href: 'https://business.facebook.com/' },
            },
            {
              text: 'Disarankan sudah verifikasi bisnis (Pengaturan Bisnis → Pusat Keamanan). Tanpa verifikasi, batas pesan dan nama tampilan lebih terbatas.',
              link: {
                label: 'Buka Pusat Keamanan',
                href: 'https://business.facebook.com/settings/security',
              },
            },
          ],
        },
        app: {
          nav: 'Aplikasi Meta',
          title: 'Buat aplikasi Meta',
          intro: 'Aplikasi Meta menjadi jalur resmi Cloud API untuk nomor ini.',
          items: [
            {
              text: 'Buka **Aplikasi Saya** di Meta for Developers, lalu tekan **Buat Aplikasi**.',
              link: {
                label: 'Buka developers.facebook.com',
                href: 'https://developers.facebook.com/apps/',
              },
            },
            { text: 'Pilih tipe **Business**, lalu hubungkan ke portofolio bisnis perusahaanmu.' },
            { text: 'Di dasbor aplikasi, tambahkan produk **WhatsApp**.' },
          ],
        },
        number: {
          nav: 'Pilih nomor',
          title: 'Pilih nomor',
          intro: 'Tentukan nomor yang dipakai timmu untuk membalas pelanggan.',
          items: [
            { text: 'Untuk uji coba, pakai nomor tes dari Meta di WhatsApp → Konfigurasi API.' },
            {
              text: 'Untuk produksi, tambahkan nomor sendiri. Nomor itu tidak boleh sedang aktif di aplikasi WhatsApp atau WhatsApp Business di HP.',
            },
            {
              text: 'Verifikasi nomor dengan kode OTP, lalu atur PIN verifikasi dua langkah untuk nomor itu.',
            },
          ],
        },
        ids: {
          nav: 'Salin ID',
          title: 'Salin ID nomor',
          intro:
            'Buka WhatsApp → Konfigurasi API di dasbor aplikasi, pilih nomornya, lalu salin dua ID-nya ke sini.',
          items: [],
          name: 'Nama channel',
          namePlaceholder: 'Contoh: CS Utama',
          nameHint: 'Nama untuk timmu di inbox. Tidak tampil ke pelanggan.',
          phoneNumberId: 'Phone Number ID',
          phoneNumberIdHint: 'Angka di bawah nomor yang dipilih, contoh: 106540352242922.',
          wabaId: 'WhatsApp Business Account ID',
          wabaIdHint: 'Angka di halaman yang sama, di bawah nama akun WhatsApp Business.',
        },
        token: {
          nav: 'Token permanen',
          title: 'Buat token permanen',
          intro:
            'Token sementara di Konfigurasi API kedaluwarsa dalam 24 jam. Buat token permanen dari Pengguna Sistem.',
          items: [
            {
              text: 'Buka Pengaturan Bisnis → Pengguna → Pengguna Sistem, lalu tambah pengguna sistem dengan peran Admin.',
              link: {
                label: 'Buka Pengguna Sistem',
                href: 'https://business.facebook.com/settings/system-users',
              },
            },
            {
              text: 'Tetapkan aset: aplikasi tadi dan akun WhatsApp, masing-masing dengan kontrol penuh.',
            },
            {
              text: 'Buat token untuk aplikasi itu dengan masa berlaku “Tidak pernah” dan izin `whatsapp_business_messaging` serta `whatsapp_business_management`.',
            },
          ],
          label: 'Token System User',
          hint: 'Disimpan terenkripsi di server dan tidak pernah ditampilkan lagi.',
        },
        secret: {
          nav: 'App Secret',
          title: 'Salin App Secret',
          intro: 'App Secret dipakai untuk memastikan pesan yang masuk benar-benar dari Meta.',
          items: [
            { text: 'Di dasbor aplikasi, buka Pengaturan Aplikasi → Dasar.' },
            {
              text: 'Tekan **Tampilkan** di samping App Secret, masukkan password Facebook-mu, lalu salin.',
            },
          ],
          label: 'App Secret',
          hint: 'Biasanya 32 karakter huruf dan angka. Disimpan terenkripsi.',
        },
        webhook: {
          nav: 'Webhook',
          title: 'Pasang webhook',
          intro: 'URL webhook dan verify token di bawah dibuat khusus untuk channel ini.',
          items: [
            {
              text: 'Di dasbor aplikasi Meta, buka WhatsApp → Konfigurasi → Webhook, lalu tekan **Edit**.',
            },
            {
              text: 'Tempel URL webhook ke **Callback URL** dan verify token ke **Verify token**.',
            },
            { text: 'Tekan **Verifikasi dan simpan**.' },
            { text: 'Klik **Berlangganan** untuk ketiga kolom webhook di bawah.' },
          ],
        },
        test: {
          nav: 'Tes koneksi',
          title: 'Tes koneksi',
          intro:
            'Tes memeriksa token, App Secret, Phone Number ID, dan WABA ID langsung ke Meta, lalu mengambil data nomornya.',
          items: [],
          failedHint:
            'Isian yang sudah tersimpan diganti dari halaman nomor. Tekan Lanjut sampai selesai, lalu pilih “Ganti kredensial” di sana.',
        },
        billing: {
          nav: 'Pembayaran',
          title: 'Tambahkan metode pembayaran',
          intro:
            'Template dan percakapan di luar kuota gratis ditagih Meta. Tanpa metode pembayaran, pengirimannya ditolak.',
          items: [
            {
              text: 'Buka WhatsApp Manager → Pengaturan akun → Metode pembayaran.',
              link: {
                label: 'Buka WhatsApp Manager',
                href: 'https://business.facebook.com/wa/manage/home/',
              },
            },
            { text: 'Tambahkan kartu atau metode pembayaran lain yang tersedia untuk akunmu.' },
          ],
          done: 'Kualitas nomor, profil bisnis, dan kredensial bisa dikelola dari halaman nomor.',
        },
      },
    },

    sections: {
      label: 'Bagian halaman nomor',
      summary: 'Ringkasan',
    },

    detail: {
      title: 'Nomor WhatsApp',
      notFoundTitle: 'Channel tidak ditemukan',
      notFoundBody: 'Mungkin sudah dihapus, atau alamatnya salah.',
      backToList: 'Kembali ke Channel',
      loadFailedTitle: 'Channel belum bisa dimuat',
      untested:
        'Belum dites. Tekan “Tes koneksi” untuk memeriksa kredensial dan mengambil data nomor dari Meta.',
      lastFailedTitle: 'Tes terakhir gagal',
      disabledSince: (time: string) => `Dinonaktifkan sejak ${time}`,
      disabledBody:
        'Chat dari nomor ini tidak masuk ke inbox, dan timmu tidak bisa membalas lewat nomor ini. Kredensial tetap tersimpan.',
      enable: 'Aktifkan lagi',
      enabling: 'Mengaktifkan…',
      enabled: 'Channel aktif lagi.',
      disabledDone: 'Channel dinonaktifkan.',
    },

    rename: {
      title: 'Nama channel',
      hint: 'Nama untuk timmu di inbox. Tidak tampil ke pelanggan.',
      label: 'Nama di inbox',
      save: 'Simpan nama',
      saving: 'Menyimpan…',
      saved: 'Nama channel tersimpan.',
      unchanged: 'Nama masih sama dengan yang tersimpan.',
    },

    credentials: {
      title: 'Kredensial Meta',
      hint: 'Dipakai server untuk memanggil Cloud API. Token dan App Secret tidak pernah ditampilkan lagi.',
      phoneNumberId: 'Phone Number ID',
      wabaId: 'WABA ID',
      token: 'Token System User',
      appSecret: 'App Secret',
      updatedAt: 'Terakhir diganti',
      stored: 'Tersimpan',
      change: 'Ganti kredensial',
      cancel: 'Batal',
      formHint:
        'Isi hanya yang ingin diganti. Token dan App Secret yang dikosongkan tetap memakai yang tersimpan.',
      keepToken: (hint: string) => `Tersimpan (${hint}). Kosongkan untuk tetap memakai token ini.`,
      keepSecret: (hint: string) =>
        `Tersimpan (${hint}). Kosongkan untuk tetap memakai App Secret ini.`,
      keepNoHint: 'Tersimpan. Kosongkan untuk tetap memakai yang ini.',
      save: 'Simpan kredensial',
      saving: 'Menyimpan…',
      unchanged: 'Belum ada yang diganti. Ubah salah satu isian dulu.',
      confirmTitle: 'Ganti kredensial channel?',
      confirmBody: 'Status koneksi kembali ke Belum dites sampai kamu menekan “Tes koneksi” lagi.',
      saved: 'Kredensial diganti. Tekan “Tes koneksi” untuk memastikan semuanya cocok.',
    },

    access: {
      title: 'Akses channel',
      disableHint:
        'Nonaktifkan bila nomor ini sedang tidak dipakai. Kredensial tetap tersimpan dan bisa diaktifkan lagi kapan saja.',
      enableHint: 'Aktifkan lagi supaya chat dari nomor ini masuk ke inbox.',
      disable: 'Nonaktifkan channel',
      disabling: 'Menonaktifkan…',
      disableTitle: 'Nonaktifkan channel ini?',
      disableBody:
        'Chat dari nomor ini berhenti masuk ke inbox, dan timmu tidak bisa membalas lewat nomor ini sampai diaktifkan lagi.',
      disableConfirm: 'Nonaktifkan',
      disableCancel: 'Batal',
      deleteTitleCard: 'Hapus channel',
      deleteHint:
        'Token, App Secret, dan verify token dimusnahkan dari server. Nomor yang sama boleh ditambahkan lagi nanti.',
      delete: 'Hapus channel',
      deleteTitle: (name: string) => `Hapus channel ${name}?`,
      deleteBody:
        'Kredensial dimusnahkan dan channel hilang dari semua daftar. Cabut juga webhook-nya di Meta (WhatsApp → Konfigurasi → Webhook) supaya Meta berhenti mengirim pesan ke alamat ini.',
      deleteConfirm: 'Hapus channel',
      deleting: 'Menghapus…',
    },

    profile: {
      title: 'Profil bisnis',
      hint: 'Tampil ke semua pelanggan di info kontak WhatsApp. Perubahan langsung dikirim ke Meta.',
      about: 'Tentang',
      aboutHint: 'Kalimat singkat di bawah nama. Tidak boleh kosong.',
      address: 'Alamat',
      description: 'Deskripsi',
      email: 'Email',
      emailPlaceholder: 'Contoh: cs@perusahaan.co.id',
      websites: 'Situs web',
      website: (index: number) => `Situs web ${index}`,
      websitePlaceholder: 'https://perusahaan.co.id',
      websitesHint: 'Paling banyak 2 alamat, diawali https://.',
      vertical: 'Kategori',
      verticalNone: 'Belum dipilih',
      verticalUnknown: (value: string) => `${value} (dari Meta)`,
      photo: 'Foto profil diubah lewat WhatsApp Manager untuk sementara.',
      photoLink: 'Buka WhatsApp Manager',
      counter: (used: number, max: number) => `${used}/${max} karakter`,
      save: 'Simpan profil',
      saving: 'Menyimpan…',
      saved: 'Profil bisnis tersimpan di Meta.',
      savedNoReload: 'Tersimpan. Muat ulang untuk melihat profil terbaru.',
      reload: 'Muat ulang',
      unchanged: 'Belum ada yang diubah.',
      confirmTitle: 'Simpan profil bisnis?',
      confirmBody:
        'Tentang, alamat, deskripsi, email, dan situs web langsung tampil ke semua pelanggan yang membuka info kontak nomor ini.',
      lockedTitle: 'Profil bisnis dibatasi sementara',
      loadFailedTitle: 'Profil bisnis belum bisa dimuat',
      needsConnection: 'Profil bisnis bisa dilihat dan diubah setelah tes koneksi berhasil.',
      fetchedAt: (time: string) => `Dibaca dari Meta ${time}`,
    },
  },

  /** Pengaturan → Balasan cepat (quick reply `/`; "template" hanya untuk template WhatsApp). */
  quickReplies: {
    title: 'Balasan cepat',
    menuHint: 'Balasan siap pakai yang dipanggil dengan "/" di kolom chat',
    menuCount: (count: number) => (count === 0 ? 'Belum ada balasan' : `${count} balasan`),
    intro:
      'Ketik "/" di kolom chat untuk memakai balasan cepat. {nama} diisi nama kontak, {agen} diisi nama agen yang mengirim.',
    add: 'Tambah balasan cepat',
    addShort: 'Tambah',
    addFirst: 'Buat balasan cepat pertama',
    emptyTitle: 'Belum ada balasan cepat',
    emptyBody:
      'Simpan balasan yang sering dipakai, misalnya salam pembuka atau info jam operasional, supaya tim cukup mengetik "/salam".',
    loadFailedTitle: 'Balasan cepat belum bisa dimuat',
    searchLabel: 'Cari balasan cepat',
    searchPlaceholder: 'Cari shortcut, judul, atau isi',
    clearSearch: 'Hapus pencarian',
    notFound: (search: string) => `Tidak ada balasan cepat yang cocok dengan “${search}”.`,
    listLabel: 'Daftar balasan cepat',
    edit: (shortcut: string) => `Ubah /${shortcut}`,
    remove: (shortcut: string) => `Hapus /${shortcut}`,
    used: (count: number) => (count === 0 ? 'Belum pernah dipakai' : `Dipakai ${count} kali`),
    updatedBy: (name: string, when: string) => `Diubah ${name}, ${when}`,
    updatedAt: (when: string) => `Diubah ${when}`,
    addTitle: 'Tambah balasan cepat',
    editTitle: 'Ubah balasan cepat',
    shortcutLabel: 'Shortcut',
    shortcutHint: 'Huruf kecil, angka, - atau _. Contoh: salam, jam-buka.',
    titleLabel: 'Judul',
    bodyLabel: 'Isi pesan',
    insertLabel: 'Sisipkan:',
    variablesLabel: 'Sisipkan variabel',
    insertVariable: (token: string, label: string) => `${token} ${label}`,
    save: 'Simpan',
    saving: 'Menyimpan…',
    cancel: 'Batal',
    created: (shortcut: string) => `Balasan cepat /${shortcut} ditambahkan.`,
    updated: (shortcut: string) => `Balasan cepat /${shortcut} disimpan.`,
    deleted: (shortcut: string) => `Balasan cepat /${shortcut} dihapus.`,
    removeTitle: (shortcut: string) => `Hapus balasan cepat /${shortcut}?`,
    removeBody:
      'Balasan ini hilang dari daftar "/" untuk semua anggota tim. Pesan yang sudah terkirim tidak berubah.',
    removeConfirm: 'Hapus balasan cepat',
    removing: 'Menghapus…',
  },

  /** Pengaturan → Batas kirim & rem darurat (`sending.limits.manage`; lanjutkan = `sending.resume`). */
  sendingLimits: {
    title: 'Batas kirim',
    menuHint: 'Batas pesan keluar dan rem darurat pengiriman',
    menuRunning: (sent: number) => `${sent.toLocaleString('id-ID')} pesan dalam 24 jam`,
    menuPaused: 'Rem darurat ditarik',
    intro:
      'Batas ini mencegah pengiriman berlebihan, misalnya akun yang disalahgunakan atau kiriman berulang ke satu pelanggan. Hitungan harian memakai 24 jam terakhir.',
    loadFailedTitle: 'Batas kirim belum bisa dimuat',
    // Rem darurat
    brakeTitle: 'Rem darurat',
    runningTitle: 'Pengiriman berjalan',
    runningBody:
      'Tarik rem bila ada yang tidak beres, misalnya pesan terkirim ke banyak pelanggan tanpa sengaja. Semua pesan keluar langsung berhenti untuk seluruh tim.',
    pausedTitle: 'Pengiriman sedang dihentikan',
    pausedBy: (name: string, when: string) => `Rem ditarik oleh ${name}, ${when}.`,
    pausedBySystem: (when: string) => `Rem ditarik ${when}.`,
    pausedReason: (reason: string) => `Alasan: ${reason}`,
    pausedHint:
      'Agen tetap bisa membaca chat dan menulis draf, tetapi tidak ada pesan yang dikirim sampai pengiriman dilanjutkan.',
    pause: 'Tarik rem darurat',
    pauseTitle: 'Hentikan semua pengiriman?',
    pauseBody:
      'Semua pesan keluar langsung berhenti untuk seluruh tim, termasuk yang sedang mengantre. Untuk melanjutkan nanti, Owner atau Admin perlu mengonfirmasi identitasnya.',
    reasonLabel: 'Alasan (tidak wajib)',
    reasonHint: 'Terlihat oleh tim di pengaturan ini dan di log audit.',
    pauseConfirm: 'Hentikan pengiriman',
    pausing: 'Menghentikan…',
    paused: 'Rem darurat ditarik. Semua pengiriman berhenti.',
    resume: 'Lanjutkan pengiriman',
    resumeTitle: 'Lanjutkan pengiriman?',
    resumeBody:
      'Pesan keluar akan dikirim lagi untuk seluruh tim. Pastikan penyebab rem ditarik sudah diatasi.',
    resuming: 'Melanjutkan…',
    resumed: 'Pengiriman berjalan lagi.',
    resumeNotAllowed: 'Hanya Owner atau Admin yang bisa melanjutkan pengiriman.',
    cancel: 'Batal',
    // Batas
    limitsTitle: 'Batas pesan keluar',
    limitsHint:
      'Berlaku untuk balasan agen dan pesan otomatis. Mengubahnya perlu konfirmasi identitas.',
    usage: (sent: number, limit: number) =>
      `${sent.toLocaleString('id-ID')} dari ${limit.toLocaleString('id-ID')} pesan organisasi dalam 24 jam terakhir`,
    usageLabel: 'Pemakaian batas harian organisasi',
    dailyPerOrganization: 'Batas harian organisasi',
    dailyPerUser: 'Batas harian per pengguna',
    perConversationPerMinute: 'Batas per percakapan per menit',
    perMessages: 'pesan',
    fieldHint: (fallback: number, min: number, max: number) =>
      `Bawaan ${fallback.toLocaleString('id-ID')}. Isi ${min.toLocaleString('id-ID')}–${max.toLocaleString('id-ID')}.`,
    notNumber: (label: string) => `${label} harus angka bulat.`,
    save: 'Simpan batas',
    saving: 'Menyimpan…',
    unchanged: 'Belum ada yang diubah.',
    saved: 'Batas kirim disimpan.',
    confirmTitle: 'Simpan batas kirim baru?',
    confirmBody: 'Batas baru langsung berlaku untuk seluruh tim dan tercatat di log audit.',
  },

  settingsMenu: {
    sectionTitle: 'Pengaturan organisasi',
    open: (name: string) => `Buka ${name}`,
  },
} as const;
