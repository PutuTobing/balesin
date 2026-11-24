import type { ReactNode } from 'react';
import styles from './illustrations.module.css';

/**
 * Ilustrasi SEMENTARA yang netral untuk keadaan kosong: skema kecil dari isi layar,
 * digambar dengan warna token sehingga ikut tema terang/gelap.
 * Pose satuan Kak Sky (docs/BRANDING-PROMPTS.md Prompt 2: `kak-sky-inbox-empty.png`, dst.)
 * belum tersedia; setelah ada, ganti pemakaian komponen di sini dengan pose yang sesuai.
 */
function Frame({ children }: { children: ReactNode }) {
  return (
    <svg viewBox="0 0 160 120" className={styles.frame} aria-hidden="true" focusable="false">
      {children}
    </svg>
  );
}

/** Persegi membulat dengan satu sudut "ekor" yang lebih tajam, seperti bubble chat. */
function bubblePath(x: number, y: number, w: number, h: number, tail: 'left' | 'right'): string {
  const r = Math.min(14, h / 2);
  const bl = tail === 'left' ? 4 : r;
  const br = tail === 'right' ? 4 : r;
  return [
    `M${x + r} ${y}`,
    `h${w - 2 * r}`,
    `a${r} ${r} 0 0 1 ${r} ${r}`,
    `v${h - r - br}`,
    `a${br} ${br} 0 0 1 ${-br} ${br}`,
    `h${-(w - br - bl)}`,
    `a${bl} ${bl} 0 0 1 ${-bl} ${-bl}`,
    `v${-(h - r - bl)}`,
    `a${r} ${r} 0 0 1 ${r} ${-r}`,
    'z',
  ].join('');
}

function Bar({
  x,
  y,
  w,
  className = styles.bar,
}: {
  x: number;
  y: number;
  w: number;
  className?: string;
}) {
  return <rect x={x} y={y} width={w} height={5} rx={2.5} className={className} />;
}

/** Inbox: pesan pelanggan, balasan tim, dan pelanggan yang sedang mengetik. */
export function ChatIllustration() {
  return (
    <Frame>
      <path d={bubblePath(8, 8, 98, 40, 'left')} className={styles.card} />
      <Bar x={23} y={21} w={58} />
      <Bar x={23} y={31} w={38} />
      <path d={bubblePath(54, 56, 98, 30, 'right')} className={styles.tint} />
      <Bar x={69} y={68.5} w={62} className={styles.tintBar} />
      <path d={bubblePath(8, 94, 50, 22, 'left')} className={styles.card} />
      <circle cx={24} cy={105} r={2.5} className={styles.muted} />
      <circle cx={33} cy={105} r={2.5} className={styles.muted} />
      <circle cx={42} cy={105} r={2.5} className={styles.muted} />
      <circle cx={103} cy={11} r={5} className={styles.accent} />
    </Frame>
  );
}

