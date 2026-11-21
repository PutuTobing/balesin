import type { MessageTemplate } from '@balesin/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';

/** Kunci cache template Meta (Pengaturan → Template, pemilih template di inbox). */
export const templateKeys = {
  all: ['templates'] as const,
  list: ['templates', 'list'] as const,
  detail: (id: string) => ['templates', 'detail', id] as const,
  presets: ['templates', 'presets'] as const,
  approved: (channelId: string) => ['templates', 'approved', channelId] as const,
};

/** Semua template organisasi (kecuali yang sudah dihapus di Meta); disaring di klien. */
export const templatesQuery = queryOptions({
  queryKey: templateKeys.list,
  queryFn: ({ signal }) => endpoints.templates.list({}, signal),
});

export const templateQuery = (templateId: string) =>
  queryOptions({
    queryKey: templateKeys.detail(templateId),
    queryFn: ({ signal }) => endpoints.templates.get(templateId, signal),
  });

export const templatePresetsQuery = queryOptions({
  queryKey: templateKeys.presets,
  queryFn: ({ signal }) => endpoints.templates.presets(signal),
  staleTime: Infinity,
});

/** Template DISETUJUI untuk satu nomor (pemilih template di composer / percakapan baru). */
export const approvedTemplatesQuery = (channelId: string) =>
  queryOptions({
    queryKey: templateKeys.approved(channelId),
    queryFn: ({ signal }) => endpoints.templates.list({ channelId, status: 'APPROVED' }, signal),
    staleTime: 60_000,
  });

/** Simpan template terbaru ke cache detail + segarkan daftar. */
export function storeTemplate(queryClient: QueryClient, template: MessageTemplate): void {
  queryClient.setQueryData(templateKeys.detail(template.id), { template });
  void queryClient.invalidateQueries({ queryKey: templateKeys.list });
  void queryClient.invalidateQueries({ queryKey: ['templates', 'approved'] });
}

/**
 * Pesan sekali-tampil yang dibawa pindah halaman (mis. "Draf disimpan" setelah draf baru dibuat lalu
 * editor pindah ke alamat template-nya). Dibaca dan dikosongkan oleh halaman tujuan.
 */
export interface TemplateFlash {
  message: string;
  tone: 'success' | 'danger';
}
let flash: TemplateFlash | null = null;
export function setTemplateFlash(message: string, tone: TemplateFlash['tone'] = 'success'): void {
  flash = { message, tone };
}
export function takeTemplateFlash(): TemplateFlash | null {
  const taken = flash;
  flash = null;
  return taken;
}
