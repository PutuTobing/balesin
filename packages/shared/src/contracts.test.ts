import { describe, expect, it } from 'vitest';

import {
  API_ROUTES,
  applySmtpPreset,
  authenticatedSessionSchema,
  brandColorSchema,
  completeSetupRequestSchema,
  EMAIL_SETTINGS_STATUS_LABELS,
  EMAIL_SETTINGS_STATUSES,
  EMAIL_TEST_CODES,
  EMAIL_TEST_MESSAGES,
  emailAddressSchema,
  emailDomainOf,
  emailSettingsInputSchema,
  emailSettingsViewSchema,
  isValidSmtpHost,
  isValidTimeZone,
  loginRequestSchema,
  loginResponseSchema,
  logoUploadSchema,
  LOGO_MAX_BYTES,
  newPasswordSchema,
  organizationNameSchema,
  SMTP_ALLOWED_PORTS,
  SMTP_DEFAULT_PORTS,
  SMTP_PRESETS,
  SMTP_SECURITY_LABELS,
  SMTP_SECURITY_MODES,
  isPlaintextSmtpLogin,
  SMTP_PLAINTEXT_LOGIN_WARNING,
  completeSetupResponseSchema,
  confirmTwoFactorEnrollmentRequestSchema,
  formatBackupCode,
  isTwoFactorRequired,
  meResponseSchema,
  startTwoFactorEnrollmentRequestSchema,
  totpCodeSchema,
  twoFactorCodeKind,
  twoFactorCodeSchema,
  twoFactorReauthRequestSchema,
  USER_ROLES,
  verifyTwoFactorRequestSchema,
} from './index';

const messagesOf = (result: { error?: { issues: Array<{ message: string }> } }) =>
  result.error?.issues.map((issue) => issue.message) ?? [];

describe('isian dasar', () => {
  it('email dibakukan (huruf kecil, tanpa spasi tepi) dan divalidasi', () => {
    expect(emailAddressSchema.parse('  Budi.Santoso@Contoh.CO.ID ')).toBe(
      'budi.santoso@contoh.co.id',
    );
    expect(messagesOf(emailAddressSchema.safeParse(''))).toEqual(['Alamat email wajib diisi.']);
    expect(messagesOf(emailAddressSchema.safeParse(undefined))).toEqual([
      'Alamat email wajib diisi.',
    ]);
    expect(messagesOf(emailAddressSchema.safeParse('bukan-email'))).toEqual([
      'Alamat email tidak valid. Contoh: nama@perusahaan.co.id',
    ]);
    expect(emailAddressSchema.safeParse(`${'a'.repeat(250)}@x.id`).success).toBe(false);
  });

  it('teks satu baris: satu pesan untuk kosong, pesan lain untuk terlalu pendek/panjang', () => {
    expect(organizationNameSchema.parse('  PT Maju Jaya  ')).toBe('PT Maju Jaya');
    expect(messagesOf(organizationNameSchema.safeParse('   '))).toEqual([
      'Nama perusahaan wajib diisi.',
    ]);
    expect(messagesOf(organizationNameSchema.safeParse('A'))).toEqual([
      'Nama perusahaan minimal 2 karakter.',
    ]);
    expect(messagesOf(organizationNameSchema.safeParse('A'.repeat(101)))).toEqual([
      'Nama perusahaan maksimal 100 karakter.',
    ]);
    expect(organizationNameSchema.safeParse('PT Maju\nJaya').success).toBe(false);
    expect(organizationNameSchema.safeParse('PT Maju\u0000Jaya').success).toBe(false);
  });

  it('zona waktu IANA dikenali; teks lain ditolak', () => {
    for (const zone of ['Asia/Jakarta', 'Asia/Makassar', 'Asia/Jayapura', 'UTC']) {
      expect(isValidTimeZone(zone), zone).toBe(true);
    }
    for (const zone of ['', 'WIB', 'Mars/Olympus', 'Asia/Jakarta; drop', 'x'.repeat(100)]) {
      expect(isValidTimeZone(zone), zone).toBe(false);
    }
  });

  it('password baru: 10–128 karakter', () => {
    expect(newPasswordSchema.safeParse('kopi-tubruk-senja').success).toBe(true);
    expect(messagesOf(newPasswordSchema.safeParse('pendek123'))).toEqual([
      'Password minimal 10 karakter.',
    ]);
    expect(messagesOf(newPasswordSchema.safeParse('a'.repeat(129)))).toEqual([
      'Password maksimal 128 karakter.',
    ]);
    // Spasi di tepi password TIDAK dipangkas (bagian sah dari password).
    expect(newPasswordSchema.parse('  kopi tubruk  ')).toBe('  kopi tubruk  ');
  });
});

