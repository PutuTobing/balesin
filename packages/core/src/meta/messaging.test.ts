import { describe, expect, it } from 'vitest';

import { Secret } from '../secret';
import { createMetaGraphClient, type MetaGraphClient } from './graph-client';
import { checkOutboundMedia, detectMedia } from './media-sniff';
import { buildOutboundPayload, sendWhatsAppMessage } from './messaging';

const bytes = (...values: number[]) => Uint8Array.from(values);
const text = (value: string) => new TextEncoder().encode(value);
const withHead = (head: Uint8Array) => {
  const full = new Uint8Array(64);
  full.set(head);
  return full;
};

describe('detectMedia (magic bytes, bukan nama berkas)', () => {
  it('mengenali jenis yang didukung WhatsApp', () => {
    expect(detectMedia(bytes(0xff, 0xd8, 0xff, 0xe0))).toEqual({
      mimeType: 'image/jpeg',
      kind: 'image',
    });
    expect(detectMedia(bytes(0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a))?.mimeType).toBe(
      'image/png',
    );
    expect(detectMedia(text('%PDF-1.7 ...'))?.mimeType).toBe('application/pdf');
    expect(detectMedia(text('OggS\u0000\u0002'))?.mimeType).toBe('audio/ogg');
    expect(detectMedia(withHead(text('\u0000\u0000\u0000\u0018ftypmp42')))?.mimeType).toBe(
      'video/mp4',
    );
    expect(detectMedia(withHead(text('\u0000\u0000\u0000\u0018ftypM4A ')))?.mimeType).toBe(
      'audio/mp4',
    );
    expect(detectMedia(withHead(text('\u0000\u0000\u0000\u0018ftyp3gp4')))?.mimeType).toBe(
      'video/3gpp',
    );
    expect(detectMedia(text('RIFF\u0000\u0000\u0000\u0000WEBPVP8 '))?.kind).toBe('sticker');
  });

  it('nama berkas tidak bisa mengubah jenis: HTML/SVG/EXE berkedok PDF/JPG ditolak', () => {
    expect(
      detectMedia(text('<svg xmlns="http://www.w3.org/2000/svg"></svg>'), 'foto.jpg'),
    ).toBeNull();
    expect(detectMedia(text('<!doctype html><script>alert(1)</script>'), 'tagihan.pdf')).toBeNull();
    expect(detectMedia(text('MZ\u0090\u0000'), 'dokumen.pdf')).toBeNull();
  });

  it('ZIP/CFB hanya diterima sebagai dokumen Office sesuai ekstensi; teks hanya .txt UTF-8', () => {
    const zip = bytes(0x50, 0x4b, 0x03, 0x04, 0x14);
    expect(detectMedia(zip, 'laporan.xlsx')?.mimeType).toContain('spreadsheetml');
    expect(detectMedia(zip, 'arsip.zip')).toBeNull();
    expect(detectMedia(zip, 'laporan.docx.exe')).toBeNull();
    expect(detectMedia(text('Halo kak, ini catatan.'), 'catatan.txt')?.mimeType).toBe('text/plain');
    expect(detectMedia(bytes(0x48, 0x00, 0x49), 'biner.txt')).toBeNull();
  });

  it('checkOutboundMedia: batas ukuran Meta per jenis; webp/stiker tidak bisa diunggah', () => {
    const jpeg = detectMedia(bytes(0xff, 0xd8, 0xff));
    expect(checkOutboundMedia(jpeg, 1024)).toEqual({
      ok: true,
      kind: 'image',
      mimeType: 'image/jpeg',
    });
    expect(checkOutboundMedia(jpeg, 6 * 1024 * 1024)).toMatchObject({
      ok: false,
      reason: 'too_large',
    });
    expect(
      checkOutboundMedia(detectMedia(text('RIFF\u0000\u0000\u0000\u0000WEBP')), 10),
    ).toMatchObject({
      ok: false,
      reason: 'unsupported',
    });
    expect(checkOutboundMedia(null, 10)).toMatchObject({ ok: false, reason: 'unsupported' });
  });
});

