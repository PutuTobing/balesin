import { describe, expect, it } from 'vitest';

import {
  clipForLog,
  MAX_LOGGED_STRING_LENGTH,
  redactSecrets,
  sanitizeText,
  scrubSecretsInJsonLine,
  scrubSecretsInText,
} from './redact';
import { REDACTED } from './secret';

/** Hasil sensor ragam JSON untuk teks yang berada di dalam satu baris log. */
function scrubInsideJsonLine(text: string): string {
  const scrubbed = scrubSecretsInJsonLine(JSON.stringify({ level: 'info', msg: text }));
  return (JSON.parse(scrubbed) as { msg: string }).msg;
}

/**
 * Kedua ragam harus memberi hasil yang sama: nilai string disensor ragam teks, sedangkan
 * pesan yang lolos ke baris log hanya dijaga ragam JSON.
 */
function expectScrubbed(text: string, expected: string): void {
  expect(scrubSecretsInText(text), 'ragam teks').toBe(expected);
  expect(scrubInsideJsonLine(text), 'ragam JSON').toBe(expected);
}

describe('kredensial di URL', () => {
  it('menyensor user:password', () => {
    expectScrubbed(
      'gagal ke postgres://balesin:s4nd1@db:5432/balesin',
      `gagal ke postgres://${REDACTED}@db:5432/balesin`,
    );
    expectScrubbed('redis://:rahasia@localhost:6379', `redis://${REDACTED}@localhost:6379`);
    expectScrubbed('https://budi:sandi@contoh.id/x', `https://${REDACTED}@contoh.id/x`);
  });

  it('password yang memuat @, tanda kutip, atau garis miring terbalik tidak bocor ekornya', () => {
    expectScrubbed(
      'postgres://balesin:p@ss-ekor@db:5432/balesin',
      `postgres://${REDACTED}@db:5432/balesin`,
    );
    expectScrubbed('postgres://u:p"ekor-kutip@h/db', `postgres://${REDACTED}@h/db`);
    expectScrubbed("smtps://u:p'ekor-kutip@mail.contoh.id", `smtps://${REDACTED}@mail.contoh.id`);
    expectScrubbed('redis://u:p\\ekor-miring@h:6379', `redis://${REDACTED}@h:6379`);
    expectScrubbed('https://budi:p"ekor-kutip@contoh.id/x', `https://${REDACTED}@contoh.id/x`);
    expectScrubbed('http://budi:p@ekor@contoh.id:8080/x', `http://${REDACTED}@contoh.id:8080/x`);
  });

  it('tidak mengubah URL biasa, alamat email, dan JSON berisi URL', () => {
    for (const text of [
      'buka https://contoh.com/users/budi@contoh.com lalu kirim ke budi@contoh.com',
      '{"website":"https://contoh.com","email":"cs@contoh.com"}',
      '{"website":"https://contoh.com:8080","email":"cs@contoh.com"}',
      'redis://localhost:6379 dan budi@contoh.com',
    ]) {
      expectScrubbed(text, text);
    }
  });
});

describe('header', () => {
  it('menyensor Bearer/Basic di mana pun', () => {
    expectScrubbed(
      'kirim Bearer abc.def-123_xyz ke upstream',
      `kirim Bearer ${REDACTED} ke upstream`,
    );
    expectScrubbed('basic dXNlcjpwYXNz', `basic ${REDACTED}`);
  });

  it('menyensor isi baris header sensitif sampai akhir baris', () => {
    expectScrubbed('Authorization: Bearer abc.def-123_xyz', `Authorization: ${REDACTED}`);
    expectScrubbed(
      'Cookie: balesin_sid=sesi-rahasia; tema=gelap\nHost: contoh.id',
      `Cookie: ${REDACTED}\nHost: contoh.id`,
    );
    expectScrubbed('X-Api-Key: kunci-polos-tanpa-pola', `X-Api-Key: ${REDACTED}`);
    expectScrubbed(
      'x-hub-signature-256: sha256=0123456789abcdef0123456789abcdef',
      `x-hub-signature-256: ${REDACTED}`,
    );
  });

  it('menyensor header hasil util.inspect', () => {
    const scrubbed = scrubSecretsInText(
      "headers: { host: 'x', cookie: 'sid=nilai-cookie', 'set-cookie': [ 'sid=nilai-baru' ] }",
    );

    expect(scrubbed).toBe(`headers: { host: 'x', cookie: ${REDACTED}`);
  });

  it('menyensor tanda tangan HMAC di luar header', () => {
    expectScrubbed(
      'tanda sha256=0123456789abcdef0123456789abcdef tidak cocok',
      `tanda sha256=${REDACTED} tidak cocok`,
    );
  });
});

