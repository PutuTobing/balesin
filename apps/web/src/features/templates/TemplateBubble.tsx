import type { TemplateCategory, TemplateContent } from '@balesin/shared';
import {
  Copy,
  ExternalLink,
  FileText,
  Image as ImageIcon,
  Phone,
  Reply,
  Video,
  type LucideIcon,
} from 'lucide-react';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import styles from './Templates.module.css';
import { previewText } from './template-form';

const c = t.templates;

const buttonIcons: Record<TemplateContent['buttons'][number]['type'], LucideIcon> = {
  QUICK_REPLY: Reply,
  URL: ExternalLink,
  PHONE_NUMBER: Phone,
  COPY_CODE: Copy,
};

const mediaIcons = { IMAGE: ImageIcon, VIDEO: Video, DOCUMENT: FileText } as const;

interface TemplateBubbleProps {
  content: TemplateContent;
  category: TemplateCategory;
  /** Nilai variabel isi (editor: contoh; kirim: nilai yang diketik). */
  values: Readonly<Record<string, string>>;
  /** Nilai variabel judul teks. */
  headerValue?: string;
  /** Nama berkas judul media yang dipilih (kirim). */
  mediaName?: string | null;
  /** Kode OTP yang diketik (kirim); kosong = contoh. */
  otpCode?: string;
}

/**
 * Gelembung keluar seperti di WhatsApp: judul, isi (variabel terisi), catatan kaki, lalu tombol
 * di bawahnya. Semua isi dirender sebagai teks React biasa (tidak pernah HTML).
 */
export function TemplateBubble({
  content,
  category,
  values,
  headerValue = '',
  mediaName = null,
  otpCode = '',
}: TemplateBubbleProps) {
  const otp = category === 'AUTHENTICATION';
  const header = otp ? null : content.header;
  const headerVariable =
    header?.format === 'TEXT' ? /\{\{\s*([A-Za-z0-9_]+)\s*\}\}/.exec(header.text)?.[1] : undefined;
  const buttons = otp ? [] : content.buttons;
  const expiry = content.authentication?.codeExpirationMinutes ?? null;
  return (
    <figure className={styles.bubbleFigure} aria-label={c.previewLabel}>
      <div className={styles.bubble}>
        {header?.format === 'TEXT' ? (
          <p className={styles.bubbleHeader} dir="auto">
            {previewText(
              header.text,
              headerVariable ? { [headerVariable]: headerValue || (header.example ?? '') } : {},
            )}
          </p>
        ) : header ? (
          <div className={styles.bubbleMedia}>
            <Icon icon={mediaIcons[header.format]} size={20} />
            <span dir="auto">{mediaName ?? c.mediaHeader[header.format]}</span>
          </div>
        ) : null}
        {otp ? (
          <div className={styles.bubbleBody}>
            <p>{c.otpPreview(otpCode.trim() || '123456')}</p>
            {content.authentication?.addSecurityRecommendation !== false ? (
              <p>{c.otpSecurityLine}</p>
            ) : null}
          </div>
        ) : (
          <p className={styles.bubbleBody} dir="auto">
            {previewText(content.body.text, values)}
          </p>
        )}
        {otp && expiry ? (
          <p className={styles.bubbleFooter}>{c.otpExpiryLine(expiry)}</p>
        ) : content.footer && !otp ? (
          <p className={styles.bubbleFooter} dir="auto">
            {content.footer.text}
          </p>
        ) : null}
      </div>
      {otp || buttons.length > 0 ? (
        <ul className={styles.bubbleButtons}>
          {otp ? (
            <li className={styles.bubbleButton}>
              <Icon icon={Copy} size={16} />
              {c.copyCode}
            </li>
          ) : (
            buttons.map((button, index) => (
              <li key={index} className={styles.bubbleButton} dir="auto">
                <Icon icon={buttonIcons[button.type]} size={16} />
                {button.type === 'COPY_CODE'
                  ? c.copyCode
                  : button.text || c.buttonKinds[button.type]}
              </li>
            ))
          )}
        </ul>
      ) : null}
    </figure>
  );
}
