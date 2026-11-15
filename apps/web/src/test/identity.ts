import { fireEvent, screen, within } from '@testing-library/react';
import { t } from '../i18n/id';

export const TEST_PASSWORD = 'Kopi-Senja-Tenang-42';
export const TEST_CODE = '123456';

/**
 * Isi dialog konfirmasi identitas (`IdentityDialog`) yang sedang terbuka lalu tekan tombol
 * aksinya. Mengembalikan elemen dialog (masih terbuka bila server menolak konfirmasinya).
 */
export async function confirmIdentity(
  title: string,
  confirmLabel: string,
  { password = TEST_PASSWORD, code = TEST_CODE }: { password?: string; code?: string } = {},
): Promise<HTMLElement> {
  const dialog = await screen.findByRole('dialog', { name: title });
  fireEvent.change(within(dialog).getByLabelText(t.identity.password), {
    target: { value: password },
  });
  fireEvent.change(within(dialog).getByLabelText(t.identity.code), { target: { value: code } });
  fireEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
  return dialog;
}