describe('kunci=nilai', () => {
  it('menyensor parameter rahasia, termasuk yang berawalan', () => {
    expectScrubbed(
      'GET /webhooks/whatsapp/1?hub.mode=subscribe&hub.verify_token=tokenku&hub.challenge=42',
      `GET /webhooks/whatsapp/1?hub.mode=subscribe&hub.verify_token=${REDACTED}&hub.challenge=42`,
    );
    expectScrubbed(
      'https://graph.facebook.com/v1/me?access_token=XYZ123&x=1',
      `https://graph.facebook.com/v1/me?access_token=${REDACTED}&x=1`,
    );
    expectScrubbed(
      'old_password=lama123456&new_password=baru123456&nama=budi',
      `old_password=${REDACTED}&new_password=${REDACTED}&nama=budi`,
    );
    expectScrubbed(
      '/undangan?invite_token=abc&page=2',
      `/undangan?invite_token=${REDACTED}&page=2`,
    );
    expectScrubbed('appsecret_proof=deadbeef&fields=id', `appsecret_proof=${REDACTED}&fields=id`);
  });

  it('menyensor nilai yang diapit tanda kutip (conninfo, atribut)', () => {
    expectScrubbed(
      `host=db user=balesin password="dua kata rahasia" dbname=x`,
      `host=db user=balesin password="${REDACTED}" dbname=x`,
    );
    expectScrubbed(
      `host=db password='dua kata rahasia' dbname=x`,
      `host=db password='${REDACTED}' dbname=x`,
    );
  });

  it('kunci yang bukan rahasia tidak menyembunyikan rahasia di dalam nilainya', () => {
    expectScrubbed(
      'url="https://x.id/cb?token=abc123&a=1" status=ok',
      `url="https://x.id/cb?token=${REDACTED}&a=1" status=ok`,
    );
  });

  it('menyensor kode otorisasi OAuth di query string, bukan kata "code" di tempat lain', () => {
    expectScrubbed(
      'https://x.id/cb?code=KODEOAUTH123&state=s',
      `https://x.id/cb?code=${REDACTED}&state=s`,
    );
    expectScrubbed('proses keluar dengan code=1', 'proses keluar dengan code=1');
  });
});

describe('token berpola', () => {
  it('menyensor token Meta, API key Balesin, dan token bot Telegram', () => {
    const metaToken = `EAAG${'a1B2c3D4'.repeat(6)}`;
    expectScrubbed(`akses ${metaToken} ditolak`, `akses ${REDACTED} ditolak`);
    expectScrubbed('kunci blsn_live01_abcdefghijklmnop', `kunci blsn_live01_${REDACTED}`);
    expectScrubbed(
      'https://api.telegram.org/bot123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw/sendMessage',
      `https://api.telegram.org/bot123456789:${REDACTED}/sendMessage`,
    );
    expectScrubbed(
      'token 123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw salah',
      `token 123456789:${REDACTED} salah`,
    );
  });

  it('tidak salah tangkap jam, port, atau ID biasa', () => {
    for (const text of [
      'selesai 2026-11-13T05:31:26.563Z di 127.0.0.1:5432',
      'pesanan 12345678: menunggu pembayaran',
      'EAA pendek dan blsn_x bukan kunci',
    ]) {
      expectScrubbed(text, text);
    }
  });
});

