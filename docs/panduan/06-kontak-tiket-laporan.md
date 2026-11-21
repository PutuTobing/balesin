# 6. Kontak, tiket, dan laporan

## 6.1 Kontak

Kontak tersimpan otomatis begitu pelanggan mengirim chat. Buka menu **Kontak**.

- **Cari nama, nomor, atau username**, lalu saring menurut **Tag** atau **Atribut** (nilai
  persis, mis. "Gold").
- Centang **Mungkin duplikat** untuk melihat kontak yang nomornya pernah tercatat di kontak
  lain.
- Buka kontak untuk melihat **Data kontak**, **Atribut**, **Tag**, dan **Tiket** terkait.

Satu orang yang menghubungi lewat dua channel berbeda (mis. WhatsApp dan email) tercatat
sebagai dua kontak.

**Gabung kontak duplikat** (Owner dan Admin)

1. Buka kontak yang berlabel **Mungkin duplikat**, tekan **Gabung kontak**.
2. Pilih **Kontak yang dipertahankan** (disarankan yang lebih lama), tekan **Lanjutkan**.
3. Tekan **Gabungkan**. Percakapan, pesan, tag, tiket, dan riwayat ikut pindah. Kontak lainnya
   dihapus permanen; tindakan ini tidak bisa dibatalkan.

**Impor kontak** (Owner, Admin, Supervisor)

1. **Kontak → Impor**, pilih berkas CSV atau Excel (.xlsx), maks. 5 MB. Baris pertama berisi
   judul kolom. Format `.xls` lama tidak didukung; simpan ulang sebagai `.xlsx` atau `.csv`.
2. **Cocokkan kolom**: hanya **Kolom nomor** yang wajib. Nomor `08…` otomatis diubah ke
   `+628…`. Pilih juga kolom nama, email, catatan, dan tag (beberapa tag dipisah koma; tag baru
   dibuat otomatis). Kolom lain bisa disimpan sebagai **Kolom atribut** (mis. paket, ID
   pelanggan).
3. **Kalau nomornya sudah ada**: **Perbarui kontaknya** (butuh konfirmasi password) atau
   **Lewati, hanya tambah kontak baru**.
4. Tekan **Periksa dulu** (tidak menyimpan apa pun), baca **Baris yang dilewati**, lalu
   **Impor sekarang**.

**Ekspor kontak**: **Kontak → Ekspor → Unduh CSV**. Bila ada saringan aktif, hanya kontak yang
cocok yang diunduh. Berkas berisi data pribadi pelanggan; simpan dengan aman.

