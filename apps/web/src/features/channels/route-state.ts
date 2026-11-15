/**
 * Keadaan riwayat untuk pesan sekali tampil antarhalaman channel: setelah channel dihapus,
 * halaman daftar menampilkan "Channel … sudah dihapus" (nama saja, bukan data rahasia).
 */
declare module '@tanstack/react-router' {
  interface HistoryState {
    deletedChannel?: string;
  }
}

export {};
