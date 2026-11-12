/**
 * Khusus pengembangan: sengaja gagal saat dirender supaya layar gagal yang asli
 * (`RouteErrorScreen`) bisa difoto dan dinilai. Tidak ikut ke build produksi.
 */
export function CrashPreview(): never {
  // Pesan meniru galat jaringan browser yang paling sering terjadi.
  throw new TypeError('Failed to fetch');
}
