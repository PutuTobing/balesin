import { describe, expect, it } from 'vitest';

import {
  contactImportMappingSchema,
  contactListQuerySchema,
  createAttributeDefinitionRequestSchema,
  normalizeAttributeDate,
  normalizeAttributeNumber,
  validateAttributeValues,
  type AttributeRule,
} from './crm';
import { publicUpdateTicketRequestSchema, updateTicketRequestSchema } from './tickets';

const RULES: AttributeRule[] = [
  { key: 'ID Pelanggan', label: 'ID Pelanggan', type: 'text', required: true, options: [] },
  { key: 'Tagihan', label: 'Tagihan', type: 'number', required: false, options: [] },
  { key: 'Jatuh tempo', label: 'Jatuh tempo', type: 'date', required: false, options: [] },
  {
    key: 'Paket',
    label: 'Paket',
    type: 'select',
    required: false,
    options: ['10 Mbps', '20 Mbps'],
  },
];

describe('normalizeAttributeDate', () => {
  it('menerima ISO, DD/MM/YYYY, dan nomor seri Excel; menolak tanggal mustahil', () => {
    expect(normalizeAttributeDate('2026-12-31')).toBe('2026-12-31');
    expect(normalizeAttributeDate('31/12/2026')).toBe('2026-12-31');
    expect(normalizeAttributeDate('1-2-2026')).toBe('2026-02-01');
    expect(normalizeAttributeDate('46022')).toBe('2025-12-31');
    expect(normalizeAttributeDate('2026-02-30')).toBeNull();
    expect(normalizeAttributeDate('31/13/2026')).toBeNull();
    expect(normalizeAttributeDate('besok')).toBeNull();
    expect(normalizeAttributeDate('12345')).toBeNull();
  });
});

describe('normalizeAttributeNumber', () => {
  it('membakukan desimal koma/titik; menolak pemisah ribuan dan teks', () => {
    expect(normalizeAttributeNumber('150000')).toBe('150000');
    expect(normalizeAttributeNumber('007')).toBe('7');
    expect(normalizeAttributeNumber('2,50')).toBe('2.5');
    expect(normalizeAttributeNumber('-0')).toBe('0');
    expect(normalizeAttributeNumber('-12.30')).toBe('-12.3');
    expect(normalizeAttributeNumber('1.500.000')).toBeNull();
    expect(normalizeAttributeNumber('Rp 150.000')).toBeNull();
    expect(normalizeAttributeNumber('=1+1')).toBeNull();
  });
});

describe('validateAttributeValues', () => {
  it('membakukan nilai berdefinisi (ejaan kunci & pilihan) dan membiarkan atribut bebas', () => {
    const result = validateAttributeValues(
      RULES,
      [
        { key: 'id pelanggan', value: ' 101PUTU@G2 ' },
        { key: 'TAGIHAN', value: '150000,00' },
        { key: 'jatuh tempo', value: '05/01/2027' },
        { key: 'paket', value: '20 mbps' },
        { key: 'ODP', value: 'ODP-07' },
      ],
      { enforceRequired: true },
    );
    expect(result).toEqual({
      ok: true,
      values: [
        { key: 'ID Pelanggan', value: '101PUTU@G2' },
        { key: 'Tagihan', value: '150000' },
        { key: 'Jatuh tempo', value: '2027-01-05' },
        { key: 'Paket', value: '20 Mbps' },
        { key: 'ODP', value: 'ODP-07' },
      ],
    });
  });

  it('menolak nilai yang tidak sesuai jenis dengan pesan Indonesia per atribut', () => {
    const result = validateAttributeValues(
      RULES,
      [
        { key: 'ID Pelanggan', value: 'A1' },
        { key: 'Tagihan', value: 'lima ratus' },
        { key: 'Jatuh tempo', value: '31/02/2027' },
        { key: 'Paket', value: '100 Mbps' },
      ],
      { enforceRequired: false },
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.issues.map((issue) => issue.key)).toEqual(['Tagihan', 'Jatuh tempo', 'Paket']);
    expect(result.issues[2]?.message).toContain('10 Mbps, 20 Mbps');
  });

  it('wajib hanya ditegakkan bila diminta (simpan dari aplikasi / tiket)', () => {
    expect(validateAttributeValues(RULES, [], { enforceRequired: false }).ok).toBe(true);
    const strict = validateAttributeValues(RULES, [], { enforceRequired: true });
    expect(strict.ok).toBe(false);
    if (!strict.ok)
      expect(strict.issues).toEqual([
        { key: 'ID Pelanggan', message: 'ID Pelanggan wajib diisi.' },
      ]);
  });
});

describe('skema CRM & tiket', () => {
  it('definisi atribut: pilihan wajib untuk jenis Pilihan saja', () => {
    expect(
      createAttributeDefinitionRequestSchema.safeParse({
        key: 'Paket',
        label: 'Paket',
        type: 'select',
      }).success,
    ).toBe(false);
    expect(
      createAttributeDefinitionRequestSchema.safeParse({
        key: 'Tagihan',
        label: 'Tagihan',
        type: 'number',
        options: ['x'],
      }).success,
    ).toBe(false);
    expect(
      createAttributeDefinitionRequestSchema.safeParse({
        key: 'Paket',
        label: 'Paket',
        type: 'select',
        options: ['10 Mbps', '10 mbps'],
      }).success,
    ).toBe(false);
  });

  it('daftar kontak: nama & nilai atribut harus berpasangan', () => {
    expect(contactListQuerySchema.safeParse({ attributeKey: 'Paket' }).success).toBe(false);
    expect(
      contactListQuerySchema.safeParse({ attributeKey: 'Paket', attributeValue: '10 Mbps' })
        .success,
    ).toBe(true);
    expect(contactListQuerySchema.parse({ possibleDuplicate: 'true' }).possibleDuplicate).toBe(
      true,
    );
  });

  it('pemetaan impor: bawaan upsert & bukan uji coba', () => {
    expect(contactImportMappingSchema.parse({ phoneColumn: 'nomor' })).toEqual({
      phoneColumn: 'nomor',
      nameColumn: null,
      emailColumn: null,
      notesColumn: null,
      tagsColumn: null,
      attributes: [],
      mode: 'upsert',
      dryRun: false,
    });
  });

  it('ubah tiket: minimal satu isian; API tidak boleh columnId + columnName bersamaan', () => {
    expect(updateTicketRequestSchema.safeParse({}).success).toBe(false);
    expect(
      publicUpdateTicketRequestSchema.safeParse({
        columnId: '00000000-0000-4000-8000-000000000001',
        columnName: 'Selesai',
      }).success,
    ).toBe(false);
    expect(publicUpdateTicketRequestSchema.safeParse({ columnName: 'Selesai' }).success).toBe(true);
  });
});
