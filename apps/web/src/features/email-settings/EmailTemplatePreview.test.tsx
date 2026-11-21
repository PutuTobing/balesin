import { API_ROUTES, apiPath, type EmailTemplateId } from '@balesin/shared';
import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { t } from '../../i18n/id';
import { apiError, fakeSession, json, type FakeHandler } from '../../test/fake-api';
import { renderApp } from '../../test/render-app';
import { EMAIL_PREVIEW_SANDBOX, emailPreviewDocument } from './preview-document';

const copy = t.emailSettings.preview;

const EMAIL_HTML =
  '<!doctype html><html><head><meta charset="utf-8"><title>x</title></head>' +
  '<body style="margin:0"><p style="color:#14202E">Halo,</p>' +
  '<a href="http://localhost/undangan#token=CONTOH-TAUTAN-PRATINJAU">Terima undangan</a></body></html>';

function previewRoute(template: EmailTemplateId): string {
  return `GET ${apiPath(API_ROUTES.settings.emailTemplatePreview, { template })}`;
}

function preview(template: EmailTemplateId, subject: string): () => Response {
  return () => json({ template, subject, text: `Teks ${subject}`, html: EMAIL_HTML });
}

async function openPreview(routes: Record<string, FakeHandler>) {
  await renderApp('/pengaturan/email', { session: fakeSession('owner'), routes });
  await screen.findByRole('heading', { level: 1, name: t.emailSettings.title });
  return within(screen.getByRole('region', { name: copy.title }));
}

describe('dokumen pratinjau email', () => {
  it('sandbox kosong: tanpa allow-scripts / allow-same-origin', () => {
    expect(EMAIL_PREVIEW_SANDBOX).toBe('');
  });

  it('menyisipkan CSP ketat + base target di <head> tanpa mengubah isi email', () => {
    const doc = emailPreviewDocument(EMAIL_HTML);
    const head = doc.slice(doc.indexOf('<head>'), doc.indexOf('</head>'));
    expect(head).toContain(
      `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; form-action 'none'">`,
    );
    expect(head).toContain('<base target="_blank">');
    // CSP dipasang PALING AWAL di <head> (sebelum isi lain dari email).
    expect(doc.indexOf('Content-Security-Policy')).toBeLessThan(doc.indexOf('<meta charset'));
    expect(doc).toContain('<p style="color:#14202E">Halo,</p>');
  });

  it('HTML tanpa <head> dibungkus dokumen lengkap ber-CSP', () => {
    const doc = emailPreviewDocument('<p>Halo</p>');
    expect(
      doc.startsWith('<!doctype html><html><head><meta http-equiv="Content-Security-Policy"'),
    ).toBe(true);
    expect(doc).toContain('<body><p>Halo</p></body>');
  });
});

describe('Pengaturan → Email pengirim: pratinjau template', () => {
  it('iframe sandbox="" + srcdoc (bukan HTML di halaman); ganti template dan tampilan teks polos', async () => {
    const card = await openPreview({
      [previewRoute('invitation')]: preview('invitation', 'Rina mengundangmu ke PT Maju Jaya'),
      [previewRoute('password_reset')]: preview('password_reset', 'Atur ulang password'),
    });
    expect(await card.findByText('Rina mengundangmu ke PT Maju Jaya')).toBeVisible();
    const frame = card.getByTitle(copy.frameTitle('Undangan bergabung'));
    expect(frame.tagName).toBe('IFRAME');
    expect(frame.getAttribute('sandbox')).toBe('');
    expect(frame).toHaveAttribute('referrerpolicy', 'no-referrer');
    expect(frame.getAttribute('srcdoc')).toContain('Content-Security-Policy');
    // Isi email tidak pernah masuk DOM aplikasi.
    expect(screen.queryByText('Terima undangan')).toBeNull();

    fireEvent.change(card.getByLabelText(copy.template), { target: { value: 'password_reset' } });
    expect(await card.findByText('Atur ulang password', { selector: 'span' })).toBeVisible();
    fireEvent.click(card.getByRole('radio', { name: copy.text }));
    expect(card.getByText('Teks Atur ulang password')).toBeVisible();
    expect(card.queryByTitle(/Pratinjau email/)).toBeNull();
  });

  it('gagal dimuat → pesan + Coba lagi', async () => {
    let calls = 0;
    const card = await openPreview({
      [previewRoute('invitation')]: () => {
        calls += 1;
        return calls === 1
          ? apiError(503, 'SERVICE_UNAVAILABLE', 'Server sedang sibuk.')
          : preview('invitation', 'Subjek undangan')();
      },
    });
    expect(await card.findByText(copy.loadFailedTitle)).toBeVisible();
    fireEvent.click(card.getByRole('button', { name: t.common.retry }));
    await waitFor(() => expect(card.getByText('Subjek undangan')).toBeVisible());
  });
});
