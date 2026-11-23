/**
 * Review keamanan tahap 9B (docs/security-reviews/2026-11-23-fase9b.md) — tes PENGUNCI temuan core.
 * `it.fails` = perilaku aman yang BELUM dipenuhi; setelah diperbaiki ubah menjadi `it`.
 */
import { describe, expect, it } from 'vitest';

import { renderMailIdentityVerificationEmail } from './templates';

describe('R3 (Rendah) — teks bebas CS ikut email verifikasi ke alamat luar sembarang', () => {
  it.fails(
    'nama tampilan akun (bebas diisi pemilik akun pribadi) tidak ikut ke isi email verifikasi',
    () => {
      const body = renderMailIdentityVerificationEmail({
        brand: {
          productName: 'Balesin',
          organizationName: 'PT Maju Jaya',
          logoSrc: null,
          primaryColor: null,
        },
        requesterName: 'Budi',
        organizationName: 'PT Maju Jaya',
        address: 'korban@luar.test',
        accountName: 'HADIAH Rp5 juta, klaim di penipu.test/klaim',
        code: '482913',
      });
      expect(`${body.subject}\n${body.html}\n${body.text}`).not.toContain('penipu.test');
    },
  );
});
