import { API_ROUTES, CONTACT_IMPORT_ISSUES, apiPath, type Contact } from '@balesin/shared';
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, json, type FakeHandler } from '../../test/fake-api';
import { fakeAttribute } from '../../test/fake-crm';
import { fakeContact } from '../../test/fake-inbox';
import { confirmIdentity, TEST_CODE, TEST_PASSWORD } from '../../test/identity';
import { renderApp } from '../../test/render-app';
import { collectAttributes, splitAttributes } from './attribute-values';
import { csvHeader, normalizeColumns, readImportColumns } from './import-columns';
import { buildImportMapping, guessImportMapping } from './import-mapping';

const c = t.contacts;
const R = API_ROUTES.crm;
const OLD = fakeContact({
  id: 'd0000000-0000-4000-8000-0000000000a1',
  number: 3,
  displayName: 'Budi (lama)',
  name: 'Budi (lama)',
  nameSource: 'team',
  phone: null,
  createdAt: '2026-10-01T02:00:00.000Z',
});
const NEW = fakeContact({
  id: 'd0000000-0000-4000-8000-0000000000a2',
  number: 9,
  displayName: 'Budi Santoso',
  possibleDuplicateOfContactId: OLD.id,
});

function routes(extra: Record<string, FakeHandler> = {}) {
  return {
    routes: {
      [`GET ${R.contacts}`]: () => json({ contacts: [NEW, OLD], nextCursor: null }),
      [`GET ${apiPath(API_ROUTES.inbox.contact, { contactId: NEW.id })}`]: () =>
        json({ contact: NEW }),
      [`GET ${apiPath(API_ROUTES.inbox.contact, { contactId: OLD.id })}`]: () =>
        json({ contact: OLD }),
      ...extra,
    },
  };
}

