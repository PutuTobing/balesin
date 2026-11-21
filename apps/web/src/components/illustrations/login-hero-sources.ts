import heroDark768Avif from '../../assets/illustrations/login-hero-dark-768.avif';
import heroDark768Webp from '../../assets/illustrations/login-hero-dark-768.webp';
import heroDark1536Avif from '../../assets/illustrations/login-hero-dark-1536.avif';
import heroDark1536Webp from '../../assets/illustrations/login-hero-dark-1536.webp';
import heroLight768Avif from '../../assets/illustrations/login-hero-768.avif';
import heroLight768Webp from '../../assets/illustrations/login-hero-768.webp';
import heroLight1536Avif from '../../assets/illustrations/login-hero-1536.avif';
import heroLight1536Webp from '../../assets/illustrations/login-hero-1536.webp';
import type { ResolvedTheme } from '../../theme/theme';

/** Ukuran asli ilustrasi (rasio 3:2). Dipasang sebagai width/height supaya tidak ada CLS. */
export const LOGIN_HERO_WIDTH = 1536;
export const LOGIN_HERO_HEIGHT = 1024;

interface HeroSources {
  avif: string;
  webp: string;
  /** Versi kecil (WebP) sebagai `src` cadangan. */
  fallback: string;
}

const srcset = (small: string, large: string) => `${small} 768w, ${large} 1536w`;

export const loginHeroSources: Record<ResolvedTheme, HeroSources> = {
  light: {
    avif: srcset(heroLight768Avif, heroLight1536Avif),
    webp: srcset(heroLight768Webp, heroLight1536Webp),
    fallback: heroLight768Webp,
  },
  dark: {
    avif: srcset(heroDark768Avif, heroDark1536Avif),
    webp: srcset(heroDark768Webp, heroDark1536Webp),
    fallback: heroDark768Webp,
  },
};