describe('pesan error yang mengulang data', () => {
  it('parameter query Drizzle', () => {
    expectScrubbed(
      'Failed query: insert into "users" values ($1, $2)\nparams: budi@x.com,hash-rahasia',
      `Failed query: insert into "users" values ($1, $2)\nparams: ${REDACTED}`,
    );
  });

  it('di baris JSON, sensor parameter berhenti di akhir string-nya saja', () => {
    const line = JSON.stringify({
      a: 'Failed query: select 1',
      msg: 'Failed query: select "a" from "t" where "x" = $1\nparams: nilai "berkutip", lain',
      b: 'baris lain\nparams: bukan parameter query',
      c: 'tetap',
    });

    const parsed = JSON.parse(scrubSecretsInJsonLine(line)) as Record<string, string>;

    expect(parsed).toEqual({
      a: 'Failed query: select 1',
      msg: `Failed query: select "a" from "t" where "x" = $1\nparams: ${REDACTED}`,
      b: 'baris lain\nparams: bukan parameter query',
      c: 'tetap',
    });
  });

  it('argumen perintah yang diulang Redis ("unknown command … with args beginning with")', () => {
    expectScrubbed(
      "ERR unknown command 'HELLO', with args beginning with: '3' 'AUTH' 'default' 'sandi-redis'\n    at x",
      `ERR unknown command 'HELLO', with args beginning with: ${REDACTED}\n    at x`,
    );
  });

  it('nilai yang diulang Postgres saat gagal mengubah tipe', () => {
    expectScrubbed(
      'invalid input syntax for type uuid: "token-nyasar"\n    at Parser.parse (pg.js:1:1)',
      `invalid input syntax for type uuid: ${REDACTED}\n    at Parser.parse (pg.js:1:1)`,
    );
    expectScrubbed(
      'invalid input value for enum user_role: "superadmin-rahasia"',
      `invalid input value for enum user_role: ${REDACTED}`,
    );
  });
});

