# Desain modul Email (Fase 9)

Acuan visual untuk `frontend` dan `kritikus-desain`. Spesifikasi fitur: `docs/PRD-EMAIL.md`.

## Cara membuka
Buka `mockup.html` langsung di browser (tanpa server). Bilah atas mockup:
- **Kotak surat** — menu Email desktop. Keadaan: **Baca**, **Tulis** (jendela mengambang),
  **Info kontak** (panel pengirim/CRM), **Saring** (panel saringan + simpan tampilan), **Belum ada
  akun** (keadaan kosong). Penugasan, status, dan penanda "sedang membalas" ada di kepala panel baca.
- **Tambah akun** — Pengaturan → Akun email + wizard 4 langkah (klik nomor langkah atau Lanjut).
- **HP** — 4 layar 390×844: daftar (geser untuk arsip), laci akun & folder, baca, tulis.
- Tombol **Mode gelap/terang**.

Parameter URL (untuk screenshot otomatis): `?v=desk|akun|hp&s=read|compose|crm|filter|empty&step=1..4&t=light|dark&chrome=0`.
Screenshot terang & gelap 1440×900 ada di `shots/`.

## Catatan untuk frontend
- Semua warna = token `packages/shared/src/design-tokens.ts` (tidak ada warna baru). Titik warna akun
  memakai `tagBlue`, `tagTeal`, `tagPurple`, `accent`, `success`, `warning`.
- Ikon = lucide (stroke 1.75): `Mail` (rail/nav), `Layers` (semua kotak masuk), `Inbox`, `Send`, `File`,
  `Archive`, `ShieldAlert`, `Trash2`, `Folder`, `Star`, `Paperclip`, `ShieldCheck` (terverifikasi),
  `ImageOff` (gambar diblokir), `Reply`, `ReplyAll`, `Forward`, `SquarePen` (tulis), `PanelRight`
  (info pengirim), `Server`/`Cloud`/`Plug`/`HardDriveDownload` (penyedia).
- Ukuran: rail 64 · folder 248 · daftar 380 · panel baca fleksibel (isi maks. 768) · info pengirim 320
  (saat dibuka kolom folder disembunyikan). Item daftar ±82px, avatar 36. Jendela tulis 600×600.
- Logo penyedia **tidak** memakai logo merek pihak lain — ikon lucide netral + nama penyedia.
- Isi email dirender di iframe sandbox (lihat PRD §7); mockup hanya meniru tampilannya.
- Teks UI semua bahasa Indonesia; nada santai-profesional (DESIGN.md §4).
- Mockup ini acuan, bukan kode produksi: bangun ulang dengan komponen yang sudah ada (Button,
  CreateButton, FormActions, Dialog, Tabs, dsb.).

Data di mockup fiktif (nama, alamat, nomor), kecuali domain dan nama perusahaan Sky Tech.
