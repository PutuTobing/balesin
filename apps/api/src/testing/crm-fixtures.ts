import { channels, contacts, conversations, newId } from '@balesin/db';
import { insertUser } from '@balesin/db/testing';
import {
  API_ROUTES,
  createApiKeyResponseSchema,
  type ApiKeyScope,
  type UserRole,
} from '@balesin/shared';

import { createPasswordHasher } from '../modules/auth/password-hasher';
import {
  call,
  completeSetup,
  confirmationFor,
  login,
  type IntegrationHarness,
  type SignedIn,
} from './integration';

/**
 * Perlengkapan tes Fase 5 (CRM, tiket, departemen): organisasi + Owner, channel tiruan, agen per
 * peran, kontak + percakapan, API key. Postgres + Redis sungguhan (lewat `IntegrationHarness`).
 */

export const FIXTURE_PASSWORD = 'sandi-uji-fase5-crm-01';
const hasher = createPasswordHasher();

export type Agent = SignedIn & { userId: string; name: string };

export interface Fase5World {
  harness: IntegrationHarness;
  owner: Agent;
  organizationId: string;
  channelId: string;
}

export async function setupWorld(harness: IntegrationHarness): Promise<Fase5World> {
  await harness.reset();
  const signed = await completeSetup(harness.app);
  const organizationId = signed.session.organization.id;
  const channelId = newId();
  await harness.db.insert(channels).values({
    id: channelId,
    organizationId,
    type: 'whatsapp',
    name: 'CS Utama',
    waPhoneNumberId: '106540352242922',
    waBusinessAccountId: '102290129340398',
    waAccessTokenEncrypted: 'x',
    waAppSecretEncrypted: 'x',
    waVerifyTokenEncrypted: 'x',
    waVerifyTokenRotatedAt: new Date(),
  });
  return {
    harness,
    owner: { ...signed, userId: signed.session.user.id, name: signed.session.user.name },
    organizationId,
    channelId,
  };
}

export async function agent(
  world: Fase5World,
  role: Exclude<UserRole, 'owner'>,
  name: string,
): Promise<Agent> {
  const user = await insertUser(world.harness.db, world.organizationId, {
    role,
    name,
    email: `${role}.${newId().slice(-8)}@majujaya.test`,
    passwordHash: await hasher.hash(FIXTURE_PASSWORD),
  });
  return {
    ...(await login(world.harness.app, { email: user.email, password: FIXTURE_PASSWORD })),
    userId: user.id,
    name,
  };
}

export function send(
  world: Fase5World,
  signed: SignedIn,
  method: 'GET' | 'POST' | 'PATCH' | 'PUT' | 'DELETE',
  url: string,
  body?: unknown,
) {
  return call(world.harness.app, method, url, body, {
    cookie: signed.cookie,
    ...(method === 'GET' ? {} : { csrf: signed.csrf }),
  });
}

let phoneCounter = 0;

/** Kontak WhatsApp + percakapan terbuka (opsional departemen/agen). */
export async function seedConversation(
  world: Fase5World,
  options: {
    name?: string;
    phone?: string;
    departmentId?: string | null;
    assigneeUserId?: string | null;
    status?: 'unserved' | 'served' | 'resolved';
  } = {},
) {
  phoneCounter += 1;
  const [contact] = await world.harness.db
    .insert(contacts)
    .values({
      organizationId: world.organizationId,
      channelType: 'whatsapp',
      phone: options.phone ?? `+62813${String(10_000_000 + phoneCounter * 7919).slice(-8)}`,
      name: options.name ?? null,
      profileName: 'Pelanggan Uji',
    })
    .returning();
  const status = options.status ?? (options.assigneeUserId ? 'served' : 'unserved');
  const [conversation] = await world.harness.db
    .insert(conversations)
    .values({
      organizationId: world.organizationId,
      contactId: contact!.id,
      channelId: world.channelId,
      status,
      assigneeUserId: options.assigneeUserId ?? null,
      departmentId: options.departmentId ?? null,
      lastMessageAt: new Date(),
      lastInboundAt: new Date(),
      windowExpiresAt: new Date(Date.now() + 23 * 3600_000),
      resolvedAt: status === 'resolved' ? new Date() : null,
    })
    .returning();
  return { contact: contact!, conversation: conversation! };
}

/** API key (Owner + konfirmasi) → token utuh. */
export async function createApiKey(world: Fase5World, scopes: ApiKeyScope[]): Promise<string> {
  const response = await call(
    world.harness.app,
    'POST',
    API_ROUTES.apiKeys.list,
    { name: 'n8n tiket', scopes, confirmation: await confirmationFor() },
    { cookie: world.owner.cookie, csrf: world.owner.csrf },
  );
  if (response.statusCode !== 201) throw new Error(`API key gagal: ${response.body}`);
  return createApiKeyResponseSchema.parse(response.json()).secret;
}

export function api(
  world: Fase5World,
  token: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  url: string,
  body?: unknown,
) {
  return world.harness.app.inject({
    method,
    url,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    ...(body !== undefined ? { payload: JSON.stringify(body) } : {}),
  });
}