describe('pasangan JSON di dalam teks', () => {
  const payload = {
    user: 'budi',
    password: 'sandi-json',
    access_token: 'token-json',
    pin: 123456,
    hasToken: true,
    refreshToken: null,
    note: 'bukan rahasia',
  };
  const expected = {
    user: 'budi',
    password: REDACTED,
    access_token: REDACTED,
    pin: REDACTED,
    hasToken: true,
    refreshToken: null,
    note: 'bukan rahasia',
  };

  it('JSON mentah', () => {
    const scrubbed = scrubSecretsInText(JSON.stringify(payload));

    expect(JSON.parse(scrubbed)).toEqual(expected);
  });

  it('JSON di dalam string JSON (satu dan dua tingkat escape) tetap sah setelah disensor', () => {
    const once = JSON.stringify({ body: JSON.stringify(payload) });
    const twice = JSON.stringify({ event: once });

    const scrubbedOnce = JSON.parse(scrubSecretsInText(once)) as { body: string };
    const scrubbedTwice = JSON.parse(scrubSecretsInText(twice)) as { event: string };

    expect(JSON.parse(scrubbedOnce.body)).toEqual(expected);
    expect(JSON.parse((JSON.parse(scrubbedTwice.event) as { body: string }).body)).toEqual(
      expected,
    );
    for (const text of [scrubSecretsInText(once), scrubSecretsInText(twice)]) {
      expect(text).not.toContain('sandi-json');
      expect(text).not.toContain('token-json');
      expect(text).not.toContain('123456');
    }
  });

  it('nilai yang memuat tanda kutip dan garis miring terbalik disensor utuh', () => {
    const tricky = { token: 'awal"tengah\\akhir', next: 'aman' };

    for (const text of [JSON.stringify(tricky), JSON.stringify({ raw: JSON.stringify(tricky) })]) {
      const scrubbed = scrubSecretsInText(text);
      expect(scrubbed).not.toContain('awal');
      expect(scrubbed).not.toContain('tengah');
      expect(scrubbed).not.toContain('akhir');
      expect(scrubbed).toContain('aman');
      expect(() => JSON.parse(scrubbed) as unknown).not.toThrow();
    }
  });

  it('di baris log, pasangan struktural dan pasangan di dalam pesan sama-sama tertangani', () => {
    const line = JSON.stringify({
      level: 'info',
      pin: 1234,
      msg: `balasan upstream: ${JSON.stringify(payload)}`,
      raw: JSON.stringify({ raw: JSON.stringify(payload) }),
    });

    const scrubbed = scrubSecretsInJsonLine(line);
    const parsed = JSON.parse(scrubbed) as { level: string; pin: string; msg: string };

    expect(parsed.level).toBe('info');
    expect(parsed.pin).toBe(REDACTED);
    expect(JSON.parse(parsed.msg.replace('balasan upstream: ', ''))).toEqual(expected);
    expect(scrubbed).not.toContain('sandi-json');
    expect(scrubbed).not.toContain('token-json');
  });

  it('objek di bawah kunci rahasia tidak dirusak; kunci rahasia di dalamnya tetap disensor', () => {
    const scrubbed = scrubSecretsInText('{"credentials":{"user":"u","pass":"p-rahasia"},"a":1}');

    expect(JSON.parse(scrubbed)).toEqual({ credentials: { user: 'u', pass: REDACTED }, a: 1 });
  });

  it('array di bawah kunci rahasia diganti satu elemen tersensor, di tingkat escape berapa pun', () => {
    const payload = {
      password: ['satu-rahasia', 'dua "kutip" ] kurung', 3],
      tokens: [{ nilai: 'objek-rahasia' }, ['bersarang-rahasia']],
      daftar: ['bukan', 'sensitif'],
      kosong: { token: [] },
    };
    const expected = {
      password: [REDACTED],
      tokens: [REDACTED],
      daftar: ['bukan', 'sensitif'],
      kosong: { token: [] },
    };
    const raw = JSON.stringify(payload);
    const once = JSON.stringify({ body: raw });

    expect(JSON.parse(scrubSecretsInText(raw))).toEqual(expected);
    const scrubbedOnce = JSON.parse(scrubSecretsInText(once)) as { body: string };
    expect(JSON.parse(scrubbedOnce.body)).toEqual(expected);
    const inLine = JSON.parse(scrubSecretsInJsonLine(JSON.stringify({ msg: raw }))) as {
      msg: string;
    };
    expect(JSON.parse(inLine.msg)).toEqual(expected);
    for (const text of [scrubSecretsInText(raw), scrubSecretsInText(once)]) {
      expect(text).not.toMatch(/rahasia|kutip|bersarang/);
    }
  });

  it('array yang tidak tertutup disensor sampai batas string pembungkusnya saja', () => {
    const line = JSON.stringify({ msg: '{"password":["rahasia-terpotong', next: 'tetap' });

    const parsed = JSON.parse(scrubSecretsInJsonLine(line)) as { msg: string; next: string };

    expect(parsed.msg).toBe(`{"password":["${REDACTED}"`);
    expect(parsed.next).toBe('tetap');
  });

  it('kunci struktural yang namanya berakhiran garis miring terbalik tidak merusak baris log', () => {
    for (const value of [1234, ['a', 2], 'teks', [1, 'x']]) {
      for (const slashes of [1, 2, 3]) {
        const key = `password${'\\'.repeat(slashes)}`;
        const line = JSON.stringify({ level: 'info', [key]: value, next: 'tetap' });

        const scrubbed = scrubSecretsInJsonLine(line);

        const parsed = JSON.parse(scrubbed) as Record<string, unknown>;
        expect(Object.keys(parsed), line).toEqual(['level', key, 'next']);
        expect(parsed.next).toBe('tetap');
      }
    }
  });
});

