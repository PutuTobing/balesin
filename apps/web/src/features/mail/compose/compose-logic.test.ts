import { describe, expect, it } from 'vitest';
import { fakeComposeIdentity, fakeDraft } from '../../../test/fake-mail';
import { identityBadge } from '../identity-badge';
import { DEFAULT_ATTACHMENT_MAX_BYTES, rejectBeforeUpload } from './compose-attachments';
import {
  fillSignature,
  htmlToPlainText,
  isBlankHtml,
  mentionsAttachment,
  normalizeLinkInput,
  safeHref,
  sanitizeToFragment,
  serializeEditor,
  signatureIdOfLogoCid,
  textToHtml,
} from './compose-html';
import {
  addRecipients,
  externalAddresses,
  parseRecipientInput,
  recipientCount,
  recipientInitials,
  removeRecipient,
  type Recipients,
} from './compose-recipients';
import { checkWarnings, composeTitle, defaultIdentity } from './compose-view';
import { AUTOSAVE_IDLE_MS, AUTOSAVE_MAX_MS, nextSaveDelay } from './use-draft-autosave';

/** HTML → fragmen aman → HTML (jalur editor: draf/tempelan masuk, simpan keluar). */
function roundTrip(html: string, resolve: (cid: string) => string | null = () => null) {
  const { fragment, droppedImages } = sanitizeToFragment(html, document, resolve);
  const holder = document.createElement('div');
  holder.appendChild(fragment);
  return { html: serializeEditor(holder), droppedImages, holder };
}

describe('profil HTML editor (KONTRAK-API-EMAIL-TULIS §6.4)', () => {
  it('membuang skrip, on*, style, class, iframe, dan sisa Word', () => {
    const { html } = roundTrip(
      '<p class="MsoNormal" onclick="alert(1)">Halo <b>Bu</b><script>alert(2)</script></p>' +
        '<style>p{color:red}</style><!-- komentar --><o:p>x</o:p><iframe src="https://jahat.example"></iframe>' +
        '<p style="color: #ff0000; position: fixed; background-image: url(https://x)">Merah</p>',
    );
    expect(html).toBe('<p>Halo <b>Bu</b></p><p style="color: #ff0000">Merah</p>');
  });

  it('gambar jarak jauh & data: dibuang; cid: yang dikenal dipetakan lalu dikembalikan ke cid:', () => {
    const resolve = (cid: string) => (cid === 'img-1a2b3c4d' ? '/api/v1/pratinjau/1' : null);
    const { html, droppedImages, holder } = roundTrip(
      '<p><img src="https://pelacak.example/p.gif"><img src="data:image/png;base64,AAAA">' +
        '<img src="cid:img-1a2b3c4d" alt="Denah" width="320" onerror="x()"><img src="cid:asing"></p>',
      resolve,
    );
    expect(droppedImages).toBe(3);
    // Di editor: URL pratinjau origin sendiri, tidak pernah alamat luar.
    expect(holder.querySelector('img')?.getAttribute('src')).toBe('/api/v1/pratinjau/1');
    expect(html).toBe('<p><img src="cid:img-1a2b3c4d" alt="Denah" width="320"></p>');
  });

  it('tautan hanya https/http/mailto/tel; rel/target editor tidak ikut tersimpan', () => {
    const { html, holder } = roundTrip(
      '<a href="javascript:alert(1)">a</a><a href="https://contoh.id">b</a><a href="mailto:x@contoh.id">c</a>',
    );
    expect(holder.querySelector('a[href="https://contoh.id"]')?.getAttribute('rel')).toBe(
      'noopener noreferrer',
    );
    expect(html).toBe(
      '<a>a</a><a href="https://contoh.id">b</a><a href="mailto:x@contoh.id">c</a>',
    );
    expect(safeHref('https://contoh.id/a b')).toBeNull();
    expect(normalizeLinkInput('contoh.id/harga')).toBe('https://contoh.id/harga');
    expect(normalizeLinkInput('rina@contoh.id')).toBe('mailto:rina@contoh.id');
    expect(normalizeLinkInput('javascript:alert(1)')).toBeNull();
  });

  it('data-signature hanya di div; teks di-escape saat diserialisasi', () => {
    const { html } = roundTrip(
      '<p data-signature="x">a &lt;b&gt;</p><div data-signature="sig-1">Salam</div>',
    );
    expect(html).toBe('<p>a &lt;b&gt;</p><div data-signature="sig-1">Salam</div>');
  });

  it('tempelan bersarang sangat dalam tidak membekukan dan teksnya tetap', () => {
    const deep = `${'<div>'.repeat(300)}isi${'</div>'.repeat(300)}`;
    const { html } = roundTrip(deep);
    expect(html).toContain('isi');
  });

  it('teks ↔ HTML, kosong, dan kata "terlampir" tanpa menghitung tanda tangan', () => {
    expect(textToHtml('Halo <Bu>\nbaris 2\n\nparagraf')).toBe(
      '<p>Halo &lt;Bu&gt;<br>baris 2</p><p>paragraf</p>',
    );
    expect(
      htmlToPlainText('<p>Halo</p><ul><li>Satu</li></ul><p><a href="https://a.id">situs</a></p>'),
    ).toBe('Halo\n• Satu\nsitus (https://a.id)');
    expect(isBlankHtml('<p><br></p>')).toBe(true);
    expect(mentionsAttachment('<p>Penawaran terlampir ya</p>', 'html')).toBe(true);
    expect(
      mentionsAttachment('<p>Halo</p><div data-signature="s">Lampiran: KTP</div>', 'html'),
    ).toBe(false);
    expect(mentionsAttachment('see attached', 'text')).toBe(true);
  });

  it('variabel tanda tangan di-escape; {{logo}} jadi cid:sig-logo-<id>', () => {
    const id = '7a1b2c3d-0000-4000-8000-0000000000fb';
    const html = fillSignature('<p>{{nama_agen}} · {{nama_organisasi}} {{logo}} {{lain}}</p>', {
      signatureId: id,
      agentName: 'Rina <b>',
      senderAddress: 'cs@contoh.id',
      organizationName: 'PT "Maju"',
      hasLogo: true,
    });
    expect(html).toContain('Rina &lt;b&gt;');
    expect(html).toContain(`<img src="cid:sig-logo-${id}" alt="PT &quot;Maju&quot;">`);
    expect(html).toContain('{{lain}}');
    expect(signatureIdOfLogoCid(`sig-logo-${id}`)).toBe(id);
    expect(signatureIdOfLogoCid('img-1')).toBeNull();
  });
});

