import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import './zod-config';

describe('konfigurasi Zod untuk CSP', () => {
  it('mode jitless aktif (tanpa probe `Function`)', () => {
    expect(z.config().jitless).toBe(true);
  });
});
