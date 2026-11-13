import type { ReactNode } from 'react';
import styles from './illustrations.module.css';

/**
 * Ilustrasi SEMENTARA yang netral untuk keadaan kosong: skema kecil dari isi layar,
 * digambar dengan warna token sehingga ikut tema terang/gelap.
 * Ilustrasi maskot dari assets/brand/ belum tersedia (docs/BUTUH-TOBING.md #5); setelah
 * ada, ganti pemakaian komponen di sini dengan gambar maskot yang sesuai.
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
