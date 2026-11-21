# Audit akhir sebelum rilis 1.0 (Fase 7 butir 6)

Commit yang diaudit: `ab1335f` (branch `dev`). Rincian per bagian:

- QA (tes, E2E, penelusuran layar): [`2026-11-25-audit-akhir/qa.md`](2026-11-25-audit-akhir/qa.md)
- Desain (rubrik `docs/DESIGN.md`, 1.417 foto 390/1440 terang/gelap): [`2026-11-25-audit-akhir/desain.md`](2026-11-25-audit-akhir/desain.md)
- Keamanan (`docs/SECURITY.md` §1–§10, `pnpm audit`): [`2026-11-25-audit-akhir/security.md`](2026-11-25-audit-akhir/security.md)

## Ringkasan

| Tingkat | Jumlah | Status |
|---|---|---|
| Kritis | 0 | — |
| Tinggi | 3 (QA, termasuk P2-T1 penutupan) | semua selesai |
| Sedang | 9 | semua selesai |
| Rendah | ±20 | selesai, kecuali A4 (checklist rilis) & QA-R2 (dicatat) |

## Kritis

Tidak ada.

## Tinggi

| ID | Temuan | Pemilik | Status |
|---|---|---|---|
| QA-T1 | E2E `broadcast.spec.ts` memilih template sebelum nomor pengirim → gagal 2/2, proyek `berurutan-hp` & `dengan-email` tidak jalan | qa-tester | ✅ |
| QA-T2 | Berkas tes keamanan bot belum diformat Prettier (`format:check` merah) | backend | ✅ rapi di HEAD |
| QA-P2-T1 | Penolakan "mulai percakapan" melempar `AppError` langsung (tidak diaudit) → `forbidden-pattern.test.ts` merah | backend | ✅ de2a8ee |

## Sedang

| ID | Temuan | Pemilik | Status |
|---|---|---|---|
| SEC-A1 | CS bisa mengirim template (termasuk MARKETING) ke semua percakapan `resolved` — jalur broadcast terselubung | backend | ✅ 584f040 + celah "Buka lagi" 9727cdb; security putaran 2 AMAN |
| DES-D1 | Tombol buat/tambah utama di 5 posisi berbeda | frontend | ✅ acf65e4, LOLOS putaran 2 |
| DES-D2 | Panah kembali HP bergeser 8 px di ±40 sub-halaman | frontend | ✅ acf65e4, LOLOS |
| DES-D3 | Tombol simpan form tidak seragam | frontend | ✅ acf65e4 (`FormActions`), LOLOS |
| DES-D4 | Keadaan kosong tidak seragam | frontend | ✅ acf65e4, LOLOS |
| QA-S1 | Laporan dibatasi 2 per organisasi → pengguna ketiga langsung 429; web tidak membaca `Retry-After` | backend + frontend | ✅ |
| QA-S2 | Impor kontak: kolom atribut terbuang diam-diam bila definisi atribut belum termuat | frontend | ✅ |
| QA-D1 | E2E memakai Vite dev dengan cache dingin → `alur-awal` timeout di worktree baru | devops | ✅ |

## Rendah (ringkas)

| ID | Temuan | Status |
|---|---|---|
| SEC-A6 | Varian A1 di Email/Telegram | ✅ 584f040 |
| SEC-A2 | Pembersih sel CSV ganda | ✅ 584f040 (`apps/api/src/http/csv.ts`) |
| SEC-A3 | Image pihak ketiga tanpa digest, tanpa pemindaian CVE | ✅ 0486386, 7e501f5, 50dc195 (Trivy 0 temuan semua image) |
| SEC-A4 | `BALESIN_REQUIRE_SIGNATURE` bawaan `0` | 📋 checklist rilis `docs/DEPLOY.md` §10 (BUTUH-TOBING #18) |
| SEC-A5 | Belum ada `THIRD-PARTY-NOTICES` (LGPL libvips) | ✅ 0486386 |
| SEC-P2-R1 | "Kirim ulang" belum memeriksa aturan mulai-percakapan | ✅ |
| SEC-P2-R2 | Percakapan terbuka tapi lama tetap boleh dikirimi template | ✅ |
| DES-R1–R7 | Kata kerja, ekspor, gaya tombol, ikon hapus, kartu laporan, label panel detail, skrip foto HP | ✅ acf65e4 |
| DES-N1–N4, BC-S13 | Aksi destruktif di `FormActions`, "Hapus tenggat", lebar kolom Pengaturan, teks chat selesai, judul Penerima | ✅ |
| QA-R1 | `sesi.spec.ts` bergantung waktu | ✅ |
| QA-R2 | Tes unit peka beban mesin | 📋 dicatat |
| QA-R3 | Nomor pengirim bawaan wizard broadcast tanpa template | ✅ |
| QA-R4 | Impor tanpa ekstensi di `packages/shared/src/branding.ts` | ✅ |
| QA-R5 | Skrip foto anggota tanpa mock departemen | ✅ |

## Hasil pemeriksaan

- Lint, check:deps, typecheck, build: bersih. Tes unit/integrasi: 3.027 lulus.
- E2E: 349 tes (285 jalan, 64 dilewati beralasan); satu run hijau penuh setelah tambalan T1 sementara.
- Penelusuran 45 layar (1440) + 43 layar (390) dengan data sungguhan: tanpa galat konsol, request gagal,
  scroll horizontal, teks English/placeholder, atau "Sky Tech".
- `pnpm audit --prod`: 0 kerentanan. Trivy: 0 temuan di image api, worker, web (amd64 & arm64).
- Tidak ada `it.fails` tersisa.

## Penutupan (21 Nov 2026)

- QA penutupan di `448df8a`: format, lint, check:deps, typecheck, build bersih; 3.112 tes unit/integrasi; **E2E penuh hijau dua kali berturut-turut** (285 lulus, 0 gagal, 0 goyah) dari worktree baru dengan cache Vite dingin.
- Temuan penutupan P2-T1 (penolakan mulai percakapan belum diaudit) diperbaiki; suite api 1.163 lulus.
- Keamanan putaran 3 **AMAN**; desain putaran 2 **LOLOS**. Tidak ada `it.fails` tersisa; `pnpm audit --prod` 0; Trivy 0 temuan.
- **Fase 7 butir 6 selesai — kode siap kandidat rilis 1.0.** Sisa sebelum produksi: BUTUH-TOBING #3, #4, #6, #7, #18, #19.
