import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BrandMark } from './BrandMark';
import { BrandContext, defaultBrand } from './brand';

describe('BrandMark (white-label)', () => {
  it('menggambar tanda merek bawaan sebagai SVG dekoratif', () => {
    const { container } = render(<BrandMark />);

    const svg = container.querySelector('svg');
    expect(svg).toHaveAttribute('aria-hidden', 'true');
    expect(container.querySelector('img')).toBeNull();
  });

  it('memakai logo organisasi bila diatur', () => {
    const { container } = render(
      <BrandContext value={{ ...defaultBrand, logoUrl: '/media/logo-organisasi.png' }}>
        <BrandMark />
      </BrandContext>,
    );

    expect(container.querySelector('img')).toHaveAttribute('src', '/media/logo-organisasi.png');
    expect(container.querySelector('svg')).toBeNull();
  });
});