/** XLSX minimal (ZIP tanpa kompresi) berisi sharedStrings + sheet1. */
function storedZip(files: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const locals: Uint8Array[] = [];
  const centrals: Uint8Array[] = [];
  let offset = 0;
  for (const [name, text] of Object.entries(files)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const lv = new DataView(local.buffer);
    lv.setUint32(0, 0x04034b50, true);
    lv.setUint16(8, 0, true);
    lv.setUint32(18, data.length, true);
    lv.setUint32(22, data.length, true);
    lv.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    const central = new Uint8Array(46 + nameBytes.length);
    const cv = new DataView(central.buffer);
    cv.setUint32(0, 0x02014b50, true);
    cv.setUint16(10, 0, true);
    cv.setUint32(20, data.length, true);
    cv.setUint32(24, data.length, true);
    cv.setUint16(28, nameBytes.length, true);
    cv.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const centralSize = centrals.reduce((sum, item) => sum + item.length, 0);
  const end = new Uint8Array(22);
  const ev = new DataView(end.buffer);
  ev.setUint32(0, 0x06054b50, true);
  ev.setUint16(8, centrals.length, true);
  ev.setUint16(10, centrals.length, true);
  ev.setUint32(12, centralSize, true);
  ev.setUint32(16, offset, true);
  const all = [...locals, ...centrals, end];
  const out = new Uint8Array(all.reduce((sum, item) => sum + item.length, 0));
  let position = 0;
  for (const part of all) {
    out.set(part, position);
    position += part.length;
  }
  return out;
}

describe('judul kolom impor (dibaca di browser)', () => {
  it('CSV: pemisah titik koma, kutip, BOM; judul kosong & kembar seperti server', () => {
    const bytes = new TextEncoder().encode('﻿"No HP";nama;;nama\n0812;Budi;x;y\n');
    expect(csvHeader(bytes)).toEqual(['No HP', 'nama', '', 'nama']);
    expect(normalizeColumns(['No HP', 'nama', '', 'nama'])).toEqual([
      'No HP',
      'nama',
      'kolom_3',
      'nama_2',
    ]);
  });

  it('XLSX: baris pertama dari sharedStrings & inlineStr', async () => {
    const zip = storedZip({
      'xl/sharedStrings.xml':
        '<sst><si><t>nomor</t></si><si><r><t>na</t></r><r><t>ma</t></r></si></sst>',
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="D1" t="inlineStr"><is><t>paket &amp; kota</t></is></c></row><row r="2"><c r="A2"><v>62812</v></c></row></sheetData></worksheet>',
    });
    const file = new File([zip.slice()], 'pelanggan.xlsx');
    expect(await readImportColumns(file)).toEqual(['nomor', 'nama', 'kolom_3', 'paket & kota']);
  });

  it('Excel lama (.xls) ditolak dengan alasan jelas', async () => {
    const bytes = new Uint8Array([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1, 0, 0]);
    await expect(readImportColumns(new File([bytes], 'lama.xls'))).rejects.toMatchObject({
      reason: 'old_excel',
    });
  });

  it('tebak pemetaan dari judul + atribut berdefinisi; galat kolom ganda', () => {
    const fields = guessImportMapping(['No HP', 'Nama', 'Email', 'Paket'], [fakeAttribute()]);
    expect(fields).toMatchObject({ phone: 'No HP', name: 'Nama', email: 'Email' });
    expect(fields.attributes).toEqual([{ id: 0, column: 'Paket', key: 'paket', customKey: '' }]);
    const built = buildImportMapping({ ...fields, name: 'No HP' }, [
      'No HP',
      'Nama',
      'Email',
      'Paket',
    ]);
    expect(built).toEqual({ ok: false, errors: { nameColumn: c.columnTwice } });
  });
});

describe('atribut berdefinisi', () => {
  it('memisahkan nilai tersimpan & menegakkan wajib dengan aturan server', () => {
    const paket = fakeAttribute();
    const split = splitAttributes(
      [paket],
      [
        { key: 'PAKET', value: 'Gold' },
        { key: 'catatan bot', value: 'x' },
      ],
    );
    expect(split).toEqual({
      defined: { paket: 'Gold' },
      free: [{ key: 'catatan bot', value: 'x' }],
    });
    expect(collectAttributes([paket], {}, [])).toEqual({
      ok: false,
      errors: { 'attributes.paket': 'Paket wajib diisi.' },
    });
    expect(collectAttributes([paket], { paket: 'gold' }, [])).toEqual({
      ok: true,
      values: [{ key: 'paket', value: 'Gold' }],
    });
  });
});

describe('daftar kontak', () => {
  it('kosong: ajakan impor & buka inbox', async () => {
    await renderApp('/kontak');
    expect(await screen.findByRole('heading', { name: c.emptyTitle })).toBeVisible();
    expect(screen.getByRole('link', { name: c.importAction })).toHaveAttribute(
      'href',
      '/kontak/impor',
    );
  });

  it('daftar + penanda duplikat; cari dikirim sebagai `q` setelah jeda', async () => {
    const { api } = await renderApp('/kontak', routes());
    const list = within(await screen.findByRole('list', { name: c.listLabel }));
    expect(list.getByRole('link', { name: c.open('Budi Santoso') })).toHaveAttribute(
      'href',
      `/kontak/${NEW.id}`,
    );
    expect(list.getByText(c.duplicateBadge)).toBeVisible();
    fireEvent.change(screen.getByRole('searchbox', { name: c.searchLabel }), {
      target: { value: 'budi' },
    });
    await waitFor(() =>
      expect(api.requests.some((request) => request.query.get('q') === 'budi')).toBe(true),
    );
    fireEvent.click(screen.getByLabelText(c.duplicatesOnly));
    await waitFor(() =>
      expect(
        api.requests.some((request) => request.query.get('possibleDuplicate') === 'true'),
      ).toBe(true),
    );
  });

  it('CS tidak melihat impor/ekspor', async () => {
    await renderApp('/kontak', {
      ...routes(),
      session: (await import('../../test/fake-api')).fakeSession('cs'),
    });
    await screen.findByRole('list', { name: c.listLabel });
    expect(screen.queryByRole('button', { name: c.exportAction })).toBeNull();
    expect(screen.queryByRole('link', { name: c.importAction })).toBeNull();
  });

  describe('ekspor', () => {
    beforeEach(() => {
      URL.createObjectURL = vi.fn(() => 'blob:kontak');
      URL.revokeObjectURL = vi.fn();
    });
    afterEach(() => vi.restoreAllMocks());

    it('konfirmasi identitas → POST ekspor dengan saringan → jumlah baris', async () => {
      let body: unknown = null;
      await renderApp(
        '/kontak?duplikat=1',
        routes({
          [`POST ${R.exportContacts}`]: (request) => {
            body = request.body;
            return new Response('nomor\n', {
              headers: { 'content-type': 'text/csv', 'x-export-rows': '2' },
            });
          },
        }),
      );
      await screen.findByRole('list', { name: c.listLabel });
      fireEvent.click(screen.getByRole('button', { name: c.exportAction }));
      await confirmIdentity(c.exportTitle, c.exportConfirm);
      expect(await screen.findByText(c.exportDone(2))).toBeVisible();
      expect(body).toEqual({
        filter: { possibleDuplicate: true },
        confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
      });
    });

    it('terlalu banyak baris (409) → pesan server di halaman', async () => {
      await renderApp(
        '/kontak',
        routes({
          [`POST ${R.exportContacts}`]: () =>
            apiError(409, 'CONFLICT', 'Lebih dari 50.000 kontak. Persempit saringan.'),
        }),
      );
      await screen.findByRole('list', { name: c.listLabel });
      fireEvent.click(screen.getByRole('button', { name: c.exportAction }));
      await confirmIdentity(c.exportTitle, c.exportConfirm);
      expect(
        await screen.findByText('Lebih dari 50.000 kontak. Persempit saringan.'),
      ).toBeVisible();
    });
  });
});

describe('detail kontak', () => {
  it('mungkin duplikat → gabung ke kontak lama (konfirmasi identitas)', async () => {
    let merged: { path: string; body: unknown } | null = null;
    const kept: Contact = { ...OLD, phone: NEW.phone };
    const { router } = await renderApp(
      `/kontak/${NEW.id}`,
      routes({
        [`POST ${apiPath(R.merge, { contactId: OLD.id })}`]: (request) => {
          merged = { path: request.path, body: request.body };
          return json({
            contact: kept,
            moved: { conversations: 2, messages: 14, tags: 1, tickets: 0 },
          });
        },
      }),
    );
    expect(await screen.findByText(c.duplicateNoticeBody('Budi (lama)'))).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: c.merge }));
    const dialog = await screen.findByRole('dialog', { name: c.mergeTitle });
    // Bawaan: yang lebih lama dipertahankan.
    expect(within(dialog).getByRole('radio', { name: /Budi \(lama\)/ })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    fireEvent.click(within(dialog).getByRole('button', { name: c.mergeContinue }));
    await confirmIdentity(c.mergeConfirmTitle, c.mergeConfirm);
    await waitFor(() => expect(router.state.location.pathname).toBe(`/kontak/${OLD.id}`));
    expect(merged).toEqual({
      path: `/api/v1/contacts/${OLD.id}/merge`,
      body: {
        sourceContactId: NEW.id,
        confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
      },
    });
    expect(
      await screen.findByText(c.mergeDone({ conversations: 2, messages: 14, tags: 1, tickets: 0 })),
    ).toBeVisible();
  });

  it('Supervisor melihat penanda tanpa tombol gabung', async () => {
    const { fakeSession } = await import('../../test/fake-api');
    await renderApp(`/kontak/${NEW.id}`, { ...routes(), session: fakeSession('supervisor') });
    expect(await screen.findByText(c.duplicateNoPermission)).toBeVisible();
    expect(screen.queryByRole('button', { name: c.merge })).toBeNull();
  });

  it('ubah kontak: atribut wajib divalidasi sebelum dikirim', async () => {
    let sent: unknown = null;
    const plain = fakeContact({ id: NEW.id, attributes: [{ key: 'sumber', value: 'bot' }] });
    await renderApp(
      `/kontak/${NEW.id}`,
      routes({
        [`GET ${apiPath(API_ROUTES.inbox.contact, { contactId: NEW.id })}`]: () =>
          json({ contact: plain }),
        [`GET ${R.attributes}`]: () => json({ attributes: [fakeAttribute()] }),
        [`PATCH ${apiPath(API_ROUTES.inbox.contact, { contactId: NEW.id })}`]: (request) => {
          sent = request.body;
          return json({ contact: plain });
        },
      }),
    );
    expect(await screen.findByText(c.requiredMissing)).toBeVisible();
    fireEvent.click(screen.getByRole('button', { name: t.inbox.panel.editContact }));
    const dialog = await screen.findByRole('dialog', { name: t.inbox.panel.contactEditTitle });
    fireEvent.click(within(dialog).getByRole('button', { name: t.inbox.panel.save }));
    expect(await within(dialog).findByText('Paket wajib diisi.')).toBeVisible();
    expect(sent).toBeNull();
    fireEvent.change(within(dialog).getByLabelText(/^Paket/), { target: { value: 'Gold' } });
    fireEvent.click(within(dialog).getByRole('button', { name: t.inbox.panel.save }));
    await waitFor(() => expect(sent).not.toBeNull());
    expect((sent as { attributes: unknown }).attributes).toEqual([
      { key: 'paket', value: 'Gold' },
      { key: 'sumber', value: 'bot' },
    ]);
  });
});

