/**
 * Pratinjau template email bermerek (docs/PENGATURAN-UI.md §1): template yang sama dengan worker,
 * branding organisasi sungguhan, tautan contoh dari APP_URL, tanpa token sungguhan. Khusus Owner
 * (sama dengan Pengaturan → Email pengirim).
 */
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  EMAIL_TEMPLATE_IDS,
  apiPath,
  emailTemplatePreviewResponseSchema,
} from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { TEST_APP_ORIGIN } from '../../testing/build-test-app';
import {
  call,
  completeSetup,
  createIntegrationHarness,
  login,
  type IntegrationHarness,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';

let harness: IntegrationHarness;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
});
afterAll(async () => {
  await harness?.close();
});

/** PNG 1×1 piksel yang sah. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';

const previewUrl = (template: string) =>
  apiPath(API_ROUTES.settings.emailTemplatePreview, { template });

describe('pratinjau template email', () => {
  it('setiap template: branding organisasi, logo data:, tautan contoh dari APP_URL', async () => {
    const owner = await completeSetup(harness.app, {
      organization: { name: 'PT <Maju> Jaya', timezone: 'Asia/Jakarta' },
      branding: {
        productName: 'Balesin Maju',
        primaryColor: '#0b5394',
        logo: { contentType: 'image/png', dataBase64: PNG_BASE64 },
      },
    });
    for (const template of EMAIL_TEMPLATE_IDS) {
      const response = await call(harness.app, 'GET', previewUrl(template), undefined, {
        cookie: owner.cookie,
      });
      expect(response.statusCode, template).toBe(200);
      const body = emailTemplatePreviewResponseSchema.parse(response.json());
      expect(body.template).toBe(template);
      expect(body.html, template).toContain('Balesin Maju');
      expect(body.html, template).toContain('PT &lt;Maju&gt; Jaya');
      expect(body.html, template).not.toContain('PT <Maju> Jaya');
      expect(body.html, template).toContain('src="data:image/png;base64,');
      expect(body.text, template).toContain('Balesin Maju');
      const links = [...body.html.matchAll(/https?:\/\/[^\s"'<>]+/g)].map((match) => match[0]);
      for (const link of links) expect(link.startsWith(`${TEST_APP_ORIGIN}/`), link).toBe(true);
    }
    const invitation = emailTemplatePreviewResponseSchema.parse(
      (
        await call(harness.app, 'GET', previewUrl('invitation'), undefined, {
          cookie: owner.cookie,
        })
      ).json(),
    );
    expect(invitation.text).toContain(`${TEST_APP_ORIGIN}/undangan#token=CONTOH-TAUTAN-PRATINJAU`);
    expect(invitation.html).toContain('background:#0b5394');
  });

  it('template tidak dikenal 400; Admin 403 (khusus Owner); tanpa sesi 401', async () => {
    const owner = await completeSetup(harness.app);
    const unknown = await call(harness.app, 'GET', previewUrl('rahasia'), undefined, {
      cookie: owner.cookie,
    });
    expect(unknown.statusCode).toBe(400);
    const password = 'sandi-admin-pratinjau-01';
    const admin = await insertUser(harness.db, owner.session.organization.id, {
      role: 'admin',
      email: 'admin.pratinjau@majujaya.test',
      name: 'Admin Pratinjau',
      passwordHash: await createPasswordHasher().hash(password),
    });
    const signed = await login(harness.app, { email: admin.email, password });
    const forbidden = await call(harness.app, 'GET', previewUrl('invitation'), undefined, {
      cookie: signed.cookie,
    });
    expect(forbidden.statusCode).toBe(403);
    expect((await call(harness.app, 'GET', previewUrl('invitation'))).statusCode).toBe(401);
  });
});