/** Kontak: daftar orang dengan nama, nomor, dan tag. */
export function ContactsIllustration() {
  const rows = [26, 60, 94];
  return (
    <Frame>
      <rect x={16} y={9} width={128} height={102} rx={10} className={styles.card} />
      <path d="M16 43h128M16 77h128" className={styles.stroke} />
      {rows.map((cy, index) => (
        <g key={cy}>
          <circle cx={38} cy={cy} r={10} className={index === 0 ? styles.tint : styles.soft} />
          <Bar x={58} y={cy - 7.5} w={index === 1 ? 40 : 50} />
          <Bar x={58} y={cy + 2.5} w={index === 2 ? 36 : 28} className={styles.soft} />
        </g>
      ))}
      <rect x={112} y={21} width={22} height={10} rx={5} className={styles.tint} />
      <rect x={116} y={55} width={18} height={10} rx={5} className={styles.soft} />
      <circle cx={46} cy={18} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Broadcast: satu pesan dikirim ke banyak penerima. */
export function BroadcastIllustration() {
  const recipients = [22, 60, 98];
  return (
    <Frame>
      <path d="M74 60h11" className={styles.stem} />
      <path
        d="M90.5 58C104 54 102 22 124 22M92 60h32M90.5 62C104 66 102 98 124 98"
        className={styles.link}
      />
      <circle cx={88} cy={60} r={3} className={styles.node} />
      <path d={bubblePath(8, 40, 66, 40, 'right')} className={styles.tint} />
      <Bar x={22} y={53} w={38} className={styles.tintBar} />
      <Bar x={22} y={63} w={24} className={styles.tintBar} />
      {recipients.map((cy) => (
        <circle key={cy} cx={137} cy={cy} r={12} className={styles.card} />
      ))}
      {recipients.map((cy) => (
        <Bar key={cy} x={131} y={cy - 2.5} w={12} />
      ))}
      <circle cx={146} cy={13} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Tiket: kartu pekerjaan dengan status, penanggung jawab, dan tenggat. */
export function TicketsIllustration() {
  return (
    <Frame>
      <rect x={40} y={8} width={104} height={70} rx={10} className={styles.cardBack} />
      <rect x={16} y={30} width={116} height={82} rx={10} className={styles.card} />
      <rect x={28} y={42} width={38} height={12} rx={6} className={styles.tint} />
      <Bar x={28} y={64} w={78} />
      <Bar x={28} y={74} w={52} className={styles.soft} />
      <circle cx={35} cy={96} r={7} className={styles.soft} />
      <Bar x={48} y={93.5} w={30} className={styles.soft} />
      <rect x={106} y={89} width={14} height={14} rx={4} className={styles.stroke} />
      <circle cx={132} cy={30} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Laporan: grafik batang dengan satu puncak. */
export function ReportsIllustration() {
  const bars: [x: number, height: number][] = [
    [30, 20],
    [51, 34],
    [72, 26],
    [93, 50],
    [114, 38],
  ];
  return (
    <Frame>
      <rect x={12} y={9} width={136} height={102} rx={10} className={styles.card} />
      <Bar x={26} y={22} w={44} />
      <path d="M26 46h108M26 70h108" className={styles.guide} />
      {bars.map(([x, height], index) => (
        <rect
          key={x}
          x={x}
          y={94 - height}
          width={16}
          height={height}
          rx={3}
          className={index === 3 ? styles.primary : styles.bar}
        />
      ))}
      <path d="M26 94.75h108" className={styles.stroke} />
      <circle cx={101} cy={34} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Channel: HP dengan chat masuk, tersambung garis putus-putus ke kotak inbox. */
export function ChannelIllustration() {
  return (
    <Frame>
      <rect x={14} y={10} width={52} height={100} rx={10} className={styles.card} />
      <rect x={32} y={18} width={16} height={4} rx={2} className={styles.soft} />
      <path d={bubblePath(22, 34, 36, 18, 'left')} className={styles.soft} />
      <path d={bubblePath(28, 58, 30, 16, 'right')} className={styles.tint} />
      <path d={bubblePath(22, 80, 28, 16, 'left')} className={styles.soft} />
      <path d="M70 60C86 60 84 42 100 42" className={styles.link} />
      <circle cx={70} cy={60} r={3} className={styles.node} />
      <rect x={100} y={22} width={48} height={76} rx={10} className={styles.card} />
      <circle cx={114} cy={40} r={6} className={styles.tint} />
      <Bar x={124} y={37.5} w={16} />
      <circle cx={114} cy={60} r={6} className={styles.soft} />
      <Bar x={124} y={57.5} w={12} className={styles.soft} />
      <circle cx={114} cy={80} r={6} className={styles.soft} />
      <Bar x={124} y={77.5} w={14} className={styles.soft} />
      <circle cx={144} cy={24} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Template email: lembar email bermerek (kepala, isi, tombol bayar) dengan penanda variabel. */
export function EmailTemplateIllustration() {
  return (
    <Frame>
      <rect x={40} y={6} width={100} height={70} rx={10} className={styles.cardBack} />
      <rect x={20} y={20} width={112} height={92} rx={10} className={styles.card} />
      <rect x={20.75} y={20.75} width={110.5} height={20} rx={9.25} className={styles.tint} />
      <circle cx={36} cy={30.75} r={5} className={styles.primary} />
      <Bar x={48} y={28.25} w={30} className={styles.tintBar} />
      <Bar x={32} y={52} w={58} />
      <rect x={94} y={49.5} width={26} height={10} rx={5} className={styles.dashed} />
      <Bar x={32} y={64} w={80} className={styles.soft} />
      <Bar x={32} y={74} w={64} className={styles.soft} />
      <rect x={32} y={88} width={40} height={12} rx={6} className={styles.primary} />
      <circle cx={140} cy={14} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Riwayat email: amplop keluar dengan daftar status di belakangnya. */
export function EmailSentIllustration() {
  return (
    <Frame>
      <rect x={70} y={12} width={78} height={96} rx={10} className={styles.card} />
      {[30, 54, 78].map((y) => (
        <g key={y}>
          <circle cx={84} cy={y} r={4} className={y === 54 ? styles.accent : styles.primary} />
          <Bar x={94} y={y - 2.5} w={40} className={styles.soft} />
        </g>
      ))}
      <rect x={10} y={40} width={74} height={50} rx={8} className={styles.card} />
      <path d="M14 46l33 22 33-22" className={styles.stroke} />
      <path d="M88 65h-4" className={styles.link} />
      <circle cx={18} cy={34} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Tidak ditemukan: bingkai kosong dan kaca pembesar. */
export function NotFoundIllustration() {
  return (
    <Frame>
      <rect x={22} y={12} width={116} height={88} rx={10} className={styles.dashed} />
      <circle cx={74} cy={52} r={19} className={styles.lens} />
      <Bar x={63} y={46} w={22} />
      <Bar x={63} y={56} w={13} />
      <path d="M88 66l15 15" className={styles.handle} />
      <circle cx={120} cy={28} r={4} className={styles.accent} />
    </Frame>
  );
}

/** Gagal dimuat: halaman yang isinya tidak sampai, dengan lencana galat. */
export function LoadFailedIllustration() {
  return (
    <Frame>
      <rect x={16} y={12} width={128} height={96} rx={10} className={styles.card} />
      <Bar x={30} y={28} w={44} />
      <Bar x={30} y={46} w={88} className={styles.soft} />
      <Bar x={30} y={58} w={64} className={styles.soft} />
      <Bar x={30} y={70} w={76} className={styles.soft} />
      <circle cx={128} cy={92} r={17} className={styles.badge} />
      <path d="M128 83.5v10" className={styles.badgeMark} />
      <circle cx={128} cy={100.5} r={2} className={styles.badgeDot} />
    </Frame>
  );
}

/** Email: amplop terbuka berisi surat, dengan lencana centang (akun email terhubung). */
export function MailboxIllustration() {
  return (
    <Frame>
      <rect x={20} y={50} width={104} height={62} rx={10} className={styles.card} />
      <rect x={42} y={16} width={82} height={66} rx={8} className={styles.card} />
      <Bar x={54} y={30} w={44} />
      <Bar x={54} y={42} w={58} className={styles.tintBar} />
      <Bar x={54} y={54} w={36} className={styles.soft} />
      <path
        d="M20.75 64L72 94l51.25-30v38a9.25 9.25 0 0 1-9.25 9.25H30a9.25 9.25 0 0 1-9.25-9.25z"
        className={styles.pocket}
      />
      <circle cx={126} cy={18} r={11} className={styles.accent} />
      <path d="M121 18.5l3.5 3.5 6.5-7" className={styles.check} />
    </Frame>
  );
}
