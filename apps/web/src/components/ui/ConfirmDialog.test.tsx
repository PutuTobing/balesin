import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { ConfirmDialog } from './ConfirmDialog';

function open(confirmVariant: 'danger' | 'secondary' | 'primary') {
  render(
    <ConfirmDialog
      open
      title="Judul?"
      body="Isi."
      cancelLabel="Batal"
      confirmLabel="Lanjut"
      confirmVariant={confirmVariant}
      onCancel={vi.fn()}
      onConfirm={vi.fn()}
    />,
  );
  const cancel = screen.getByRole('button', { name: 'Batal' });
  const confirm = screen.getByRole('button', { name: 'Lanjut' });
  return { cancel, confirm, actions: cancel.parentElement! };
}

describe('ConfirmDialog: satu tombol berwarna, selalu terakhir', () => {
  it('aksi merah: batal berbingkai di depan, aksi merah terakhir; fokus awal di batal', () => {
    const { cancel, confirm, actions } = open('danger');
    expect(actions.lastElementChild).toBe(confirm);
    expect(confirm).toHaveClass(/danger/);
    expect(cancel).toHaveClass(/secondary/);
    expect(cancel).toHaveFocus();
  });

  it('aksi biru: sama, aksi biru terakhir', () => {
    const { cancel, confirm, actions } = open('primary');
    expect(actions.lastElementChild).toBe(confirm);
    expect(cancel).toHaveClass(/secondary/);
  });

  it('aksi netral ("Tinggalkan"): batal yang aman jadi tombol biru di posisi terakhir', () => {
    const { cancel, confirm, actions } = open('secondary');
    expect(actions.lastElementChild).toBe(cancel);
    expect(cancel).toHaveClass(/primary/);
    expect(confirm).toHaveClass(/secondary/);
    expect(cancel).toHaveFocus();
  });
});