describe('kontrak autentikasi', () => {
  const session = {
    status: 'authenticated',
    user: {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      name: 'Sari',
      email: 'sari@contoh.test',
      role: 'owner',
    },
    organization: {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
      name: 'PT Maju Jaya',
      timezone: 'Asia/Jakarta',
    },
    csrfToken: 'token',
    session: {
      idleExpiresAt: '2026-11-13T12:00:00.000Z',
      absoluteExpiresAt: '2026-12-13T00:00:00.000Z',
    },
  };

  it('respons login dibedakan lewat `status`; kolom di luar kontrak dibuang', () => {
    const parsed = loginResponseSchema.parse({
      ...session,
      user: { ...session.user, passwordHash: '$argon2id$bocor', lockedUntil: null },
      tokenHash: 'bocor',
    });

    expect(parsed).toEqual(session);
    expect(JSON.stringify(parsed)).not.toContain('bocor');
    expect(loginResponseSchema.safeParse({ ...session, status: 'lainnya' }).success).toBe(false);
    expect(authenticatedSessionSchema.safeParse({ ...session, csrfToken: undefined }).success).toBe(
      false,
    );
  });

  it('permintaan login membakukan email dan tidak menerapkan aturan password baru', () => {
    expect(loginRequestSchema.parse({ email: ' Sari@Contoh.Test', password: 'x' })).toEqual({
      email: 'sari@contoh.test',
      password: 'x',
    });
    expect(loginRequestSchema.safeParse({ email: 'sari@contoh.test', password: '' }).success).toBe(
      false,
    );
    expect(
      loginRequestSchema.safeParse({ email: 'sari@contoh.test', password: 'a'.repeat(1025) })
        .success,
    ).toBe(false);
  });

  it('semua alamat API berawalan /api/v1 dan tidak ada yang kembar', () => {
    const urls = Object.values(API_ROUTES).flatMap((group) => Object.values(group));

    expect(urls.length).toBeGreaterThanOrEqual(15);
    expect(new Set(urls).size).toBe(urls.length);
    // Segmen huruf kecil, atau parameter `:nama` (diisi `apiPath`) — tidak pernah token.
    // `:file` = nama ikon merek dari daftar tetap `BRAND_ICON_FILES`.
    for (const url of urls) {
      expect(url).toMatch(/^\/api\/v1(?:\/(?:[a-z0-9-]+|:[A-Za-z]+Id|:template|:file))+$/);
    }
  });
});

describe('branding', () => {
  it('warna heksadesimal 6 digit, dibakukan ke huruf kecil', () => {
    expect(brandColorSchema.parse(' #1B3557 ')).toBe('#1b3557');
    for (const value of ['1b3557', '#fff', '#1b35570', 'merah', '#gggggg', 'rgb(0,0,0)']) {
      expect(brandColorSchema.safeParse(value).success, value).toBe(false);
    }
  });

  it('logo: hanya PNG/JPEG/WebP, base64 murni, dan dibatasi ukurannya', () => {
    const ok = { contentType: 'image/png', dataBase64: 'iVBORw0KGgo=' };

    expect(logoUploadSchema.safeParse(ok).success).toBe(true);
    expect(logoUploadSchema.safeParse({ ...ok, contentType: 'image/svg+xml' }).success).toBe(false);
    expect(logoUploadSchema.safeParse({ ...ok, contentType: 'image/gif' }).success).toBe(false);
    expect(
      logoUploadSchema.safeParse({ ...ok, dataBase64: 'data:image/png;base64,iVBORw0KGgo=' })
        .success,
    ).toBe(false);
    expect(logoUploadSchema.safeParse({ ...ok, dataBase64: '' }).success).toBe(false);
    const tooLarge = 'A'.repeat(Math.ceil(LOGO_MAX_BYTES / 3) * 4 + 4);
    expect(messagesOf(logoUploadSchema.safeParse({ ...ok, dataBase64: tooLarge }))).toEqual([
      'Ukuran logo maksimal 256 KB. Perkecil gambarnya lalu coba lagi.',
    ]);
  });
});

