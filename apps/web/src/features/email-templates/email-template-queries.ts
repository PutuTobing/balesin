import type { EmailTemplate } from '@balesin/shared';
import { queryOptions, type QueryClient } from '@tanstack/react-query';
import { endpoints } from '../../lib/api/endpoints';

/** Kunci cache Pengaturan → Template email (tahap 9.1). */
export const emailTemplateKeys = {
  all: ['email-templates'] as const,
  list: (archived: boolean) => ['email-templates', 'list', archived] as const,
  detail: (id: string) => ['email-templates', 'detail', id] as const,
  versions: (id: string) => ['email-templates', 'versions', id] as const,
  version: (id: string, version: number) => ['email-templates', 'version', id, version] as const,
  presets: ['email-templates', 'presets'] as const,
  preview: (body: string) => ['email-templates', 'preview', body] as const,
};

/** Daftar aktif atau arsip (pencarian disaring di klien; maks. 200 template per organisasi). */
export const emailTemplatesQuery = (archived = false) =>
  queryOptions({
    queryKey: emailTemplateKeys.list(archived),
    queryFn: ({ signal }) => endpoints.emailTemplates.list({ archived }, signal),
  });

export const emailTemplateQuery = (templateId: string) =>
  queryOptions({
    queryKey: emailTemplateKeys.detail(templateId),
    queryFn: ({ signal }) => endpoints.emailTemplates.get(templateId, signal),
  });

export const emailTemplateVersionsQuery = (templateId: string) =>
  queryOptions({
    queryKey: emailTemplateKeys.versions(templateId),
    queryFn: ({ signal }) => endpoints.emailTemplates.versions(templateId, signal),
  });

export const emailTemplateVersionQuery = (templateId: string, version: number) =>
  queryOptions({
    queryKey: emailTemplateKeys.version(templateId, version),
    queryFn: ({ signal }) => endpoints.emailTemplates.version(templateId, version, signal),
    staleTime: Infinity,
  });

export const emailTemplatePresetsQuery = queryOptions({
  queryKey: emailTemplateKeys.presets,
  queryFn: ({ signal }) => endpoints.emailTemplates.presets(signal),
  staleTime: Infinity,
});

/** Simpan template terbaru ke cache detail + segarkan daftar & riwayat versi. */
export function storeEmailTemplate(queryClient: QueryClient, template: EmailTemplate): void {
  queryClient.setQueryData(emailTemplateKeys.detail(template.id), { template });
  void queryClient.invalidateQueries({ queryKey: ['email-templates', 'list'] });
  void queryClient.invalidateQueries({ queryKey: emailTemplateKeys.versions(template.id) });
}

/** Pesan sekali-tampil yang dibawa pindah halaman (dibaca & dikosongkan halaman tujuan). */
let flash: string | null = null;
export function setEmailTemplateFlash(message: string): void {
  flash = message;
}
export function takeEmailTemplateFlash(): string | null {
  const taken = flash;
  flash = null;
  return taken;
}