describe('kunci: nilai', () => {
  it('menyensor header apa pun yang namanya berbau rahasia, sampai akhir baris', () => {
    expectScrubbed(
      'X-Auth-Token: nilai rahasia berspasi\nHost: contoh.id',
      `X-Auth-Token: ${REDACTED}\nHost: contoh.id`,
    );
    expectScrubbed(
      'x-telegram-bot-api-secret-token: abc123',
      `x-telegram-bot-api-secret-token: ${REDACTED}`,
    );
  });

  it('menyensor gaya YAML/prosa, dengan atau tanpa spasi setelah titik dua', () => {
    expectScrubbed('password: dua kata, tiga\nuser: budi', `password: ${REDACTED}\nuser: budi`);
    expectScrubbed('gagal karena token:abc123def', `gagal karena token:${REDACTED}`);
    expectScrubbed('sid:   nilai-sesi', `sid:   ${REDACTED}`);
  });

  it('hasil util.inspect: hanya isi nilai berkutip yang diganti, sisanya tetap terbaca', () => {
    expectScrubbed(
      "{ access_token: 'nilai-rahasia', expires_in: 3600, scope: 'baca' }",
      `{ access_token: '${REDACTED}', expires_in: 3600, scope: 'baca' }`,
    );
    expectScrubbed(
      `{ 'client-secret': 'kunci-rahasia', refreshToken: "token rahasia", id: 7 }`,
      `{ 'client-secret': '${REDACTED}', refreshToken: "${REDACTED}", id: 7 }`,
    );
    expectScrubbed(
      "{ password: [ 'a-rahasia', 'b-rahasia' ], user: 'budi' }",
      `{ password: ${REDACTED}`,
    );
  });

  it('nomor baris, port, dan jam bukan penugasan: stack dan alamat tidak dirusak', () => {
    for (const text of [
      '    at verifyToken (/app/src/auth/token.service.ts:42:7)',
      '    at hash (C:\\app\\src\\password.ts:12:3)',
      'menyambung ke secret-store.internal:8443/v1 dan cookie-cache:6379',
      'file:///app/dist/session-token.repo.js:101',
    ]) {
      expectScrubbed(text, text);
    }
    // Pembanding: kunci yang sama diikuti teks (bukan angka) tetap disensor.
    expectScrubbed('jadwal reset-password: besok pagi', `jadwal reset-password: ${REDACTED}`);
    expectScrubbed('kode pin:1234a', `kode pin:${REDACTED}`);
  });

  it('kunci yang bukan rahasia tidak disentuh', () => {
    for (const text of [
      'status: aktif, pengguna: budi, percobaan: 3',
      "{ user: 'budi', role: 'cs', side: 'kiri' }",
      'Catatan: pelanggan minta dihubungi pukul 10:30',
    ]) {
      expectScrubbed(text, text);
    }
  });

  it('pasangan JSON struktural tidak terpengaruh aturan titik dua', () => {
    const line = JSON.stringify({ level: 'info', author: 'x', note: 'isi: biasa', count: 3 });

    expect(scrubSecretsInJsonLine(line)).toBe(line);
  });
});

describe('kunci panjang', () => {
  it('kunci rahasia tetap dikenali walau didahului deretan karakter kunci yang sangat panjang', () => {
    const prefix = 'a'.repeat(500);

    expectScrubbed(`${prefix}_token=nilai-rahasia&x=1`, `${prefix}_token=${REDACTED}&x=1`);
    expectScrubbed(`${prefix}-password: nilai rahasia`, `${prefix}-password: ${REDACTED}`);
  });

  it('yang dinilai hanya 64 karakter terakhir sebelum pemisah', () => {
    const text = `token${'a'.repeat(64)}=bukan-rahasia`;

    expectScrubbed(text, text);
  });
});