describe('email pengirim', () => {
  const input = {
    fromName: 'Balesin Maju Jaya',
    fromAddress: 'CS@MajuJaya.co.id',
    host: 'Mail.MajuJaya.co.id',
    port: 465,
    security: 'ssl',
    username: 'cs@majujaya.co.id',
    password: 'app-password',
  };

  it('tiga pilihan keamanan dengan label dan port lazimnya (PENGATURAN-UI §1)', () => {
    expect(SMTP_SECURITY_MODES).toEqual(['ssl', 'starttls', 'none']);
    expect(SMTP_SECURITY_LABELS).toEqual({
      ssl: 'SSL/TLS',
      starttls: 'STARTTLS',
      none: 'Tanpa enkripsi',
    });
    expect(SMTP_DEFAULT_PORTS).toEqual({ ssl: 465, starttls: 587, none: 25 });
    for (const port of Object.values(SMTP_DEFAULT_PORTS)) {
      expect(SMTP_ALLOWED_PORTS).toContain(port);
    }
  });

  it('empat preset: cPanel/IDCloudHost, Gmail, Outlook, Lainnya', () => {
    expect(SMTP_PRESETS.map((preset) => preset.id)).toEqual([
      'cpanel',
      'gmail',
      'outlook',
      'other',
    ]);
    expect(applySmtpPreset('cpanel', 'CS@MajuJaya.co.id')).toEqual({
      host: 'mail.majujaya.co.id',
      port: 465,
      security: 'ssl',
    });
    expect(applySmtpPreset('gmail', 'toko@gmail.com')).toEqual({
      host: 'smtp.gmail.com',
      port: 587,
      security: 'starttls',
    });
    expect(applySmtpPreset('outlook', 'cs@contoh.test')).toEqual({
      host: 'smtp.office365.com',
      port: 587,
      security: 'starttls',
    });
    expect(applySmtpPreset('other', 'cs@contoh.test')).toEqual({
      host: null,
      port: null,
      security: null,
    });
    // Alamat belum lengkap: host cPanel belum bisa diturunkan.
    expect(applySmtpPreset('cpanel', 'cs@').host).toBeNull();
    expect(SMTP_PRESETS.find((preset) => preset.id === 'gmail')?.requiresAppPassword).toBe(true);
    for (const preset of SMTP_PRESETS) {
      expect(preset.hint, preset.id).not.toMatch(/\bAnda\b/i);
      for (const port of preset.port === null ? [] : [preset.port]) {
        expect(SMTP_ALLOWED_PORTS).toContain(port);
      }
    }
  });

  it('domain email diambil dengan aman', () => {
    expect(emailDomainOf('CS@MajuJaya.co.id')).toBe('majujaya.co.id');
    expect(emailDomainOf('a@b@contoh.test')).toBe('contoh.test');
    for (const value of [
      '',
      'tanpa-at',
      '@contoh.test',
      'cs@',
      'cs@localhost',
      'cs@-x.test',
      'cs@a b.test',
    ]) {
      expect(emailDomainOf(value), value).toBeNull();
    }
  });

  it('host: nama server atau IP saja — tanpa skema, port, path, atau spasi', () => {
    for (const host of [
      'mail.contoh.co.id',
      'smtp-relay.gmail.com',
      '10.0.0.5',
      'localhost',
      '2001:db8::25',
    ]) {
      expect(isValidSmtpHost(host), host).toBe(true);
    }
    for (const host of [
      '',
      'http://mail.contoh.test',
      'mail.contoh.test/smtp',
      'mail.contoh.test:465',
      'mail contoh.test',
      '-mail.contoh.test',
      'mail..contoh.test',
      'mail.contoh.test?x=1',
      'user@mail.contoh.test',
      'a'.repeat(254),
    ]) {
      expect(isValidSmtpHost(host), host).toBe(false);
    }
  });

  it('isian form dibakukan; password tidak pernah dipangkas', () => {
    const parsed = emailSettingsInputSchema.parse({ ...input, password: ' sandi dengan spasi ' });

    expect(parsed).toMatchObject({
      fromAddress: 'cs@majujaya.co.id',
      host: 'mail.majujaya.co.id',
      password: ' sandi dengan spasi ',
    });
    expect(
      emailSettingsInputSchema.parse({ ...input, username: null, password: undefined }),
    ).toMatchObject({ username: null });
  });

  it.each([
    ['fromName kosong', { fromName: ' ' }, 'fromName'],
    ['fromName berisi baris baru', { fromName: 'A\r\nBcc: x@y.z' }, 'fromName'],
    ['fromAddress bukan email', { fromAddress: 'cs' }, 'fromAddress'],
    ['replyTo bukan email', { replyTo: 'x' }, 'replyTo'],
    ['port nol', { port: 0 }, 'port'],
    ['port pecahan', { port: 465.5 }, 'port'],
    ['port teks', { port: '465' }, 'port'],
    ['keamanan tak dikenal', { security: 'tls' }, 'security'],
    ['username kosong (bukan null)', { username: '' }, 'username'],
    ['password kosong', { password: '' }, 'password'],
  ])('menolak %s', (_label, change, field) => {
    const result = emailSettingsInputSchema.safeParse({ ...input, ...change });

    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path[0])).toContain(field);
  });

  it('tampilan pengaturan tidak punya isian password — hanya petunjuk tersamar', () => {
    expect(Object.keys(emailSettingsViewSchema.shape)).not.toContain('password');
    const parsed = emailSettingsViewSchema.parse({
      fromName: 'x',
      fromAddress: 'cs@contoh.test',
      replyTo: null,
      host: 'mail.contoh.test',
      port: 465,
      security: 'ssl',
      username: 'cs@contoh.test',
      hasPassword: true,
      passwordHint: '••••1234',
      password: 'bocor',
      passwordEncrypted: 'v1.bocor',
    });
    expect(JSON.stringify(parsed)).not.toContain('bocor');
  });

  it('peringatan "Tanpa enkripsi" + login untuk form (temuan R4)', () => {
    expect(isPlaintextSmtpLogin({ security: 'none', username: 'cs@contoh.test' })).toBe(true);
    expect(isPlaintextSmtpLogin({ security: 'none', username: null })).toBe(false);
    expect(isPlaintextSmtpLogin({ security: 'none', username: '  ' })).toBe(false);
    expect(isPlaintextSmtpLogin({ security: 'starttls', username: 'cs@contoh.test' })).toBe(false);
    expect(SMTP_PLAINTEXT_LOGIN_WARNING).toContain('jaringan lokal');
    expect(SMTP_PLAINTEXT_LOGIN_WARNING).not.toMatch(/\bAnda\b/);
  });

  it('setiap kode hasil tes punya pesan Indonesia yang menjelaskan langkah berikutnya', () => {
    expect(Object.keys(EMAIL_TEST_MESSAGES).sort()).toEqual([...EMAIL_TEST_CODES].sort());
    for (const code of EMAIL_TEST_CODES) {
      const message = EMAIL_TEST_MESSAGES[code];
      expect(message.length, code).toBeGreaterThan(30);
      expect(message, code).toMatch(/\.$/);
      expect(message, code).not.toMatch(/\bAnda\b/i);
    }
    expect(Object.keys(EMAIL_SETTINGS_STATUS_LABELS).sort()).toEqual(
      [...EMAIL_SETTINGS_STATUSES].sort(),
    );
    expect(EMAIL_SETTINGS_STATUS_LABELS).toMatchObject({
      connected: 'Terhubung',
      failed: 'Gagal',
      not_configured: 'Belum diatur',
    });
  });
});

