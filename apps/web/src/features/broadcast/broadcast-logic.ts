import {
  broadcastRequiredVariables,
  type BroadcastCampaign,
  type BroadcastMapping,
  type BroadcastReport,
  type BroadcastStatus,
  type BroadcastVariableSource,
  type MessageTemplate,
  type TemplateContent,
} from '@balesin/shared';
import type { StatusTone } from '../../components/ui/StatusBadge';

/**
 * Logika murni UI broadcast (docs/KONTRAK-API-BROADCAST.md): template yang boleh dipakai, variabel
 * yang wajib dipetakan, kelengkapan pemetaan, progres, dan jadwal di zona waktu organisasi.
 */

/** Template yang boleh dipakai broadcast: DISETUJUI, bukan OTP, bukan judul media (409 di server). */
export function usableForBroadcast(template: MessageTemplate): boolean {
  if (template.status !== 'APPROVED' || template.category === 'AUTHENTICATION') return false;
  const header = template.content.header;
  return header === null || header.format === 'TEXT';
}

export interface MappingSlot {
  /** Kunci galat/isian: `body.1`, `header`, `buttons.0`. */
  key: string;
  kind: 'body' | 'header' | 'button';
  /** Nama variabel body / indeks tombol. */
  name: string;
}

export function mappingSlots(content: TemplateContent): MappingSlot[] {
  const required = broadcastRequiredVariables(content);
  return [
    ...(required.header ? [{ key: 'header', kind: 'header' as const, name: 'header' }] : []),
    ...required.body.map((name) => ({ key: `body.${name}`, kind: 'body' as const, name })),
    ...required.buttons.map((index) => ({
      key: `buttons.${index}`,
      kind: 'button' as const,
      name: index,
    })),
  ];
}

export function slotSource(
  mapping: BroadcastMapping,
  slot: MappingSlot,
): BroadcastVariableSource | null {
  if (slot.kind === 'header') return mapping.header;
  if (slot.kind === 'body') return mapping.body[slot.name] ?? null;
  return mapping.buttons[slot.name] ?? null;
}

export function withSlot(
  mapping: BroadcastMapping,
  slot: MappingSlot,
  source: BroadcastVariableSource | null,
): BroadcastMapping {
  if (slot.kind === 'header') return { ...mapping, header: source };
  const field = slot.kind === 'body' ? 'body' : 'buttons';
  const next = { ...mapping[field] };
  if (source) next[slot.name] = source;
  else delete next[slot.name];
  return { ...mapping, [field]: next };
}

/** Pemetaan lengkap: setiap variabel punya kolom (yang ada) atau teks tetap tidak kosong. */
export function mappingComplete(
  mapping: BroadcastMapping,
  slots: readonly MappingSlot[],
  columns: readonly string[],
): boolean {
  return slots.every((slot) => {
    const source = slotSource(mapping, slot);
    if (!source) return false;
    return source.kind === 'column' ? columns.includes(source.column) : source.value.trim() !== '';
  });
}

/**
 * Tebakan awal pemetaan: variabel bernama yang sama dengan kolom (`nama` ↔ kolom `nama`), atau
 * `{{1}}` ↔ kolom nama bila ada. Hanya mengisi slot yang masih kosong.
 */
export function guessMapping(
  mapping: BroadcastMapping,
  slots: readonly MappingSlot[],
  columns: readonly string[],
): BroadcastMapping {
  let next = mapping;
  const lower = columns.map((column) => column.toLowerCase());
  for (const slot of slots) {
    if (slotSource(next, slot)) continue;
    const exact = lower.indexOf(slot.name.toLowerCase());
    const byName = slot.name === '1' ? lower.findIndex((column) => /^nama/.test(column)) : -1;
    const index = exact >= 0 ? exact : byName;
    if (index >= 0) next = withSlot(next, slot, { kind: 'column', column: columns[index]! });
  }
  return next;
}

export function statusTone(status: BroadcastStatus): StatusTone {
  switch (status) {
    case 'running':
    case 'completed':
      return 'success';
    case 'pending_approval':
    case 'scheduled':
    case 'paused':
      return 'warning';
    case 'cancelled':
      return 'danger';
    case 'draft':
      return 'neutral';
  }
}

/** Kampanye yang masih bergerak (laporan & detail disegarkan berkala). */
export function isLive(status: BroadcastStatus): boolean {
  return status === 'running' || status === 'scheduled' || status === 'pending_approval';
}

/**
 * Penerima yang sudah DIPROSES kampanye (pesan dibuat, dilewati, atau dibatalkan) dari seluruh
 * penerima. Pesan yang masih menunggu jawaban Meta tetap terhitung diproses (tampil terpisah sebagai
 * "Sedang dikirim").
 */
export function progressOf(report: Pick<BroadcastReport, 'recipients' | 'pending'>): {
  done: number;
  total: number;
  ratio: number;
} {
  const total = report.recipients;
  const done = Math.max(0, total - report.pending);
  return { done, total, ratio: total === 0 ? 0 : Math.min(1, done / total) };
}

/** Progres dari ringkasan kampanye (daftar): penerima tertunda belum diproses. */
export function campaignProgress(campaign: Pick<BroadcastCampaign, 'counts'>) {
  const total = campaign.counts.recipients;
  const done = Math.max(0, total - campaign.counts.pending);
  return { done, total, ratio: total === 0 ? 0 : Math.min(1, done / total) };
}

// ── Jadwal di zona waktu organisasi ────────────────────────────────────────

function zoneOffsetMs(instant: number, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((part) => part.type === type)?.value ?? 0);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(instant / 1000) * 1000;
}

/** `YYYY-MM-DDTHH:mm` (jam dinding di `zone`) → ISO UTC. `null` bila tidak valid. */
export function zonedToIso(local: string, zone: string): string | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!match) return null;
  const [, y, m, d, h, min] = match.map(Number) as [number, number, number, number, number, number];
  const wall = Date.UTC(y, m - 1, d, h, min);
  // Dua putaran cukup untuk peralihan DST (zona Indonesia tanpa DST).
  let instant = wall - zoneOffsetMs(wall, zone);
  instant = wall - zoneOffsetMs(instant, zone);
  return Number.isFinite(instant) ? new Date(instant).toISOString() : null;
}

/** ISO UTC → `YYYY-MM-DDTHH:mm` jam dinding di `zone` (untuk `<input type="datetime-local">`). */
export function isoToZoned(iso: string, zone: string): string {
  const instant = Date.parse(iso);
  const local = new Date(instant + zoneOffsetMs(instant, zone));
  return local.toISOString().slice(0, 16);
}

/** Tanggal & jam di zona organisasi, mis. "Sabtu, 30 Nov 2026 08.00". */
export function formatInZone(iso: string, zone: string): string {
  return new Intl.DateTimeFormat('id-ID', {
    timeZone: zone,
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(iso));
}
