import { useTheme } from '../../theme/theme-context';
import { LOGIN_HERO_HEIGHT, LOGIN_HERO_WIDTH, loginHeroSources } from './login-hero-sources';

interface LoginHeroProps {
  /** Atribut `sizes` sesuai lebar tampil ilustrasi di tata letak pemakai. */
  sizes?: string;
  className?: string;
}

/**
 * Ilustrasi layar login: Kak Sky di atas awan (versi siang untuk tema terang, malam untuk
 * tema gelap). Dekoratif. Hanya versi tema yang sedang tampil yang diunduh: pilihan
 * dibuat dari tema aktif (termasuk pilihan manual), bukan `<source media>`, karena media
 * query tidak tahu pilihan tema pengguna.
 *
 * Ruang kosong ada di kiri atas gambar (untuk teks); pakai `object-fit: cover` dengan
 * `object-position` kanan bawah bila wadahnya tidak berasio 3:2.
 */
export function LoginHero({ sizes = '(max-width: 640px) 100vw, 50vw', className }: LoginHeroProps) {
  const { resolved } = useTheme();
  const sources = loginHeroSources[resolved];
  return (
    // `key`: ganti tema = elemen baru, jadi browser tidak menahan gambar tema sebelumnya.
    <picture key={resolved}>
      <source type="image/avif" srcSet={sources.avif} sizes={sizes} />
      <source type="image/webp" srcSet={sources.webp} sizes={sizes} />
      <img
        src={sources.fallback}
        alt=""
        width={LOGIN_HERO_WIDTH}
        height={LOGIN_HERO_HEIGHT}
        decoding="async"
        className={className}
      />
    </picture>
  );
}