describe('wizard setup', () => {
  const body = {
    setupToken: 'token-setup-0123456789',
    owner: { name: 'Sari Wulandari', email: 'Sari@Contoh.Test', password: 'kopi-tubruk-senja' },
    organization: { name: 'PT Maju Jaya' },
  };

  it('zona waktu bawaan Asia/Jakarta; branding dan email boleh tidak dikirim', () => {
    const parsed = completeSetupRequestSchema.parse(body);

    expect(parsed.organization.timezone).toBe('Asia/Jakarta');
    expect(parsed.owner.email).toBe('sari@contoh.test');
    expect(parsed.branding).toBeUndefined();
    expect(parsed.email).toBeUndefined();
    expect(completeSetupRequestSchema.parse({ ...body, email: null }).email).toBeNull();
  });

  it('nama isian yang salah dilaporkan bertitik (dipakai web untuk menandai langkah wizard)', () => {
    const result = completeSetupRequestSchema.safeParse({
      ...body,
      owner: { ...body.owner, password: 'pendek' },
      branding: { primaryColor: 'merah' },
      email: {
        fromName: 'x',
        fromAddress: 'cs@contoh.test',
        host: 'mail.contoh.test',
        port: 99999,
        security: 'ssl',
      },
    });

    expect(result.error?.issues.map((issue) => issue.path.join('.')).sort()).toEqual([
      'branding.primaryColor',
      'email.port',
      'owner.password',
    ]);
  });

  it('token setup wajib ada di body', () => {
    expect(completeSetupRequestSchema.safeParse({ ...body, setupToken: '' }).success).toBe(false);
    expect(completeSetupRequestSchema.safeParse({ ...body, setupToken: undefined }).success).toBe(
      false,
    );
  });
});

