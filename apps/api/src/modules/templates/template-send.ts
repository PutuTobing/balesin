import { AppError } from '@balesin/core';
import { messageTemplates, type DbExecutor, type MessageExtras } from '@balesin/db';
import {
  fillTemplateText,
  templateContentSchema,
  templateVariables,
  urlButtonHasVariable,
  type TemplateSendParameters,
} from '@balesin/shared';
import { and, eq } from 'drizzle-orm';

/**
 * Validasi kirim template (Fase 4, docs/KONTRAK-API-TEMPLATE.md "Kirim"): template DISETUJUI, milik
 * WABA channel percakapan, setiap variabel terisi (aturan Meta: tanpa baris baru/tab, tanpa > 4 spasi
 * berturut-turut). Hasilnya disimpan di `messages.extras.template` dan dibangun ulang worker.
 */

export type ResolvedTemplateSend = NonNullable<MessageExtras['template']> & {
  /** Isi body yang sudah diisi (teks pesan di inbox). */
  preview: string;
};

const invalid = (field: string, message: string) =>
  new AppError('VALIDATION_ERROR', { message, details: [{ location: 'body', field, message }] });

/** Nilai parameter template menurut aturan Meta. */
function checkValue(field: string, value: string | undefined): string {
  const text = value?.trim() ?? '';
  if (text === '') throw invalid(field, 'Nilai variabel template wajib diisi.');
  // Aturan Meta + review template Info 4: tanpa karakter kontrol (baris baru, CR, tab, …), pemisah
  // baris/paragraf Unicode, dan > 4 spasi berturut-turut.
  if (/[\p{Cc}\u2028\u2029]/u.test(text) || / {5,}/.test(text)) {
    throw invalid(
      field,
      'Nilai variabel tidak boleh memuat baris baru, tab, karakter kontrol, atau lebih dari 4 spasi berturut-turut.',
    );
  }
  return text;
}

export async function resolveTemplateSend(
  db: DbExecutor,
  input: {
    organizationId: string;
    channelWabaId: string;
    templateId: string;
    parameters: TemplateSendParameters;
  },
): Promise<ResolvedTemplateSend> {
  const [template] = await db
    .select()
    .from(messageTemplates)
    .where(
      and(
        eq(messageTemplates.organizationId, input.organizationId),
        eq(messageTemplates.id, input.templateId),
      ),
    )
    .limit(1);
  if (!template) throw new AppError('NOT_FOUND', { message: 'Template tidak ditemukan.' });
  if (template.status !== 'APPROVED') {
    throw new AppError('CONFLICT', {
      message:
        'Template ini belum disetujui Meta (atau sedang dijeda/dinonaktifkan), jadi belum bisa dikirim.',
    });
  }
  if (template.wabaId !== input.channelWabaId) {
    throw new AppError('CONFLICT', {
      message:
        'Template ini milik akun WhatsApp lain. Pilih template dari nomor yang sama dengan percakapan.',
    });
  }
  const parsed = templateContentSchema.safeParse(template.content);
  if (!parsed.success) {
    throw new AppError('CONFLICT', {
      message: 'Isi template rusak. Sinkron ulang template dari Meta.',
    });
  }
  const content = parsed.data;
  const { parameters } = input;
  const values: Record<string, string> = {};
  const buttons: NonNullable<MessageExtras['template']>['buttons'] = [];

  if (template.category === 'AUTHENTICATION') {
    // Template OTP: body `{{1}}` = kode; tombol salin kode (indeks 0) memakai kode yang sama.
    const code = checkValue('parameters.body.1', parameters.body['1']);
    values['1'] = code;
    buttons.push({ index: 0, type: 'URL', value: code });
    return {
      templateId: template.id,
      name: template.name,
      language: template.language,
      category: template.category,
      named: false,
      headerFormat: null,
      headerVariable: null,
      headerText: null,
      headerMediaFileId: null,
      bodyVariables: ['1'],
      values,
      buttons,
      // Review template S1: kode OTP TIDAK PERNAH masuk teks pesan (riwayat, pencarian, ekspor,
      // webhook, MobiChat). Nilainya hanya di `extras.template` sampai worker selesai mengirim.
      preview: 'Kode verifikasi: ••••••',
      sensitive: true,
    };
  }

  const bodyVariables = templateVariables(content.body.text);
  for (const name of bodyVariables) {
    values[name] = checkValue(`parameters.body.${name}`, parameters.body[name]);
  }

  const header = content.header;
  let headerVariable: string | null = null;
  let headerText: string | null = null;
  let headerMediaFileId: string | null = null;
  if (header?.format === 'TEXT') {
    headerVariable = templateVariables(header.text)[0] ?? null;
    if (headerVariable) headerText = checkValue('parameters.header.text', parameters.header?.text);
  } else if (header) {
    if (!parameters.header?.mediaId) {
      throw invalid(
        'parameters.header.mediaId',
        'Template ini butuh berkas judul (gambar/video/dokumen). Unggah dulu.',
      );
    }
    headerMediaFileId = parameters.header.mediaId;
  }

  content.buttons.forEach((button, index) => {
    if (button.type === 'URL' && urlButtonHasVariable(button.url)) {
      buttons.push({
        index,
        type: 'URL',
        value: checkValue(`parameters.buttons.${String(index)}`, parameters.buttons[String(index)]),
      });
    } else if (button.type === 'COPY_CODE') {
      buttons.push({
        index,
        type: 'COPY_CODE',
        value: checkValue(`parameters.buttons.${String(index)}`, parameters.buttons[String(index)]),
      });
    }
  });

  return {
    templateId: template.id,
    name: template.name,
    language: template.language,
    category: template.category,
    named: content.parameterFormat === 'named',
    headerFormat: header?.format ?? null,
    headerVariable,
    headerText,
    headerMediaFileId,
    bodyVariables,
    values,
    buttons,
    preview: fillTemplateText(content.body.text, values),
  };
}
