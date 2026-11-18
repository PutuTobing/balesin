import type { ContactFilter, IdentityConfirmation } from '@balesin/shared';
import { Download } from 'lucide-react';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { fileDate, fileNameFrom, saveBlob } from '../../lib/download';
import { IdentityDialog } from '../identity/IdentityDialog';
import { isConfirmationError } from '../identity/confirmation-error';
import { hasContactFilter } from './contact-search';

const c = t.contacts;

export type ExportResult = { rows: number } | { error: unknown };

/**
 * Ekspor massal kontak ke CSV (`contacts.export`): konfirmasi identitas → `POST /contacts/export`
 * dengan saringan yang sedang aktif → Blob diunduh. Berisi data pribadi: tidak disimpan di cache.
 */
export function ExportContactsButton({
  filter,
  disabled,
  onResult,
}: {
  filter: ContactFilter;
  disabled?: boolean;
  /** Hasil ditampilkan pemanggil di isi halaman (`null` = mulai ekspor baru). */
  onResult: (result: ExportResult | null) => void;
}) {
  const [open, setOpen] = useState(false);
  const setResult = onResult;
  const buttonRef = useRef<HTMLButtonElement>(null);

  const run = async (confirmation: IdentityConfirmation) => {
    try {
      const { blob, headers } = await endpoints.crm.exportContacts(filter, confirmation);
      saveBlob(blob, fileNameFrom(headers, c.exportFileName(fileDate())));
      const rows = Number(headers.get('x-export-rows') ?? '');
      setOpen(false);
      setResult({ rows: Number.isFinite(rows) ? rows : 0 });
    } catch (caught) {
      // Password/kode salah & 429 tetap di dialog; selain itu (409 terlalu banyak, jaringan) di luar.
      if (isConfirmationError(caught)) throw caught;
      setOpen(false);
      setResult({ error: caught });
    }
  };

  return (
    <>
      <Button
        ref={buttonRef}
        disabled={disabled}
        onClick={() => {
          setResult(null);
          setOpen(true);
        }}
      >
        <Icon icon={Download} size={16} />
        {c.exportAction}
      </Button>
      <IdentityDialog
        open={open}
        title={c.exportTitle}
        body={c.exportBody(hasContactFilter(filter))}
        confirmLabel={c.exportConfirm}
        pendingLabel={c.exporting}
        requireCode
        onConfirm={run}
        onCancel={() => setOpen(false)}
        returnFocusRef={buttonRef}
      />
    </>
  );
}
