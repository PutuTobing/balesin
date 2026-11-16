/**
 * Sisa R5 review akhir Fase 1: reset password akun TANPA 2FA yang diselesaikan ≤ 72 jam setelah
 * jalur email pengirim diubah (`email_sender_changed`) → metadata `afterEmailSenderChange` dan
 * kejadian `warning` di ringkasan keamanan, walau di bawah ambang burst.
 */
import { accountTokenDeliveryContext, createSecretBox, Secret } from '@balesin/core';
import { accountTokens, auditLogs } from '@balesin/db';
import { insertOrganization, insertUser } from '@balesin/db/testing';
import { API_ROUTES, AUDIT_ACTIONS, securitySummaryResponseSchema } from '@balesin/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  call,
  completeSetup,
  createIntegrationHarness,
  mailpitSettings,
  TEST_MASTER_KEY,
  withConfirmation,
  type IntegrationHarness,
  type SignedIn,
} from '../../testing/integration';
import { createPasswordHasher } from '../auth/password-hasher';
import { emailSenderChangedRecently } from './reset-burst';

let harness: IntegrationHarness;
let owner: SignedIn;
const hasher = createPasswordHasher();
const box = createSecretBox(new Secret(TEST_MASTER_KEY));
const routes = API_ROUTES.passwordReset;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  await harness.reset();
  owner = await completeSetup(harness.app);
  const saved = await call(
    harness.app,
    'PUT',
    API_ROUTES.settings.email,
    await withConfirmation(owner, mailpitSettings()),
    { cookie: owner.cookie, csrf: owner.csrf },
  );
  if (saved.statusCode !== 200) throw new Error(`Simpan email gagal: ${saved.body}`);
});
afterAll(async () => {
  await harness?.close();
});

async function senderChanged(organizationId: string, at = new Date()) {
  await harness.db.insert(auditLogs).values({
    organizationId,
    action: AUDIT_ACTIONS.emailSettingsUpdated,
    metadata: { ownersNotified: true, host: 'relay.penyerang.test' },
    createdAt: at,
  });
}

async function resetCs(organizationId: string): Promise<Record<string, unknown>> {
  const cs = await insertUser(harness.db, organizationId, {
    role: 'cs',
    email: `cs-${Math.random().toString(36).slice(2, 8)}@majujaya.test`,
    passwordHash: await hasher.hash('sandi-lama-yang-kuat-01'),
  });
  const requested = await call(harness.app, 'POST', routes.request, { email: cs.email });
  expect(requested.statusCode).toBe(202);
  await harness.app.backgroundTasks.drain();
  const [row] = await harness.db
    .select()
    .from(accountTokens)
    .where(and(eq(accountTokens.email, cs.email), isNull(accountTokens.usedAt)));
  const token = box.decrypt(
    row!.deliveryTokenEncrypted!,
    accountTokenDeliveryContext(row!.organizationId, row!.id),
  );
  const done = await call(harness.app, 'POST', routes.complete, {
    token,
    password: 'layang-layang-senja-merah',
  });
  expect(done.statusCode, done.body).toBe(200);
  const [audit] = await harness.db
    .select()
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.action, AUDIT_ACTIONS.passwordResetCompleted),
        eq(auditLogs.targetId, cs.id),
      ),
    );
  return audit!.metadata;
}

describe('reset password setelah email pengirim diubah (sisa R5)', () => {
  it('dalam 72 jam → ditandai dan menjadi warning di ringkasan keamanan', async () => {
    const organizationId = owner.session.organization.id;
    await senderChanged(organizationId);
    expect(await resetCs(organizationId)).toMatchObject({ afterEmailSenderChange: true });

    const summary = await call(harness.app, 'GET', API_ROUTES.audit.securitySummary, undefined, {
      cookie: owner.cookie,
    });
    const parsed = securitySummaryResponseSchema.parse(summary.json());
    expect(parsed.counts.password_reset_without_two_factor).toBeGreaterThanOrEqual(1);
    expect(parsed.events).toContainEqual(
      expect.objectContaining({ kind: 'password_reset_without_two_factor', severity: 'warning' }),
    );
  });

  it('emailSenderChangedRecently: hanya perubahan jalur kirim ≤ 72 jam di organisasi itu', async () => {
    const fresh = await insertOrganization(harness.db);
    expect(await emailSenderChangedRecently(harness.db, fresh.id)).toBe(false);
    await senderChanged(fresh.id, new Date(Date.now() - 73 * 60 * 60 * 1000));
    expect(await emailSenderChangedRecently(harness.db, fresh.id)).toBe(false);
    await harness.db.insert(auditLogs).values({
      organizationId: fresh.id,
      action: AUDIT_ACTIONS.emailSettingsUpdated,
      metadata: { ownersNotified: false },
    });
    expect(await emailSenderChangedRecently(harness.db, fresh.id)).toBe(false);
    await senderChanged(fresh.id);
    expect(await emailSenderChangedRecently(harness.db, fresh.id)).toBe(true);
  });
});