describe('buildOutboundPayload', () => {
  it('teks + balas-kutip; tanpa pratinjau tautan', () => {
    expect(
      buildOutboundPayload({
        to: '6281234567890',
        content: { type: 'text', text: 'Halo' },
        replyToWamid: 'wamid.A',
      }),
    ).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '6281234567890',
      context: { message_id: 'wamid.A' },
      type: 'text',
      text: { body: 'Halo', preview_url: false },
    });
  });

  it('media: ID Meta saja; keterangan bukan untuk audio; nama berkas hanya dokumen', () => {
    const media = (kind: 'audio' | 'document' | 'image') =>
      buildOutboundPayload({
        to: '62811',
        content: { type: 'media', kind, metaMediaId: '123', caption: 'cap', filename: 'a.pdf' },
        replyToWamid: null,
      });
    expect(media('audio').audio).toEqual({ id: '123' });
    expect(media('document').document).toEqual({ id: '123', caption: 'cap', filename: 'a.pdf' });
    expect(media('image').image).toEqual({ id: '123', caption: 'cap' });
  });

  it('reaksi tanpa context; emoji kosong = hapus reaksi; lokasi', () => {
    expect(
      buildOutboundPayload({
        to: '62811',
        content: { type: 'reaction', targetWamid: 'wamid.T', emoji: '' },
        replyToWamid: 'wamid.X',
      }),
    ).toMatchObject({ type: 'reaction', reaction: { message_id: 'wamid.T', emoji: '' } });
    expect(
      buildOutboundPayload({
        to: '62811',
        content: {
          type: 'location',
          latitude: -7.2,
          longitude: 112.7,
          name: null,
          address: 'Jl. A',
        },
        replyToWamid: null,
      }).location,
    ).toEqual({ latitude: -7.2, longitude: 112.7, address: 'Jl. A' });
  });
});

describe('klien Graph: kirim & unduh', () => {
  const credentials = { accessToken: new Secret('token-uji'), appSecret: new Secret('rahasia') };

  function clientWith(handler: (url: URL, init: RequestInit) => Response): {
    client: MetaGraphClient;
    calls: URL[];
  } {
    const calls: URL[] = [];
    const client = createMetaGraphClient({
      version: 'v26.0',
      fetch: (input, init) => {
        const url = new URL(input instanceof Request ? input.url : String(input));
        calls.push(url);
        return Promise.resolve(handler(url, init ?? {}));
      },
      sleep: () => Promise.resolve(),
    });
    return { client, calls };
  }

  it('kirim pesan TIDAK diulang otomatis saat koneksi putus (cegah pesan ganda)', async () => {
    let attempts = 0;
    const client = createMetaGraphClient({
      version: 'v26.0',
      fetch: () => {
        attempts += 1;
        return Promise.reject(new TypeError('putus'));
      },
      sleep: () => Promise.resolve(),
    });
    await expect(
      sendWhatsAppMessage(client, credentials, '111', {
        to: '62811',
        content: { type: 'text', text: 'x' },
        replyToWamid: null,
      }),
    ).rejects.toMatchObject({ kind: 'network_error' });
    expect(attempts).toBe(1);
  });

  it('unduh hanya dari lookaside.fbsbx.com (https), tanpa mengikuti redirect', async () => {
    const { client, calls } = clientWith((url) =>
      url.pathname === '/redirect'
        ? new Response(null, { status: 302, headers: { location: 'https://evil.test/x' } })
        : new Response(Buffer.from('isi'), { headers: { 'content-type': 'image/jpeg' } }),
    );
    for (const url of [
      'https://evil.test/file',
      'http://lookaside.fbsbx.com/file',
      'https://lookaside.fbsbx.com.evil.test/file',
      'https://user:pass@lookaside.fbsbx.com/file',
      'file:///etc/passwd',
      'http://127.0.0.1:9/file',
    ]) {
      await expect(
        client.download(credentials, { operation: 'media.download', url, maxBytes: 100 }),
      ).rejects.toMatchObject({ kind: 'unexpected_response' });
    }
    expect(calls).toEqual([]);

    const ok = await client.download(credentials, {
      operation: 'media.download',
      url: 'https://lookaside.fbsbx.com/whatsapp_business/attachments/?mid=1',
      maxBytes: 100,
    });
    expect(ok.bytes.toString()).toBe('isi');
    await expect(
      client.download(credentials, {
        operation: 'media.download',
        url: 'https://lookaside.fbsbx.com/redirect',
        maxBytes: 100,
      }),
    ).rejects.toMatchObject({ kind: 'unexpected_response', httpStatus: 302 });
    await expect(
      client.download(credentials, {
        operation: 'media.download',
        url: 'https://lookaside.fbsbx.com/besar',
        maxBytes: 2,
      }),
    ).rejects.toMatchObject({ kind: 'invalid_parameter' });
  });
});
