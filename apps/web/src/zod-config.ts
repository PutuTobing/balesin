import { z } from 'zod';

/**
 * Zod 4 menguji `new Function('')` untuk mempercepat parsing objek. CSP produksi (tanpa
 * `'unsafe-eval'`) menolaknya dan mengirim laporan pelanggaran di setiap muatan. Mode `jitless`
 * mematikan percobaan itu; hasil validasi sama persis. Diimpor PALING AWAL di `main.tsx` supaya
 * berlaku sebelum skema mana pun dipakai.
 */
z.config({ jitless: true });
