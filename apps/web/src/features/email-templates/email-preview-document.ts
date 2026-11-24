import type { EmailMessageTemplatePreviewRequest, EmailTemplateContent } from '@balesin/shared';
import { emailPreviewDocument } from '../email-settings/preview-document';

export type PreviewTheme = 'light' | 'dark';

/**
 * Perkiraan "mode gelap paksa" aplikasi email (Gmail/Outlook di HP membalik warna terang): warna
 * dibalik, gambar dikembalikan. Disisipkan ke dokumen pratinjau saja, tidak pernah ke email.
 */
const DARK_STYLE =
  '<style>html{background:white;filter:invert(1) hue-rotate(180deg)}' +
  'img,picture,video{filter:invert(1) hue-rotate(180deg)}</style>';

/** Dokumen `srcdoc` pratinjau: lapisan CSP + `<base target>` dari Email pengirim, plus tema. */
export function templatePreviewDocument(html: string, theme: PreviewTheme): string {
  const document = emailPreviewDocument(html);
  if (theme === 'light') return document;
  const head = /<\/head>/i.exec(document);
  return head
    ? `${document.slice(0, head.index)}${DARK_STYLE}${document.slice(head.index)}`
    : `${DARK_STYLE}${document}`;
}

/** Badan permintaan pratinjau dari isi template (contoh nilai variabel = `example`). */
export function previewBody(
  content: EmailTemplateContent,
  sampleQris: boolean,
): EmailMessageTemplatePreviewRequest {
  return {
    subject: content.subject,
    html: content.html,
    text: content.text,
    layout: content.layout,
    footerText: content.footerText,
    variables: content.variables,
    sampleQris,
  };
}