**Permintaan data pribadi (UU PDP)**: dari panel detail chat, Owner dan Admin bisa
**Ekspor data kontak** atau **Hapus kontak** secara permanen (lihat
[Bab 4](04-inbox-untuk-agen.md#49-panel-detail-kontak-tag-catatan)).

## 6.2 Atribut kontak

Owner dan Admin bisa membuat isian tambahan yang rapi untuk setiap kontak di **Pengaturan →
Atribut kontak → Tambah atribut**:

- **Kunci**: nama teknis untuk API dan impor (tidak bisa diubah setelah dibuat), mis.
  `id_pelanggan`.
- **Label**: nama yang tampil ke tim, mis. "ID pelanggan".
- **Jenis**: **Teks**, **Angka**, **Tanggal**, atau **Pilihan**. Untuk Pilihan, tulis satu
  pilihan per baris (maks. 50).
- **Wajib diisi**: ditegakkan saat tim menyimpan dari aplikasi. Bot dan impor tetap boleh
  mengosongkannya.

Atribut tanpa definisi (mis. dari bot atau impor) tetap tersimpan sebagai **Atribut bebas**.

## 6.3 Tiket

Tiket mencatat pekerjaan yang perlu ditindaklanjuti, mis. perbaikan oleh teknisi. Buka menu
**Tiket**.

**Board**

Tiket dikelompokkan per **board** (mis. "Perbaikan" dan "Pemasangan baru"). Owner, Admin, dan
Supervisor membuat board lewat **Board baru**: isi **Nama board**, **Deskripsi**, dan
**Departemen** bila perlu. Board baru memakai kolom **Baru**, **Dikerjakan**, dan **Selesai**.

Di **Atur board** Anda bisa:

- **Tambah kolom**, **Ganti nama**, **Geser ke kiri/kanan**, **Hapus kolom** (tiketnya
  dipindah ke kolom lain).
- **Jadikan kolom selesai**: tiket yang masuk ke kolom ini dianggap selesai.
- Menambah **Isian board** (atribut tiket), mis. "Lokasi ODP" atau "Jenis gangguan".
- **Arsipkan board** yang tidak dipakai lagi.

**Tampilan**: **Kanban** (kartu per kolom; seret kartu untuk memindah, atau pakai keyboard:
panah untuk pindah kolom, Spasi untuk meletakkan) atau **Daftar** (tabel). Saring menurut
**Penanggung jawab**, **Prioritas**, **Status**, dan **Tenggat** (Lewat tenggat, Hari ini,
7 hari ke depan, Tanpa tenggat), atau cari judul / `#nomor`.

**Membuat tiket**

1. Tekan **Tiket baru** (atau **Buat tiket** dari panel detail chat, supaya kontak dan
   percakapan langsung tertaut).
2. Isi **Judul**, **Deskripsi** (ringkas masalah dan langkah yang sudah dicoba), **Board**,
   **Kolom**, **Penanggung jawab**, **Tenggat**, **Prioritas** (Rendah, Normal, Tinggi, Mendesak),
   dan **Isian board**.
3. Tekan **Buat tiket**.

Di halaman tiket, tab **Komentar** untuk catatan perkembangan dan tab **Riwayat** untuk
jejak perubahan.

Teknisi hanya melihat tiket yang ia pegang. Bot dan aplikasi lain bisa membuat dan mengubah
tiket lewat API (lihat [Bab 7](07-bot-api-n8n.md)).

## 6.4 Laporan

Buka menu **Laporan**. Owner, Admin, dan Supervisor melihat laporan seluruh organisasi; CS dan
Teknisi melihat **Kinerja saya**.

Pilih **Rentang**: 7 hari terakhir, 30 hari terakhir, Bulan ini, Bulan lalu, atau Pilih tanggal
(maks. 92 hari). Bisa disaring per **Channel**. Semua waktu memakai zona waktu organisasi.

**Tab Kinerja**

| Bagian | Isi |
|---|---|
| **Ringkasan** | Percakapan baru, Selesai, **Respons pertama**, **Waktu tunggu**, **Waktu penyelesaian** (median, rata-rata, dan 90% di bawah), Bot, Dibalas tim, Diserahkan bot ke tim |
| **Kepuasan pelanggan (CSAT)** | Skor rata-rata, tingkat jawaban, sebaran skor 1–5 |
| **Tren harian** dan **Percakapan baru per jam** | Grafik; tekan **Lihat sebagai tabel** untuk angka |
| **Per agen** | Ditangani, Diselesaikan, Pesan, Respons pertama (median), CSAT |
| **Per bot** | Percakapan, pesan, dan jumlah yang diserahkan ke tim, per API key bot |
| **Per tag** | Percakapan, selesai, dan waktu penyelesaian per tag |

Tekan **Unduh CSV** di setiap bagian untuk mengekspor.

Arti istilah:

- **Respons pertama**: jarak dari chat dibuat sampai balasan agen manusia pertama.
- **Waktu tunggu**: jarak dari chat masuk antrian (atau diserahkan bot) sampai ditangani agen.
- **Waktu penyelesaian**: jarak dari chat dibuat sampai ditandai selesai.

**Tab Biaya Meta** (Owner, Admin, Supervisor)

Perkiraan biaya pesan WhatsApp per nomor untuk bulan yang dipilih:

- **Percakapan layanan**: balasan biasa ke pelanggan. Meta memberi **kuota gratis 1.000 per
  nomor per bulan**; tampil sisa kuotanya. Di atas kuota dihitung sebagai **Ditagih**.
- **Template**: per kategori (Pemasaran, Utilitas, Autentikasi) — terkirim, ditagih, gratis,
  dan biaya. Template utilitas ke pelanggan yang menulis dalam 24 jam terakhir dihitung gratis.
- **Total perkiraan** per channel.

Angka ini **perkiraan**. Angka akhir mengikuti tagihan Meta. Tarif diatur di
**Pengaturan → Batas kirim** (lihat [Bab 5](05-template-dan-broadcast.md#55-batas-kirim-dan-rem-darurat)).
Bila muncul pesan "pesan ditagih belum punya tarif negara tujuannya", tambahkan tarif negara
tersebut.

## 6.5 Survei kepuasan (CSAT)

Setelah agen menandai chat selesai, pelanggan menerima pilihan nilai 1–5 ("5 — Sangat puas"
sampai "1 — Tidak puas"). Hasilnya tampil di Laporan.

Owner atau Admin mengaturnya di **Pengaturan → Survei kepuasan (CSAT)**:

1. Nyalakan **Kirim survei otomatis** (bawaannya mati).
2. Ubah **Pertanyaan survei** dan **Ucapan terima kasih** bila perlu (tidak boleh berisi
   tautan).
3. Atur **Jarak antar-survei (jam)**, bawaan 24: kontak yang sudah disurvei dalam rentang ini
   tidak disurvei lagi.
4. Lihat **Pratinjau**, lalu **Simpan**.

Survei hanya dikirim untuk chat **WhatsApp** yang dimulai pelanggan, dibalas agen manusia, dan
sesi 24 jamnya masih terbuka. Chat yang diselesaikan bot atau sistem tidak disurvei. Bila
pelanggan menulis komentar dalam 30 menit setelah menilai, komentarnya ikut tercatat.
