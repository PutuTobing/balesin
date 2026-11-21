import { randomBytes } from 'node:crypto';

import type { Database } from '../client';
import {
  organizations,
  userSessions,
  users,
  type NewOrganization,
  type NewUser,
  type NewUserSession,
  type Organization,
  type User,
  type UserSession,
} from '../schema';

/** Potongan acak supaya data antar-tes tidak pernah bentrok. */
export function uniqueSuffix(): string {
  return randomBytes(6).toString('hex');
}

function onlyRow<T>(rows: T[]): T {
  const [row] = rows;
  if (!row) throw new Error('INSERT tidak mengembalikan baris');
  return row;
}

export async function insertOrganization(
  db: Database,
  overrides: Partial<NewOrganization> = {},
): Promise<Organization> {
  return onlyRow(
    await db
      .insert(organizations)
      .values({ name: `Organisasi Tes ${uniqueSuffix()}`, ...overrides })
      .returning(),
  );
}

export async function insertUser(
  db: Database,
  organizationId: string,
  overrides: Partial<NewUser> = {},
): Promise<User> {
  return onlyRow(
    await db
      .insert(users)
      .values({
        organizationId,
        email: `pengguna-${uniqueSuffix()}@contoh.test`,
        name: 'Pengguna Tes',
        // Bukan hash sungguhan — cukup untuk tes yang tidak menyentuh login.
        passwordHash: '$argon2id$tes-bukan-hash-sungguhan',
        role: 'cs',
        ...overrides,
      })
      .returning(),
  );
}

export async function insertUserSession(
  db: Database,
  user: Pick<User, 'id' | 'organizationId'>,
  overrides: Partial<NewUserSession> = {},
): Promise<UserSession> {
  const now = Date.now();
  return onlyRow(
    await db
      .insert(userSessions)
      .values({
        organizationId: user.organizationId,
        userId: user.id,
        tokenHash: randomBytes(32).toString('hex'),
        idleExpiresAt: new Date(now + 12 * 60 * 60 * 1000),
        absoluteExpiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000),
        ...overrides,
      })
      .returning(),
  );
}
