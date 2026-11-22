import { useCallback, useState } from 'react';
import type { EmailCopies } from './email-recipients';

const EMPTY: EmailCopies = { cc: [], bcc: [] };

/** Keadaan Cc/Bcc composer channel Email (milik `Composer`, dikosongkan setelah kirim). */
export function useEmailCopies() {
  const [copies, setCopies] = useState<EmailCopies>(EMPTY);
  const [open, setOpen] = useState(false);
  const reset = useCallback(() => {
    setCopies(EMPTY);
    setOpen(false);
  }, []);
  return { copies, setCopies, open, setOpen, reset };
}

export type EmailCopiesState = ReturnType<typeof useEmailCopies>;
