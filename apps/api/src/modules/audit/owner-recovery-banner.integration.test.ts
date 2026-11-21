/**
 * Banner keamanan untuk reset password Owner dari SERVER (Fase 7, DECISIONS 2026-11-22 R4): audit
 * `auth.password_reset.completed` ber-`metadata.serverRecovery` → kejadian keamanan
 * `owner_password_reset_server` (`warning`). Reset biasa (tautan email) tidak.
 */
import { API_ROUTES, securitySummaryResponseSchema } from '@balesin/shared';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setupWorld, send, type Fase5World } from '../../testing/crm-fixtures';
import { createIntegrationHarness, type IntegrationHarness } from '../../testing/integration';
import { AUDIT_ACTIONS, recordAudit } from './audit';

let harness: IntegrationHarness;
let world: Fase5World;

beforeAll(async () => {
  harness = await createIntegrationHarness();
});
beforeEach(async () => {
  world = await setupWorld(harness);
});
afterAll(async () => {
  await harness?.close();
}, 90_000);

describe('kejadian keamanan owner_password_reset_server', () => {
  it('audit dari CLI pemulihan → warning dengan rincian; reset biasa tidak', async () => {
    await recordAudit(harness.db, {
      organizationId: world.organizationId,
      actorUserId: null,
      action: AUDIT_ACTIONS.passwordResetCompleted,
      targetType: 'user',
      targetId: world.owner.userId,
      metadata: { via: 'cli', serverRecovery: true, revokedSessions: 2 },
      client: { ip: null, userAgent: 'balesin-cli reset-owner-password' },
    });
    await recordAudit(harness.db, {
      organizationId: world.organizationId,
      actorUserId: world.owner.userId,
      action: AUDIT_ACTIONS.passwordResetCompleted,
      targetType: 'user',
      targetId: world.owner.userId,
      metadata: {},
      client: { ip: '127.0.0.1', userAgent: 'tes' },
    });
    const response = await send(world, world.owner, 'GET', API_ROUTES.audit.securitySummary);
    expect(response.statusCode, response.body).toBe(200);
    const summary = securitySummaryResponseSchema.parse(response.json());
    expect(summary.counts.owner_password_reset_server).toBe(1);
    expect(summary.counts.password_reset_without_two_factor).toBe(0);
    const event = summary.events.find((item) => item.kind === 'owner_password_reset_server');
    expect(event).toMatchObject({
      severity: 'warning',
      actor: null,
      details: { via: 'cli', revokedSessions: 2 },
    });
    expect(summary.latestWarningAt).not.toBeNull();
  });
});