describe('kolom penerima', () => {
  const empty: Recipients = { to: [], cc: [], bcc: [] };

  it('memisah ketikan/tempelan, mempertahankan nama, menyisakan yang tidak sah', () => {
    const parsed = parseRecipientInput(
      'Rina Wulandari <Rina@Contoh.id>, agus@contoh.id; bukan-alamat\n"Sari" <sari@contoh.id>',
    );
    expect(parsed.valid).toEqual([
      { address: 'rina@contoh.id', name: 'Rina Wulandari' },
      { address: 'agus@contoh.id', name: null },
      { address: 'sari@contoh.id', name: 'Sari' },
    ]);
    expect(parsed.invalid).toEqual(['bukan-alamat']);
  });

  it('duplikat di kolom mana pun ditolak tanpa beda huruf; hapus & hitung', () => {
    const first = addRecipients(empty, 'to', [{ address: 'rina@contoh.id', name: 'Rina' }]);
    const second = addRecipients(first.next, 'cc', [
      { address: 'RINA@contoh.id', name: null },
      { address: 'agus@contoh.id', name: null },
    ]);
    expect(second.duplicates).toEqual(['rina@contoh.id']);
    expect(second.next.cc).toEqual([{ address: 'agus@contoh.id', name: null }]);
    expect(recipientCount(second.next)).toBe(2);
    expect(removeRecipient(second.next, 'to', 'RINA@contoh.id').to).toEqual([]);
    expect(recipientInitials({ address: 'rina@contoh.id', name: 'Rina Wulandari' })).toBe('RW');
    expect(externalAddresses(second.next, ['contoh.id'])).toEqual([]);
    expect(externalAddresses(second.next, ['majujaya.co.id'])).toHaveLength(2);
  });
});

describe('simpan otomatis', () => {
  it('2 dtk setelah ketikan terakhir, paling lambat 5 dtk sejak kotor', () => {
    expect(nextSaveDelay(1_000, 1_000, 1_000)).toBe(AUTOSAVE_IDLE_MS);
    // Terus mengetik: tetap tersimpan 5 dtk setelah perubahan pertama.
    expect(nextSaveDelay(4_500, 0, 4_500)).toBe(AUTOSAVE_MAX_MS - 4_500);
    expect(nextSaveDelay(9_000, 0, 8_000)).toBe(0);
  });
});

