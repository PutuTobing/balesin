import { render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { BrandLogo } from './BrandLogo';
import { BrandMark } from './BrandMark';
import { BrandContext, defaultBrand, type Brand } from './brand';
import { symbol } from './brand-mark-shape';

function withBrand(brand: Partial<Brand>, ui: ReactNode) {
  return render(<BrandContext value={{ ...defaultBrand, ...brand }}>{ui}</BrandContext>);
}

describe('BrandMark (white-label)', () => {
  it('menggambar simbol logo bawaan sebagai SVG dekoratif berwarna token', () => {
    const { container } = render(<BrandMark />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(svg).toHaveAttribute('viewBox', symbol.squareViewBox);
    expect(container.querySelector('path')).toHaveAttribute('d', symbol.path);
    // Warna lewat kelas CSS (token), bukan atribut fill yang ditanam.
    expect(container.querySelector('[fill]')).toBeNull();
    expect(container.querySelector('img')).toBeNull();
  });

  it('varian rapat tanpa ruang sisa untuk baris rata kiri', () => {
    const { container } = render(<BrandMark fit="tight" />);

    expect(container.querySelector('svg')).toHaveAttribute('viewBox', symbol.tightViewBox);
  });

  it('memakai ikon persegi dari logo organisasi bila ada', () => {
    const icon = '/api/v1/branding/icons/icon-192.png?v=1';
    const { container } = withBrand(
      {
        logoUrl: '/media/logo-organisasi.png',
        icons: {
          favicon: '/f.png',
          appleTouchIcon: '/a.png',
          manifest: [{ src: icon, sizes: '192x192', type: 'image/png', purpose: 'any' }],
        },
      },
      <BrandMark />,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', icon);
    expect(container.querySelector('svg')).toBeNull();
  });

  it('logo tanpa ikon persegi (data lama): monogram huruf pertama nama aplikasi', () => {
    const { container } = withBrand(
      { logoUrl: '/media/logo-organisasi.png', productName: 'halo CS' },
      <BrandMark />,
    );

    expect(container.querySelector('img')).toBeNull();
    expect(container.textContent).toBe('H');
  });

  it('monogram memakai nama organisasi tanpa awalan badan usaha', () => {
    const { container } = withBrand(
      {
        logoUrl: '/media/logo-organisasi.png',
        productName: 'Layanan Maju Jaya',
        organizationName: 'PT. Maju Jaya',
      },
      <BrandMark />,
    );
    expect(container.textContent).toBe('M');
  });
});

describe('BrandLogo (white-label)', () => {
  it('logo lengkap bawaan punya nama aksesibel nama produk', () => {
    render(<BrandLogo />);

    const logo = screen.getByRole('img', { name: defaultBrand.productName });
    expect(logo.tagName.toLowerCase()).toBe('svg');
    expect(logo.querySelectorAll('ellipse')).toHaveLength(2);
  });

  it('nama produk lain ditulis sebagai teks, bukan wordmark bawaan', () => {
    const { container } = withBrand({ productName: 'Halo CS' }, <BrandLogo />);

    expect(screen.getByText('Halo CS')).toBeInTheDocument();
    expect(container.querySelector('ellipse')).toBeNull();
    expect(container.querySelector('svg')).toHaveAttribute('aria-hidden', 'true');
  });

  it('logo organisasi menggantikan logo bawaan', () => {
    withBrand({ productName: 'Halo CS', logoUrl: '/media/logo.png' }, <BrandLogo />);

    expect(screen.getByRole('img', { name: 'Halo CS' })).toHaveAttribute('src', '/media/logo.png');
  });
});