/** Isian `mapping` multipart sebagai teks JSON. */
function mappingText(form: FormData | undefined): string {
  const value = form?.get('mapping');
  return typeof value === 'string' ? value : '{}';
}

describe('impor kontak', () => {
  async function pickCsv() {
    const input = await screen.findByTestId('impor-kontak-berkas');
    const file = new File(['nomor,nama,paket\n08123,Budi,Gold\n'], 'pelanggan.csv', {
      type: 'text/csv',
    });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await Promise.resolve();
    });
    await screen.findByText(c.fileColumns(3));
  }

  const RESULT = {
    sourceRows: 1,
    created: 1,
    updated: 0,
    unchanged: 0,
    skipped: 0,
    issueCounts: Object.fromEntries(CONTACT_IMPORT_ISSUES.map((issue) => [issue, 0])),
    issues: [],
  };

  it('periksa dulu (dryRun): `mapping` dikirim SEBELUM `file`', async () => {
    const forms: FormData[] = [];
    await renderApp('/kontak/impor', {
      routes: {
        [`POST ${R.importContacts}`]: (request) => {
          forms.push(request.raw as FormData);
          return json({ ...RESULT, dryRun: true });
        },
      },
    });
    await pickCsv();
    expect(screen.getByLabelText(c.phoneColumn)).toHaveValue('nomor');
    fireEvent.click(screen.getByRole('button', { name: c.check }));
    expect(await screen.findByRole('heading', { name: c.resultDryTitle })).toBeVisible();
    const form = forms[0];
    expect([...(form?.keys() ?? [])]).toEqual(['mapping', 'file']);
    expect(JSON.parse(mappingText(form))).toMatchObject({
      phoneColumn: 'nomor',
      nameColumn: 'nama',
      mode: 'upsert',
      dryRun: true,
    });
    expect(JSON.parse(mappingText(form))).not.toHaveProperty('confirmation');
  });

  it('impor sungguhan mode perbarui → konfirmasi identitas di `mapping.confirmation`', async () => {
    const mappings: Record<string, unknown>[] = [];
    await renderApp('/kontak/impor', {
      routes: {
        [`POST ${R.importContacts}`]: (request) => {
          const mapping = JSON.parse(mappingText(request.raw as FormData)) as Record<
            string,
            unknown
          >;
          mappings.push(mapping);
          return json({ ...RESULT, dryRun: mapping.dryRun === true });
        },
      },
    });
    await pickCsv();
    fireEvent.click(screen.getByRole('button', { name: c.check }));
    fireEvent.click(await screen.findByRole('button', { name: c.runImport }));
    await confirmIdentity(c.importConfirmTitle, c.importConfirm);
    expect(await screen.findByRole('heading', { name: c.resultTitle })).toBeVisible();
    expect(mappings[1]).toMatchObject({
      dryRun: false,
      mode: 'upsert',
      confirmation: { password: TEST_PASSWORD, code: TEST_CODE },
    });
  });

  it('berkas dipilih SEBELUM daftar atribut termuat: kolom atribut tetap ditebak (QA S2)', async () => {
    let release: () => void = () => undefined;
    const attributesReady = new Promise<void>((resolve) => {
      release = resolve;
    });
    const mappings: Record<string, unknown>[] = [];
    await renderApp('/kontak/impor', {
      routes: {
        [`GET ${R.attributes}`]: async () => {
          await attributesReady;
          return json({ attributes: [fakeAttribute()] });
        },
        [`POST ${R.importContacts}`]: (request) => {
          const mapping = JSON.parse(mappingText(request.raw as FormData)) as Record<
            string,
            unknown
          >;
          mappings.push(mapping);
          return json({ ...RESULT, dryRun: true });
        },
      },
    });
    const input = await screen.findByTestId('impor-kontak-berkas');
    const file = new File(['nomor,nama,paket\n08123,Budi,Gold\n'], 'pelanggan.csv', {
      type: 'text/csv',
    });
    await act(async () => {
      fireEvent.change(input, { target: { files: [file] } });
      await Promise.resolve();
    });
    // Pemetaan belum tampil selama daftar atribut belum ada.
    expect(screen.queryByLabelText(c.phoneColumn)).toBeNull();
    await act(async () => {
      release();
      await attributesReady;
    });
    await screen.findByText(c.fileColumns(3));
    fireEvent.click(screen.getByRole('button', { name: c.check }));
    await screen.findByRole('heading', { name: c.resultDryTitle });
    expect(mappings[0]).toMatchObject({
      attributes: [{ column: 'paket', key: 'paket' }],
    });
  });

  it('hanya kontak baru: tanpa konfirmasi identitas', async () => {
    const mappings: Record<string, unknown>[] = [];
    await renderApp('/kontak/impor', {
      routes: {
        [`POST ${R.importContacts}`]: (request) => {
          const mapping = JSON.parse(mappingText(request.raw as FormData)) as Record<
            string,
            unknown
          >;
          mappings.push(mapping);
          return json({ ...RESULT, dryRun: mapping.dryRun === true });
        },
      },
    });
    await pickCsv();
    fireEvent.click(screen.getByRole('radio', { name: new RegExp(c.modeCreateOnly) }));
    fireEvent.click(screen.getByRole('button', { name: c.check }));
    fireEvent.click(await screen.findByRole('button', { name: c.runImport }));
    expect(await screen.findByRole('heading', { name: c.resultTitle })).toBeVisible();
    expect(mappings[1]).toMatchObject({ dryRun: false, mode: 'create_only' });
    expect(mappings[1]).not.toHaveProperty('confirmation');
  });
});
