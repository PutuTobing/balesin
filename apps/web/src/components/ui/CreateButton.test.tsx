import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { t } from '../../i18n/id';
import { CreateButton } from './CreateButton';
import { FormActions } from './FormActions';

describe('CreateButton', () => {
  it('nama aksesibel = label lengkap; label pendek HP tersembunyi dari pembaca layar', () => {
    const onClick = vi.fn();
    render(<CreateButton label="Buat konektor" onClick={onClick} />);
    const button = screen.getByRole('button', { name: 'Buat konektor' });
    expect(button).toHaveTextContent('Buat konektor');
    const short = screen.getByText(t.common.createShort, { exact: true });
    expect(short).toHaveAttribute('aria-hidden', 'true');
    fireEvent.click(button);
    expect(onClick).toHaveBeenCalledOnce();
  });
});

describe('FormActions', () => {
  it('keterangan meta lebih dulu, tombol berwarna terakhir di DOM (kanan desktop, atas di HP)', () => {
    render(
      <FormActions meta="Terakhir diubah kemarin">
        <button type="button">Kirim uji</button>
        <button type="submit">Simpan</button>
      </FormActions>,
    );
    const container = screen.getByText('Terakhir diubah kemarin').parentElement!;
    const children = Array.from(container.children).map((node) => node.textContent);
    expect(children).toEqual(['Terakhir diubah kemarin', 'Kirim uji', 'Simpan']);
  });

  it('aksi destruktif dirender pertama (kiri desktop, paling bawah HP), terpisah dari gugus simpan', () => {
    render(
      <FormActions danger={<button type="button">Hapus alarm</button>}>
        <button type="submit">Simpan</button>
      </FormActions>,
    );
    const danger = screen.getByRole('button', { name: 'Hapus alarm' }).parentElement!;
    const container = danger.parentElement!;
    expect(container.firstElementChild).toBe(danger);
    expect(container.lastElementChild).toHaveTextContent('Simpan');
  });
});
