/* global document */
/*
 * Memasang pilihan tema tersimpan ke <html data-theme> sebelum cat pertama.
 * Tanpa pilihan tersimpan ("Ikuti sistem"), CSS memakai prefers-color-scheme.
 * Kunci dan nilainya harus sama dengan src/theme/theme.ts (dijaga oleh tes).
 */
(function () {
  try {
    var saved = localStorage.getItem('balesin.tema');
    if (saved === 'light' || saved === 'dark') {
      document.documentElement.setAttribute('data-theme', saved);
    }
  } catch (_error) {
    // Penyimpanan diblokir (mode privat, kebijakan browser): pakai tema sistem.
  }
})();
