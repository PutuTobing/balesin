---
description: Audit menyeluruh Balesin — tampilan desktop & HP, bug, keamanan — lalu perbaiki temuannya
---
Kamu orkestrator. Lakukan audit penuh lalu perbaiki, tanpa menunggu Tobing:

1. `qa-tester`: jalankan seluruh tes + E2E; telusuri semua layar di 390px dan 1440px,
   catat bug.
2. `kritikus-desain`: nilai semua layar dengan rubrik `docs/DESIGN.md`; prioritaskan layar
   yang paling sering dipakai (Inbox, Chat, Broadcast).
3. `security`: review menyeluruh terhadap `docs/SECURITY.md`, termasuk `pnpm audit`.
4. Gabungkan temuan ke `docs/audits/<tanggal>.md`, urutkan: Kritis → Tinggi → Sedang → Rendah.
5. Perbaiki semua Kritis/Tinggi dan sebanyak mungkin Sedang (siklus mutu seperti `/lanjut`).
6. Ringkas hasil untuk Tobing.

Fokus tambahan (opsional): $ARGUMENTS