describe('sifat umum', () => {
  it('idempoten', () => {
    for (const text of [
      'postgres://a:b@h/db?password=x Bearer abcdefghij',
      'Cookie: a=b\npassword="x y" token=z',
      JSON.stringify({ raw: JSON.stringify({ password: 'x', pin: 1 }) }),
      'Failed query: select 1\nparams: a,b',
    ]) {
      const once = scrubSecretsInText(text);
      expect(scrubSecretsInText(once)).toBe(once);
      const line = scrubSecretsInJsonLine(JSON.stringify({ msg: text }));
      expect(scrubSecretsInJsonLine(line)).toBe(line);
    }
  });

  it('teks biasa tidak berubah', () => {
    const text =
      'Pelanggan 628123456789 bertanya: "tagihan bulan ini berapa?" (tiket #42, 13:05, 50% diskon)';
    expectScrubbed(text, text);
  });

  /** PRNG kecil berbiji tetap supaya tes berulang dengan masukan yang sama. */
  function createRandom(seed: number): () => number {
    let state = seed;
    return () => {
      state = (state + 0x6d2b79f5) | 0;
      let t = Math.imul(state ^ (state >>> 15), 1 | state);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
    };
  }

  const FRAGMENTS = [
    '"',
    '\\',
    "'",
    ':',
    '=',
    '@',
    ',',
    '{',
    '}',
    ' ',
    '\n',
    '://',
    'password',
    'token',
    'pin',
    'cookie:',
    'Bearer ',
    'postgres://u:',
    'https://x',
    'Failed query: ',
    '\nparams: ',
    'with args beginning with:',
    'invalid input syntax for type x: ',
    '123456789:',
    'abc',
    '42',
    '\u2028',
    '[',
    ']',
    'token: ',
    "password: '",
    'sid:',
    '\r',
    '\t',
  ];

  it('baris log SELALU tetap JSON yang sah dengan kunci tingkat atas yang sama (2.000 masukan acak)', () => {
    const random = createRandom(20261113);
    for (let round = 0; round < 2_000; round += 1) {
      let text = '';
      const length = 1 + Math.floor(random() * 14);
      for (let part = 0; part < length; part += 1) {
        text += FRAGMENTS[Math.floor(random() * FRAGMENTS.length)] ?? '';
      }
      const nested = JSON.stringify({ k: text, password: [text, 5], pin: 1234, token: text });
      const line = JSON.stringify({ level: 'info', a: text, n: [text, 7], raw: nested, msg: text });

      const scrubbed = scrubSecretsInJsonLine(line);

      let parsed: Record<string, unknown> | undefined;
      try {
        parsed = JSON.parse(scrubbed) as Record<string, unknown>;
      } catch {
        // dilaporkan lewat expect di bawah, lengkap dengan masukannya
      }
      expect(parsed, `baris rusak untuk masukan ${JSON.stringify(text)}`).toBeDefined();
      expect(Object.keys(parsed ?? {}), JSON.stringify(text)).toEqual([
        'level',
        'a',
        'n',
        'raw',
        'msg',
      ]);
      expect(parsed?.level).toBe('info');
    }
  });
});