describe('lampiran sebelum unggah', () => {
  const context = { totalBytes: 0, count: 0, maxBytes: DEFAULT_ATTACHMENT_MAX_BYTES };
  it('menolak jenis berbahaya, Office lama, arsip, dan total berlebih', () => {
    expect(rejectBeforeUpload({ name: 'setup.exe', size: 10, type: '' }, context)).toBe('type');
    expect(rejectBeforeUpload({ name: 'data.zip', size: 10, type: '' }, context)).toBe('type');
    expect(rejectBeforeUpload({ name: 'lama.doc', size: 10, type: '' }, context)).toBe('type');
    expect(rejectBeforeUpload({ name: 'tanpa-akhiran', size: 10, type: '' }, context)).toBe('type');
    expect(rejectBeforeUpload({ name: 'Penawaran.pdf', size: 10, type: '' }, context)).toBeNull();
    expect(
      rejectBeforeUpload(
        { name: 'besar.pdf', size: DEFAULT_ATTACHMENT_MAX_BYTES, type: '' },
        { ...context, totalBytes: 1 },
      ),
    ).toBe('too_large');
    expect(
      rejectBeforeUpload({ name: 'a.pdf', size: 1, type: '' }, { ...context, count: 20 }),
    ).toBe('too_many');
    expect(
      rejectBeforeUpload(
        { name: 'a.svg', size: 1, type: 'image/svg+xml' },
        { ...context, inline: true },
      ),
    ).toBe('inline_type');
  });
});

describe('jendela tulis', () => {
  it('judul dari mode & subjek (awalan Re:/Fwd: tidak diulang)', () => {
    expect(composeTitle('new', '')).toBe('Pesan baru');
    expect(composeTitle('reply', 'Re: Permintaan upgrade')).toBe('Balas: Permintaan upgrade');
    expect(composeTitle('forward', 'Fwd: Faktur')).toBe('Teruskan: Faktur');
  });

  it('"Dari" bawaan: akun yang dibuka → identitas utama terverifikasi; yang belum diverifikasi dilewati', () => {
    const unverifiedCs = fakeComposeIdentity({ verification: { state: 'unverified' } as never });
    const billing = fakeComposeIdentity(
      {
        id: '7a1b2c3d-0000-4000-8000-0000000000d3',
        accountId: '7a1b2c3d-0000-4000-8000-000000000002',
        address: 'billing@majujaya.co.id',
      },
      { id: '7a1b2c3d-0000-4000-8000-000000000002', displayName: 'Billing' },
    );
    expect(defaultIdentity([unverifiedCs, billing], unverifiedCs.accountId)?.id).toBe(billing.id);
    expect(defaultIdentity([billing], null)?.id).toBe(billing.id);
    expect(defaultIdentity([], null)).toBeNull();
  });

  it('peringatan cek: balas-ke berbeda, penerima luar domain, Bcc banyak, batas penerima', () => {
    const warnings = checkWarnings(
      {
        totalRecipients: 45,
        maxRecipients: 50,
        bccCount: 12,
        bccWarning: true,
        recipients: [
          {
            field: 'to',
            address: 'x@luar.example',
            valid: true,
            known: false,
            external: true,
            ownIdentity: false,
            contactId: null,
          },
        ],
        newAddressCount: 3,
        newAddressQuota: { limit: 200, remaining: 1 },
        replyToDiffers: 'bayar@penipu.example',
        identity: { verified: true, reason: null },
        attachments: { totalBytes: 0, maxBytes: 1, notReady: 0 },
        threadNewMessages: { count: 0, latestReceivedAt: null },
      },
      fakeDraft({ mode: 'reply' }),
    );
    expect(warnings).toHaveLength(5);
    expect(warnings[0]).toContain('bayar@penipu.example');
  });

  it('lencana identitas tidak biner: persetujuan didahulukan, status asing netral', () => {
    const base = fakeComposeIdentity();
    expect(identityBadge(base)).toEqual({ tone: 'success', label: 'Terverifikasi' });
    expect(identityBadge({ ...base, approval: { state: 'pending', decidedAt: null } }).tone).toBe(
      'warning',
    );
    expect(
      identityBadge({
        ...base,
        verification: { ...base.verification, state: 'antah' as never },
      }),
    ).toEqual({ tone: 'neutral', label: 'Belum bisa dipakai' });
  });
});
