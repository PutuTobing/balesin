/**
 * Satu-satunya pembuat sel/baris CSV untuk semua ekspor (audit, kontak, broadcast, laporan — audit
 * akhir A2). RFC 4180 + aman dibuka di Excel/Google Sheets/LibreOffice:
 *  - Formula injection (OWASP "CSV Injection"): TEKS yang diawali `=`, `+`, `-`, `@`, tab, atau CR —
 *    juga setelah spasi/kutip di depannya — diberi awalan `'` sehingga dibaca sebagai teks. Isian
 *    seperti nama profil pelanggan dikendalikan pihak luar.
 *  - Angka (`number` hingga) tidak diberi awalan: bilangan bukan rumus, dan `-5` tetap terbaca angka.
 *  - Selalu dikutip; `"` digandakan; karakter kendali selain tab/baris baru dibuang.
 */
export function csvCell(value: string | number | boolean | null | undefined): string {
  if (value === null || value === undefined) return '""';
  if (typeof value === 'number' && Number.isFinite(value)) return `"${String(value)}"`;
  // eslint-disable-next-line no-control-regex
  let text = String(value).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '');
  if (/^[\s"']*[=+\-@\t\r]/.test(text)) text = `'${text}`;
  return `"${text.replace(/"/g, '""')}"`;
}

export function csvRow(values: ReadonlyArray<string | number | boolean | null | undefined>) {
  return `${values.map(csvCell).join(',')}\r\n`;
}
