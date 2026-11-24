import { EMAIL_MAX_EXTRA_RECIPIENTS } from '@balesin/shared';
import { useCallback, useRef, useState } from 'react';
import { t } from '../../i18n/id';
import {
  addCopies,
  leftoverInput,
  splitAddressInput,
  type AddResult,
  type CopyContext,
  type CopyField,
  type EmailCopies,
} from './email-recipients';

const k = t.inbox.emailCopies;
const EMPTY: EmailCopies = { cc: [], bcc: [] };
const NO_DRAFTS: Record<CopyField, string> = { cc: '', bcc: '' };
const FIELDS: readonly CopyField[] = ['cc', 'bcc'];

export type CopyErrors = Partial<Record<CopyField, string>>;

/** Penjelasan penolakan pertama (satu baris; alamat tidak sah tetap di kolom untuk diperbaiki). */
export function rejectionText(result: AddResult): string | null {
  const first = result.rejected[0];
  if (!first) return null;
  switch (first.reason) {
    case 'invalid':
      return k.invalid(first.address);
    case 'customer':
      return k.customer;
    case 'self':
      return k.self;
    case 'otherChannel':
      return k.otherChannel;
    case 'limit':
      return k.limit(EMAIL_MAX_EXTRA_RECIPIENTS);
  }
}

/**
 * Keadaan Cc/Bcc composer channel Email (milik `Composer`, dikosongkan setelah kirim): alamat,
 * ketikan yang belum jadi chip, dan galat PER KOLOM (galat Bcc tidak menandai Cc, review 9.0 P2).
 */
export function useEmailCopies() {
  const [copies, setCopies] = useState<EmailCopies>(EMPTY);
  const [open, setOpen] = useState(false);
  const [drafts, setDrafts] = useState<Record<CopyField, string>>(NO_DRAFTS);
  const [errors, setErrors] = useState<CopyErrors>({});
  /** Aturan alamat (pelanggan, alamat channel) — diisi `EmailCopiesBar` dari data channel. */
  const contextRef = useRef<CopyContext>({ customer: null, own: [] });
  const ccRef = useRef<HTMLInputElement>(null);
  const bccRef = useRef<HTMLInputElement>(null);

  const reset = useCallback(() => {
    setCopies(EMPTY);
    setOpen(false);
    setDrafts(NO_DRAFTS);
    setErrors({});
  }, []);

  const setError = useCallback((field: CopyField, text: string | null) => {
    setErrors((current) => {
      const next = { ...current };
      if (text) next[field] = text;
      else delete next[field];
      return next;
    });
  }, []);

  const setDraft = useCallback(
    (field: CopyField, value: string, reason: 'input' | 'commit' = 'input') => {
      setDrafts((current) => ({ ...current, [field]: value }));
      // Ketikan yang salah dihapus sendiri: galatnya ikut hilang.
      if (reason === 'input' && value.trim() === '') setError(field, null);
    },
    [setError],
  );

  /**
   * Sebelum kirim: ketikan yang belum jadi chip dijadikan alamat. Masih ada yang tidak sah (atau
   * melewati batas) → `null`: kirim dibatalkan, kolomnya dibuka & difokus dengan penjelasan, supaya
   * alamat tidak hilang diam-diam.
   */
  const finalize = (): EmailCopies | null => {
    let next = copies;
    const nextDrafts = { ...drafts };
    const nextErrors = { ...errors };
    let blocked: CopyField | null = null;
    for (const field of FIELDS) {
      const raw = drafts[field];
      if (raw.trim() === '') continue;
      const result = addCopies(next, field, splitAddressInput(raw), contextRef.current);
      next = { cc: result.cc, bcc: result.bcc };
      const left = leftoverInput(result);
      nextDrafts[field] = left;
      if (left) {
        nextErrors[field] = k.pendingInvalid(left);
        blocked ??= field;
      } else if (result.rejected.some((item) => item.reason === 'limit')) {
        nextErrors[field] = k.limit(EMAIL_MAX_EXTRA_RECIPIENTS);
        blocked ??= field;
      } else {
        const text = rejectionText(result);
        if (text) nextErrors[field] = text;
        else delete nextErrors[field];
      }
    }
    setCopies(next);
    setDrafts(nextDrafts);
    setErrors(nextErrors);
    if (blocked) {
      setOpen(true);
      const target = blocked === 'cc' ? ccRef : bccRef;
      requestAnimationFrame(() => target.current?.focus());
      return null;
    }
    return next;
  };

  return {
    copies,
    setCopies,
    open,
    setOpen,
    drafts,
    setDraft,
    errors,
    setError,
    contextRef,
    ccRef,
    bccRef,
    reset,
    finalize,
  };
}

export type EmailCopiesState = ReturnType<typeof useEmailCopies>;
