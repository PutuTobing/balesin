import { useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../../lib/cx';
import { niceScale } from './report-logic';
import styles from './Reports.module.css';

export interface BarDatum {
  key: string;
  /** Label sumbu X (singkat). */
  label: string;
  /** Teks tooltip/pembaca layar satu batang. */
  title: string;
  /** Nilai per seri, ditumpuk dari bawah (urutan sama dengan `series`). */
  values: number[];
}

export interface BarSeries {
  name: string;
  /** Kelas warna dari token (`seriesPrimary`, `seriesTeal`). */
  tone: 'primary' | 'teal';
}

const HEIGHT = 200;
const AXIS_LEFT = 36;
const AXIS_BOTTOM = 24;
const TOP = 8;
const GAP = 2;

/**
 * Grafik batang SVG sendiri (tanpa pustaka): satu sumbu Y, batang bertumpuk tipis dengan sela 2px,
 * ujung atas membulat, garis bantu samar. Lebar mengikuti wadah (ResizeObserver). Warna hanya dari
 * token lewat kelas CSS. Setiap batang punya `<title>` (tooltip & pembaca layar); grafik itu
 * sendiri bernama `aria-label`, dan pemanggil menyediakan tabel alternatif.
 */
export function BarChart({
  data,
  series,
  label,
  labelEvery,
}: {
  data: readonly BarDatum[];
  series: readonly BarSeries[];
  label: string;
  /** Tampilkan label sumbu X tiap n batang (bawaan: otomatis ±8 label). */
  labelEvery?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(640);
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const measure = () => {
      const next = Math.round(element.getBoundingClientRect().width);
      if (next > 0) setWidth(next);
    };
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);

  const max = Math.max(
    0,
    ...data.map((item) => item.values.reduce((sum, value) => sum + value, 0)),
  );
  const { top, step } = niceScale(max);
  const plotWidth = Math.max(1, width - AXIS_LEFT);
  const plotHeight = HEIGHT - AXIS_BOTTOM - TOP;
  const slot = plotWidth / Math.max(1, data.length);
  const barWidth = Math.max(2, Math.min(28, slot * 0.7));
  const every =
    labelEvery ?? Math.max(1, Math.ceil(data.length / Math.max(2, Math.floor(plotWidth / 56))));
  const y = (value: number) => TOP + plotHeight - (value / top) * plotHeight;
  const ticks = Array.from({ length: Math.round(top / step) + 1 }, (_, index) => index * step);

  return (
    <div ref={ref} className={styles.chart}>
      <svg
        role="img"
        aria-label={label}
        width={width}
        height={HEIGHT}
        viewBox={`0 0 ${String(width)} ${String(HEIGHT)}`}
        className={styles.svg}
      >
        {ticks.map((tick) => (
          <g key={tick}>
            <line
              x1={AXIS_LEFT}
              x2={width}
              y1={y(tick)}
              y2={y(tick)}
              className={tick === 0 ? styles.baseline : styles.grid}
            />
            <text x={AXIS_LEFT - 8} y={y(tick)} className={styles.axisY} dominantBaseline="middle">
              {tick.toLocaleString('id-ID')}
            </text>
          </g>
        ))}
        {data.map((item, index) => {
          const center = AXIS_LEFT + slot * index + slot / 2;
          let base = 0;
          return (
            <g key={item.key} className={styles.barGroup}>
              <title>{item.title}</title>
              {/* Area sentuh setinggi plot: lebih besar dari batangnya. */}
              <rect
                x={center - slot / 2}
                y={TOP}
                width={slot}
                height={plotHeight}
                className={styles.hit}
              />
              {item.values.map((value, position) => {
                if (value <= 0) return null;
                const bottom = y(base);
                base += value;
                const topY = y(base);
                const last = item.values.slice(position + 1).every((rest) => rest <= 0);
                const height = Math.max(1, bottom - topY - (position > 0 ? GAP : 0));
                const radius = last ? Math.min(4, barWidth / 2, height) : 0;
                const tone = series[position]?.tone ?? 'primary';
                return (
                  <path
                    key={position}
                    className={cx(
                      styles.bar,
                      tone === 'teal' ? styles.seriesTeal : styles.seriesPrimary,
                    )}
                    d={roundedTop(
                      center - barWidth / 2,
                      bottom - (position > 0 ? GAP : 0) - height,
                      barWidth,
                      height,
                      radius,
                    )}
                  />
                );
              })}
              {index % every === 0 ? (
                <text x={center} y={HEIGHT - 6} className={styles.axisX} textAnchor="middle">
                  {item.label}
                </text>
              ) : null}
            </g>
          );
        })}
      </svg>
    </div>
  );
}

/** Persegi dengan dua sudut atas membulat (ujung data), alas rata di garis dasar. */
function roundedTop(x: number, y: number, width: number, height: number, radius: number): string {
  const r = Math.max(0, radius);
  return [
    `M${String(x)},${String(y + height)}`,
    `V${String(y + r)}`,
    `Q${String(x)},${String(y)} ${String(x + r)},${String(y)}`,
    `H${String(x + width - r)}`,
    `Q${String(x + width)},${String(y)} ${String(x + width)},${String(y + r)}`,
    `V${String(y + height)}`,
    'Z',
  ].join(' ');
}

/** Legenda (≥ 2 seri): kotak warna + nama; teks memakai warna tinta, bukan warna seri. */
export function ChartLegend({ series }: { series: readonly BarSeries[] }) {
  return (
    <ul className={styles.legend}>
      {series.map((item) => (
        <li key={item.name} className={styles.legendItem}>
          <span
            className={cx(
              styles.swatch,
              item.tone === 'teal' ? styles.seriesTeal : styles.seriesPrimary,
            )}
            aria-hidden="true"
          />
          {item.name}
        </li>
      ))}
    </ul>
  );
}
