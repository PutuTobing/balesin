import { t } from '../../i18n/id';

const w = t.webhooks;

/** Kalimat untuk kode galat pengiriman webhook (`http_404`, `timeout`, `dns`, …). */
export function deliveryErrorText(code: string): string {
  const http = /^http_(\d{3})$/.exec(code);
  if (http?.[1]) {
    const status = Number(http[1]);
    const meaning = w.httpMeaning[status] ?? (status >= 500 ? w.http5xx : w.http4xx);
    return w.httpError(status, meaning);
  }
  return w.errors[code] ?? code;
}