describe('verifikasi dua langkah', () => {
  const sessionFixture = () => ({
    user: {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
      name: 'Sari',
      email: 'sari@contoh.test',
      role: 'owner',
    },
    organization: {
      id: '0190a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5c',
      name: 'PT Maju Jaya',
      timezone: 'Asia/Jakarta',
    },
    csrfToken: 'token',
    session: {
      idleExpiresAt: '2026-11-13T12:30:00.000Z',
      absoluteExpiresAt: '2026-11-13T12:30:00.000Z',
    },
  });

  it('peran wajib 2FA: Owner, Admin, Supervisor', () => {
    expect(USER_ROLES.filter(isTwoFactorRequired)).toEqual(['owner', 'admin', 'supervisor']);
  });

  it('isian kode dibakukan: spasi/tanda hubung dibuang, huruf dikecilkan, jenisnya dikenali', () => {
    expect(twoFactorCodeSchema.parse(' 123 456 ')).toBe('123456');
    expect(twoFactorCodeSchema.parse('ABCDE-FGHJK')).toBe('abcdefghjk');
    expect(twoFactorCodeKind('123456')).toBe('totp');
    expect(twoFactorCodeKind('abcdefghjk')).toBe('backup_code');
    // Karakter yang tidak ada di alfabet kode cadangan (0, 1, i, l, o) dan panjang lain ditolak.
    for (const code of ['12345', '1234567', 'abcdefghjo', 'abcde-fghj']) {
      expect(twoFactorCodeSchema.safeParse(code).success, code).toBe(false);
    }
    expect(messagesOf(twoFactorCodeSchema.safeParse(''))).toEqual(['Kode wajib diisi.']);
    expect(messagesOf(totpCodeSchema.safeParse('abcdefghjk'))).toEqual([
      'Masukkan 6 digit kode dari aplikasi autentikatormu.',
    ]);
    expect(formatBackupCode('ABCDEFGHJK')).toBe('abcde-fghjk');
  });

  it('respons login: tiga varian; tantangan tidak memuat data sesi', () => {
    const challenge = {
      status: 'two_factor_required',
      challengeToken: 'tantangan',
      expiresAt: '2026-11-13T12:05:00.000Z',
      attemptsRemaining: 3,
      methods: ['totp', 'backup_code'],
    };
    expect(loginResponseSchema.parse({ ...challenge, csrfToken: 'bocor' })).toEqual(challenge);
    const enrollment = { ...sessionFixture(), status: 'two_factor_enrollment_required' };
    expect(loginResponseSchema.parse(enrollment)).toEqual(enrollment);
    expect(meResponseSchema.parse(enrollment)).toEqual(enrollment);
    expect(completeSetupResponseSchema.parse(enrollment)).toEqual(enrollment);
    // `me` tidak pernah berupa tantangan.
    expect(meResponseSchema.safeParse(challenge).success).toBe(false);
    expect(authenticatedSessionSchema.safeParse(enrollment).success).toBe(false);
  });

  it('verifikasi dan pendaftaran: kontrak permintaan', () => {
    expect(verifyTwoFactorRequestSchema.parse({ challengeToken: 't', code: '123 456' })).toEqual({
      challengeToken: 't',
      code: '123456',
    });
    expect(verifyTwoFactorRequestSchema.safeParse({ code: '123456' }).success).toBe(false);
    expect(startTwoFactorEnrollmentRequestSchema.parse({})).toEqual({});
    expect(twoFactorReauthRequestSchema.safeParse({ code: '123456' }).success).toBe(false);
    expect(confirmTwoFactorEnrollmentRequestSchema.parse({ code: '654321' })).toEqual({
      code: '654321',
    });
  });
});
