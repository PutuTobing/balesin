import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { t } from '../../i18n/id';
import { scrollToTopOfContainer } from '../../lib/scroll';
import styles from './Channels.module.css';
import { SCROLL_KEYS, isScrolledToBottom, pickActiveSection } from './section-nav';

const copy = t.channels.sections;

/** Urutan sama dengan kartu di halaman nomor (`id` kartu = anchor). */
const SECTIONS = [
  { id: 'ringkasan', label: copy.summary },
  { id: 'diagnosis', label: copy.diagnosis },
  { id: 'webhook', label: t.channels.webhook.title },
  { id: 'profil-bisnis', label: t.channels.profile.title },
  { id: 'nama', label: t.channels.rename.title },
  { id: 'kredensial', label: t.channels.credentials.title },
  { id: 'akses', label: t.channels.access.title },
] as const;

/**
 * Daftar bagian halaman nomor yang menempel di kanan (desktop): halaman ±3 layar bisa dilompati
 * tanpa menggulir. Di HP/tablet tidak tampil.
 *
 * Penanda (`aria-current="location"`):
 *  - setelah tautan dipilih, bagian itu DIKUNCI sampai pengguna sendiri menggulir (roda, sentuh,
 *    tombol gulir). Guliran dari kode (lompatan itu sendiri, "Ganti kredensial") tidak melepasnya,
 *    jadi bagian pendek atau bagian di dasar halaman tetap tertanda;
 *  - saat menggulir bebas: bagian terakhir yang judulnya sudah sampai di atas wadah, atau bagian
 *    terakhir bila wadah sudah di dasar (`pickActiveSection`).
 */
export function SectionNav() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);
  const navRef = useRef<HTMLElement>(null);
  const pinnedRef = useRef<string | null>(null);

  useEffect(() => {
    const nav = navRef.current;
    if (!nav) return;
    // Didengarkan di dokumen (scroll lewat capture): wadah gulir = elemen yang tergulir dan memuat
    // navigasi ini, tanpa bergantung pada gaya terhitung.
    const pick = (event: Event) => {
      const box = event.target;
      if (!(box instanceof HTMLElement) || !box.contains(nav) || pinnedRef.current) return;
      const positions = SECTIONS.flatMap((section) => {
        const element = document.getElementById(section.id);
        return element ? [{ id: section.id, top: element.getBoundingClientRect().top }] : [];
      });
      const next = pickActiveSection(
        positions,
        box.getBoundingClientRect().top,
        isScrolledToBottom(box),
      );
      if (next) setActive(next);
    };
    const release = () => {
      pinnedRef.current = null;
    };
    const onKey = (event: KeyboardEvent) => {
      if (SCROLL_KEYS.has(event.key)) release();
    };
    document.addEventListener('scroll', pick, { capture: true, passive: true });
    document.addEventListener('wheel', release, { passive: true });
    document.addEventListener('touchmove', release, { passive: true });
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('scroll', pick, { capture: true });
      document.removeEventListener('wheel', release);
      document.removeEventListener('touchmove', release);
      document.removeEventListener('keydown', onKey);
    };
  }, []);

  const jump = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    // Tanpa mengubah alamat (riwayat router tetap bersih); fokus ikut pindah untuk keyboard.
    event.preventDefault();
    pinnedRef.current = id;
    setActive(id);
    scrollToTopOfContainer(target);
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
  };

  return (
    <nav ref={navRef} className={styles.sectionNav} aria-label={copy.label}>
      <ul className={styles.sectionList}>
        {SECTIONS.map((section) => (
          <li key={section.id}>
            <a
              href={`#${section.id}`}
              className={styles.sectionLink}
              aria-current={active === section.id ? 'location' : undefined}
              onClick={(event) => jump(event, section.id)}
            >
              {section.label}
            </a>
          </li>
        ))}
      </ul>
    </nav>
  );
}
