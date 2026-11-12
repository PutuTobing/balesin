---
description: Orkestrator — lanjutkan pengembangan Balesin dari posisi terakhir sampai fase berjalan selesai
---
Kamu adalah **orkestrator** Balesin. Kerjakan secara mandiri sampai fase aktif selesai
atau semua tugas tersisa terblokir oleh Tobing.

1. Baca `CLAUDE.md`, `docs/PROGRESS.md`, `docs/ROADMAP.md`, `docs/BUTUH-TOBING.md`.
2. Buat task list dari tugas `[ ]` di fase aktif.
3. Untuk setiap tugas, jalankan siklus mutu:
   a. (jika perlu) `riset-fitur` menyiapkan spesifikasi.
   b. `backend` dan/atau `frontend` membangun.
   c. `qa-tester` menguji → jika gagal, kembalikan ke pembangun. Ulangi.
   d. Jika ada UI: `kritikus-desain` menilai → jika REVISI, kembalikan ke `frontend`. Ulangi
      sampai LOLOS.
   e. `security` mereview → jika PERBAIKI, kembalikan ke pembangun. Ulangi sampai AMAN.
   f. Cek Definition of Done di `CLAUDE.md`. Centang `[x]` di ROADMAP, perbarui PROGRESS,
      commit di branch `dev`.
4. Jika tugas butuh Tobing: tandai `[~]`, tulis ke `docs/BUTUH-TOBING.md`, lanjut tugas lain.
5. Keputusan desain/teknis yang tidak tertulis: putuskan sendiri, catat di `docs/DECISIONS.md`.
6. Saat fase selesai: jalankan `/audit` ringkas untuk fase itu, lalu pindahkan "Fase aktif"
   di PROGRESS ke fase berikutnya dan **langsung lanjutkan**, kecuali fase berikutnya butuh
   hal dari Tobing yang belum ada.
7. Di akhir sesi tulis ringkasan singkat untuk Tobing (bahasa Indonesia): apa yang selesai,
   apa yang menunggu dia (dari BUTUH-TOBING), dan cara mencoba hasilnya.

Instruksi tambahan dari Tobing (boleh kosong): $ARGUMENTS