describe('batas panjang', () => {
  it('teks yang sangat panjang dipotong sebelum masuk log', () => {
    const long = 'x'.repeat(MAX_LOGGED_STRING_LENGTH + 5_000);

    const clipped = clipForLog(long);

    expect(clipped.length).toBeLessThan(MAX_LOGGED_STRING_LENGTH + 100);
    expect(clipped).toContain(`dipotong dari ${long.length} karakter`);
    expect(clipForLog('pendek')).toBe('pendek');
    expect(sanitizeText(`${long} token=rahasia-di-ekor`)).not.toContain('rahasia-di-ekor');
  });

  /** Teks pengisi tanpa pola rahasia dan tanpa huruf (batas kata tetap ada), tepat `length` karakter. */
  const filler = (length: number): string => '. '.repeat(Math.ceil(length / 2)).slice(0, length);
  const metaToken = `EAAG${'a1B2c3D4'.repeat(6)}`;
  const telegramToken = '123456789:AAHdqTcvCH1vGWJxfSeofSAs0K5PALDsaw';

  it('rahasia yang melintasi batas potong tidak menyisakan awalan, di posisi mana pun', () => {
    for (const secret of [
      metaToken,
      telegramToken,
      'Bearer abcdefghijklmnop',
      'blsn_live_abcdefgh',
    ]) {
      for (let before = 1; before < secret.length; before += 1) {
        const text = `${filler(MAX_LOGGED_STRING_LENGTH - before)}${secret} ${filler(3_000)}`;

        const output = sanitizeText(text);

        // 8 karakter terakhir rahasia tidak pernah berada di sisi yang terlihat…
        expect(output, `${secret} / ${before}`).not.toContain(secret.slice(-8));
        // …dan bagian yang terlihat tidak memuat awalan rahasianya (≥ 12 karakter).
        const visibleSecret = secret.slice(secret.indexOf(':') + 1).slice(0, 12);
        if (visibleSecret.length === 12 && !secret.startsWith('Bearer')) {
          expect(output, `${secret} / ${before}`).not.toContain(visibleSecret);
        }
        expect(output).toContain('dipotong dari');
      }
    }
  });

  it('rahasia di ujung jendela sensor tidak bergeser masuk saat teks di depannya memendek', () => {
    // Nilai berkutip 3.000 karakter disensor jadi belasan karakter, sehingga semua teks
    // sesudahnya bergeser ±3.000 karakter ke depan — termasuk ekor jendela sensor.
    const shrinking = `password="${'p'.repeat(3_000)}" `;
    for (const secret of [metaToken, telegramToken, 'postgres://balesin:sandi-di-ujung-jendela']) {
      for (const cutAt of [1, 5, 10, 21, 29, 40]) {
        const windowLength = MAX_LOGGED_STRING_LENGTH + 1_024;
        const before = filler(windowLength - shrinking.length - cutAt);
        // `cutAt` karakter pertama rahasia berada di dalam jendela, sisanya di luar.
        const text = `${shrinking}${before}${secret}@db ${filler(2_000)}`;

        const output = sanitizeText(text);

        expect(output, `${secret} / ${cutAt}`).not.toContain(secret.slice(0, Math.max(cutAt, 4)));
        expect(output).not.toContain('ppp');
      }
    }
  });

  it('teks sedikit di atas batas (seluruhnya masuk jendela) tetap disensor utuh lalu dipotong', () => {
    const text = `${filler(MAX_LOGGED_STRING_LENGTH - 5)}${metaToken} ekor`;

    const output = sanitizeText(text);

    expect(output).not.toContain('EAAG');
    expect(output).toContain(`dipotong dari ${text.length} karakter`);
  });

  it('redactSecrets memotong nilai string di kedalaman berapa pun', () => {
    const long = 'isi pesan pelanggan '.repeat(5_000);

    const output = redactSecrets({ pesan: { isi: long, daftar: [long] } }) as {
      pesan: { isi: string; daftar: string[] };
    };

    expect(output.pesan.isi.length).toBeLessThan(MAX_LOGGED_STRING_LENGTH + 100);
    expect(output.pesan.daftar[0]?.length).toBeLessThan(MAX_LOGGED_STRING_LENGTH + 100);
  });
});

