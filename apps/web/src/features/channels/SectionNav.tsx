import { useEffect, useState, type MouseEvent } from 'react';
import { t } from '../../i18n/id';
import styles from './Channels.module.css';

const copy = t.channels.sections;

/** Urutan sama dengan kartu di halaman nomor (`id` kartu = anchor). */
const SECTIONS = [
  { id: 'ringkasan', label: copy.summary },
  { id: 'webhook', label: t.channels.webhook.title },
  { id: 'profil-bisnis', label: t.channels.profile.title },
  { id: 'nama', label: t.channels.rename.title },
  { id: 'kredensial', label: t.channels.credentials.title },
  { id: 'akses', label: t.channels.access.title },
] as const;

/**
 * Daftar bagian halaman nomor yang menempel di kanan (desktop): halaman ±3 layar bisa dilompati
 * tanpa menggulir. Bagian yang sedang terbaca ditandai. Di HP/tablet tidak tampil.
 */
export function SectionNav() {
  const [active, setActive] = useState<string>(SECTIONS[0].id);

  useEffect(() => {
    // Browser lama / jsdom: tanpa penanda bagian aktif, tautan tetap berfungsi.
    if (typeof IntersectionObserver === 'undefined') return;
    // Bagian aktif = bagian terakhir yang tepi atasnya sudah melewati 40% tinggi layar (judulnya
    // sedang/baru dibaca). Observer hanya pemicu saat tepi kartu melintasi pita itu.
    const pick = () => {
      const line = window.innerHeight * 0.4;
      let current: string = SECTIONS[0].id;
      for (const section of SECTIONS) {
        const element = document.getElementById(section.id);
        if (element && element.getBoundingClientRect().top <= line) current = section.id;
      }
      setActive(current);
    };
    const observer = new IntersectionObserver(pick, {
      rootMargin: '0px 0px -60% 0px',
      threshold: [0, 1],
    });
    for (const section of SECTIONS) {
      const element = document.getElementById(section.id);
      if (element) observer.observe(element);
    }
    return () => observer.disconnect();
  }, []);

  const jump = (event: MouseEvent<HTMLAnchorElement>, id: string) => {
    const target = document.getElementById(id);
    if (!target) return;
    // Tanpa mengubah alamat (riwayat router tetap bersih); fokus ikut pindah untuk keyboard.
    event.preventDefault();
    target.scrollIntoView({ block: 'start' });
    target.setAttribute('tabindex', '-1');
    target.focus({ preventScroll: true });
    setActive(id);
  };

  return (
    <nav className={styles.sectionNav} aria-label={copy.label}>
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