describe('waktu sensor linear terhadap panjang teks', () => {
  // Tiap masukan ±300 KB dan dirancang memancing pola tertentu agar terus "hampir cocok".
  // Implementasi linear menyelesaikannya dalam beberapa milidetik; yang kuadratik butuh
  // puluhan detik. Batas 1 detik longgar untuk mesin CI yang lambat, tetapi tetap menangkap
  // kemunduran ke perilaku kuadratik.
  const SIZE = 300_000;
  const LIMIT_MS = 1_000;

  const repeatTo = (unit: string): string => unit.repeat(Math.ceil(SIZE / unit.length));

  /** Puluhan ribu nama kunci yang semuanya berbeda: cache hasil pemeriksaan kunci tidak membantu. */
  function hostileDistinctKeys(): string {
    const parts: string[] = [];
    for (let index = 0, length = 0; length < SIZE; index += 1) {
      const part = `k${index.toString(36)}: v${index.toString(36)}=x `;
      parts.push(part);
      length += part.length;
    }
    return parts.join('');
  }

  const hostile: Array<[label: string, text: string]> = [
    ['"Failed query: " berulang', repeatTo('Failed query: ')],
    ['"Failed query: " + penanda params berulang', repeatTo('Failed query: x\nparams: ')],
    ['kepala pasangan JSON berulang', repeatTo('"a":')],
    ['kunci rahasia JSON tanpa nilai', repeatTo('"password":')],
    ['nilai JSON rahasia tak tertutup', repeatTo('"password":"')],
    ['tanda kutip berulang', repeatTo('"')],
    ['garis miring terbalik berulang', repeatTo('\\')],
    ['kunci JSON diikuti garis miring terbalik panjang', `"password${repeatTo('\\')}`],
    ['nilai JSON berisi garis miring terbalik panjang', `"password":"${repeatTo('\\')}`],
    ['kunci JSON diikuti spasi panjang', `"password"${repeatTo(' ')}`],
    ['kunci JSON 64 karakter berulang', repeatTo(`"${'k'.repeat(64)}`)],
    ['skema URL berulang', repeatTo('a://')],
    ['skema URL + user berulang', repeatTo('pg://u:')],
    ['URL http + user berulang', repeatTo('https://u:')],
    ['URL http tanpa @ yang sangat panjang', `https://u:${repeatTo('x')}`],
    ['URL tanpa @ yang sangat panjang', `pg://u:${repeatTo('x')}`],
    ['URL dengan banyak @', `pg://u:${repeatTo('@')}`],
    ['titik berulang (batas kata rapat)', repeatTo('a.')],
    ['token= berulang', repeatTo('token=')],
    ['token=" berulang', repeatTo('token="')],
    ["token=' berulang", repeatTo("token='")],
    ['kunci bukan rahasia berulang', repeatTo('a=')],
    ['kata panjang tanpa "="', repeatTo('k')],
    ['Bearer berulang', repeatTo('Bearer ')],
    ['Bearer diikuti spasi panjang', `Bearer${repeatTo(' ')}`],
    ['cookie: berulang', repeatTo('cookie: ')],
    ['cookie diikuti spasi panjang', `cookie${repeatTo(' ')}`],
    ['penanda argumen Redis berulang', repeatTo('with args beginning with:')],
    ['pesan Postgres berulang', repeatTo('invalid input syntax for ')],
    ['awalan token Telegram berulang', repeatTo('1234567:')],
    ['awalan token Meta berulang', repeatTo('EAA')],
    ['awalan API key berulang', repeatTo('blsn_a_')],
    ['sha256= berulang', repeatTo('sha256=')],
    ['titik dua berulang', repeatTo(':')],
    ['kunci pendek + titik dua berulang', repeatTo('ab:')],
    ['kunci 64 karakter + titik dua berulang', repeatTo(`${'k'.repeat(64)}:`)],
    ['token: berulang (satu baris)', repeatTo('token: ')],
    ['token: berulang (banyak baris)', repeatTo('token:\n')],
    ['token: diikuti spasi panjang', `token:${repeatTo(' ')}`],
    ["token: ' berulang", repeatTo("token: '")],
    ['token:123 berulang (mirip nomor baris)', repeatTo('token:123 ')],
    ['banyak kunci berbeda (cache kunci penuh)', hostileDistinctKeys()],
    ['array rahasia terbuka berulang', repeatTo('"password":[')],
    ['array rahasia berisi string terbuka', repeatTo('"password":["')],
    ['array rahasia bersarang dalam', `"password":${repeatTo('[')}`],
    ['array rahasia + garis miring terbalik', `"password":["${repeatTo('\\')}`],
    ['spasi saja', repeatTo(' ')],
    ['teks biasa', repeatTo('pelanggan bertanya soal tagihan bulan ini. ')],
  ];

  it.each(hostile)('%s', (_label, text) => {
    const line = JSON.stringify({ level: 'error', msg: text });

    const startedAt = performance.now();
    scrubSecretsInText(text);
    const textMs = performance.now() - startedAt;
    const scrubbedLine = scrubSecretsInJsonLine(line);
    const totalMs = performance.now() - startedAt;

    expect(textMs, 'ragam teks').toBeLessThan(LIMIT_MS);
    expect(totalMs - textMs, 'ragam JSON').toBeLessThan(LIMIT_MS);
    expect(() => JSON.parse(scrubbedLine) as unknown).not.toThrow();
  });

  it('waktu tumbuh sebanding dengan ukuran, bukan kuadratnya', () => {
    const measure = (size: number): number => {
      const line = JSON.stringify({ msg: 'Failed query: '.repeat(size) });
      const startedAt = performance.now();
      for (let round = 0; round < 3; round += 1) scrubSecretsInJsonLine(line);
      return performance.now() - startedAt;
    };
    measure(2_000); // pemanasan JIT

    const small = measure(10_000);
    const large = measure(80_000); // 8× lebih besar

    // Linear: ±8×. Kuadratik: ±64×. Batas 24× memberi ruang untuk derau pengukuran.
    expect(large).toBeLessThan(Math.max(small, 1) * 24);
  });
});
