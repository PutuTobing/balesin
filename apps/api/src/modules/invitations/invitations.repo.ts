import {
  organizations,
  userInvitations,
  users,
  type DbExecutor,
  type UserInvitation,
} from '@balesin/db';
import {
  INVITATION_VALID_HOURS,
  invitationIssuerAuthorized,
  type EmailDeliveryStatus,
  type InvitableRole,
  type UserRole,
} from '@balesin/shared';
import { alias } from 'drizzle-orm/pg-core';
import { and, desc, eq, inArray, isNull, notInArray, or, sql } from 'drizzle-orm';

/**
 * Query undangan. Semua query memfilter `organization_id`, kecuali pencarian berdasarkan hash
 * token (memang itu yang sedang dicari); hasilnya membawa `organization_id` untuk query
 * berikutnya. Waktu memakai jam DATABASE.
 */

const VALID_INTERVAL = sql.raw(`interval '${INVITATION_VALID_HOURS} hours'`);

const inviter = alias(users, 'inviter');
const lastSender = alias(users, 'last_sender');

/** Undangan terbuka (belum diterima, belum dibatalkan) + nama pengundang + kedaluwarsa (jam DB). */
export interface OpenInvitation {
  id: string;
  organizationId: string;
  email: string;
  role: Exclude<UserRole, 'owner'>;
  createdAt: Date;
  tokenIssuedAt: Date;
  expiresAt: Date;
  sendCount: number;
  deliveryStatus: EmailDeliveryStatus;
  invitedBy: { id: string; name: string };
  expired: boolean;
}

const openColumns = {
  id: userInvitations.id,
  organizationId: userInvitations.organizationId,
  email: userInvitations.email,
  role: userInvitations.role,
  createdAt: userInvitations.createdAt,
  tokenIssuedAt: userInvitations.tokenIssuedAt,
  expiresAt: userInvitations.expiresAt,
  sendCount: userInvitations.sendCount,
  deliveryStatus: userInvitations.deliveryStatus,
  inviterId: inviter.id,
  inviterName: inviter.name,
  expired: sql<boolean>`${userInvitations.expiresAt} <= now()`,
};

function toOpen(row: {
  id: string;
  organizationId: string;
  email: string;
  role: UserRole;
  createdAt: Date;
  tokenIssuedAt: Date;
  expiresAt: Date;
  sendCount: number;
  deliveryStatus: EmailDeliveryStatus;
  inviterId: string;
  inviterName: string;
  expired: boolean;
}): OpenInvitation {
  if (row.role === 'owner') throw new Error('Undangan Owner tidak mungkin ada');
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    createdAt: row.createdAt,
    tokenIssuedAt: row.tokenIssuedAt,
    expiresAt: row.expiresAt,
    sendCount: row.sendCount,
    deliveryStatus: row.deliveryStatus,
    invitedBy: { id: row.inviterId, name: row.inviterName },
    expired: row.expired,
  };
}

function openOnly() {
  return and(isNull(userInvitations.acceptedAt), isNull(userInvitations.revokedAt));
}

function joinInviter() {
  return and(
    eq(inviter.organizationId, userInvitations.organizationId),
    eq(inviter.id, userInvitations.invitedByUserId),
  );
}

/** Undangan terbuka, terbaru dulu (paling banyak 200). */
export async function listOpenInvitations(
  db: DbExecutor,
  organizationId: string,
): Promise<OpenInvitation[]> {
  const rows = await db
    .select(openColumns)
    .from(userInvitations)
    .innerJoin(inviter, joinInviter())
    .where(and(eq(userInvitations.organizationId, organizationId), openOnly()))
    .orderBy(desc(userInvitations.createdAt))
    .limit(200);
  return rows.map(toOpen);
}

export async function findOpenInvitation(
  db: DbExecutor,
  organizationId: string,
  invitationId: string,
): Promise<OpenInvitation | undefined> {
  const [row] = await db
    .select(openColumns)
    .from(userInvitations)
    .innerJoin(inviter, joinInviter())
    .where(
      and(
        eq(userInvitations.organizationId, organizationId),
        eq(userInvitations.id, invitationId),
        openOnly(),
      ),
    )
    .limit(1);
  return row ? toOpen(row) : undefined;
}

export async function findOpenInvitationByEmail(
  db: DbExecutor,
  organizationId: string,
  email: string,
): Promise<OpenInvitation | undefined> {
  const [row] = await db
    .select(openColumns)
    .from(userInvitations)
    .innerJoin(inviter, joinInviter())
    .where(
      and(
        eq(userInvitations.organizationId, organizationId),
        eq(userInvitations.email, email),
        openOnly(),
      ),
    )
    .limit(1);
  return row ? toOpen(row) : undefined;
}

/** `true` bila email ini sudah dipakai pengguna (aktif maupun nonaktif) di organisasi itu. */
export async function isEmailRegistered(
  db: DbExecutor,
  organizationId: string,
  email: string,
): Promise<boolean> {
  const [row] = await db
    .select({ id: users.id })
    .from(users)
    .where(and(eq(users.organizationId, organizationId), eq(users.email, email)))
    .limit(1);
  return row !== undefined;
}

export async function insertInvitation(
  db: DbExecutor,
  input: {
    id: string;
    organizationId: string;
    email: string;
    role: Exclude<UserRole, 'owner'>;
    tokenHash: string;
    deliveryStatus: EmailDeliveryStatus;
    deliveryTokenEncrypted: string | null;
    actorUserId: string;
    /** Sesi penerbit (lihat `issuedSessionId`). */
    sessionRef: string;
  },
): Promise<UserInvitation> {
  const [row] = await db
    .insert(userInvitations)
    .values({
      id: input.id,
      organizationId: input.organizationId,
      email: input.email,
      role: input.role,
      tokenHash: input.tokenHash,
      expiresAt: sql`now() + ${VALID_INTERVAL}`,
      deliveryStatus: input.deliveryStatus,
      deliveryTokenEncrypted: input.deliveryTokenEncrypted,
      invitedByUserId: input.actorUserId,
      lastSentByUserId: input.actorUserId,
      issuedSessionId: input.sessionRef,
    })
    .returning();
  if (!row) throw new Error('Undangan tidak tersimpan');
  return row;
}

/**
 * Kirim ulang: token BARU (hash diganti → tautan lama langsung batal), berlaku 72 jam lagi,
 * `send_count` naik. Bersyarat undangan masih terbuka DAN `send_count` sama dengan yang dibaca —
 * dua kirim ulang bersamaan tidak bisa sama-sama lolos.
 */
export async function reissueInvitation(
  db: DbExecutor,
  input: {
    organizationId: string;
    invitationId: string;
    expectedSendCount: number;
    tokenHash: string;
    deliveryStatus: EmailDeliveryStatus;
    deliveryTokenEncrypted: string | null;
    actorUserId: string;
    sessionRef: string;
  },
): Promise<UserInvitation | undefined> {
  const [row] = await db
    .update(userInvitations)
    .set({
      tokenHash: input.tokenHash,
      tokenIssuedAt: sql`now()`,
      expiresAt: sql`now() + ${VALID_INTERVAL}`,
      sendCount: sql`${userInvitations.sendCount} + 1`,
      deliveryStatus: input.deliveryStatus,
      deliveredAt: null,
      deliveryTokenEncrypted: input.deliveryTokenEncrypted,
      lastSentByUserId: input.actorUserId,
      issuedSessionId: input.sessionRef,
    })
    .where(
      and(
        eq(userInvitations.organizationId, input.organizationId),
        eq(userInvitations.id, input.invitationId),
        eq(userInvitations.sendCount, input.expectedSendCount),
        openOnly(),
      ),
    )
    .returning();
  return row;
}

export async function revokeInvitation(
  db: DbExecutor,
  organizationId: string,
  invitationId: string,
  actorUserId: string,
): Promise<boolean> {
  const rows = await db
    .update(userInvitations)
    .set({ revokedAt: sql`now()`, revokedByUserId: actorUserId, deliveryTokenEncrypted: null })
    .where(
      and(
        eq(userInvitations.organizationId, organizationId),
        eq(userInvitations.id, invitationId),
        openOnly(),
      ),
    )
    .returning({ id: userInvitations.id });
  return rows.length > 0;
}

/**
 * Membatalkan semua undangan terbuka yang dibuat ATAU terakhir dikirim ulang oleh `userId`. Untuk
 * butir 6 (manajemen pengguna): dipanggil di transaksi yang sama dengan menonaktifkan/menurunkan
 * peran pengguna itu (review undangan R2.2). `keepRoles` = peran undangan yang MASIH boleh
 * diterbitkan pengguna itu (ganti peran: `INVITE_PERMISSIONS[peran baru]`) — undangan peran itu
 * tidak dibatalkan. Mengembalikan undangan yang dibatalkan.
 */
export async function revokeInvitationsIssuedBy(
  db: DbExecutor,
  organizationId: string,
  userId: string,
  actorUserId: string,
  keepRoles: readonly InvitableRole[] = [],
): Promise<Array<{ id: string; role: UserRole }>> {
  const rows = await db
    .update(userInvitations)
    .set({ revokedAt: sql`now()`, revokedByUserId: actorUserId, deliveryTokenEncrypted: null })
    .where(
      and(
        eq(userInvitations.organizationId, organizationId),
        or(
          eq(userInvitations.invitedByUserId, userId),
          eq(userInvitations.lastSentByUserId, userId),
        ),
        keepRoles.length > 0 ? notInArray(userInvitations.role, [...keepRoles]) : undefined,
        openOnly(),
      ),
    )
    .returning({ id: userInvitations.id, role: userInvitations.role });
  return rows;
}

/**
 * Membatalkan undangan terbuka yang token berlakunya diterbitkan `issuerUserId` (pemulihan akun):
 *  - `{ sessionIds }` — hanya yang diterbitkan dari sesi-sesi itu;
 *  - `{ exceptSessionId }` — semua KECUALI yang diterbitkan dari sesi itu (sesi pelaku pemulihan),
 *    termasuk yang dari sesi yang sudah keluar/kedaluwarsa dan baris lama tanpa sesi;
 *  - `{}` — semua.
 * Mengembalikan undangan yang dibatalkan.
 */
export async function revokeOpenInvitationsOfIssuer(
  db: DbExecutor,
  input: {
    organizationId: string;
    issuerUserId: string;
    revokedByUserId: string;
    sessionIds?: readonly string[];
    exceptSessionId?: string;
  },
): Promise<Array<{ id: string; role: UserRole }>> {
  if (input.sessionIds?.length === 0) return [];
  return db
    .update(userInvitations)
    .set({
      revokedAt: sql`now()`,
      revokedByUserId: input.revokedByUserId,
      deliveryTokenEncrypted: null,
    })
    .where(
      and(
        eq(userInvitations.organizationId, input.organizationId),
        eq(userInvitations.lastSentByUserId, input.issuerUserId),
        input.sessionIds
          ? inArray(userInvitations.issuedSessionId, [...input.sessionIds])
          : undefined,
        input.exceptSessionId === undefined
          ? undefined
          : sql`${userInvitations.issuedSessionId} is distinct from ${input.exceptSessionId}`,
        openOnly(),
      ),
    )
    .returning({ id: userInvitations.id, role: userInvitations.role });
}

/** Pengantrean email gagal: tandai gagal dan buang salinan token (generasi token ini saja). */
export async function markInvitationUndelivered(
  db: DbExecutor,
  organizationId: string,
  invitationId: string,
  sendCount: number,
): Promise<void> {
  await db
    .update(userInvitations)
    .set({ deliveryStatus: 'failed', deliveryTokenEncrypted: null })
    .where(
      and(
        eq(userInvitations.organizationId, organizationId),
        eq(userInvitations.id, invitationId),
        eq(userInvitations.sendCount, sendCount),
      ),
    );
}

/** Undangan untuk hash token ini (keadaan apa pun) + organisasi + pengundang. */
export interface InvitationByToken {
  id: string;
  organizationId: string;
  email: string;
  role: Exclude<UserRole, 'owner'>;
  expiresAt: Date;
  deliveryStatus: EmailDeliveryStatus;
  /**
   * `inviter_unavailable` = undangan masih terbuka, tetapi yang menerbitkan token SEKARANG
   * (`last_sent_by`: pembuat, atau pengirim ulang terakhir) sudah dinonaktifkan atau perannya tidak
   * lagi boleh mengundang peran ini — undangannya diperlakukan batal (review undangan R2: akun Admin
   * dibobol lalu dinonaktifkan). Kirim ulang oleh orang yang berhak menerbitkan token baru yang
   * tidak pernah dipegang penerbit lama, jadi undangan itu berlaku lagi.
   */
  state: 'open' | 'accepted' | 'revoked' | 'expired' | 'inviter_unavailable';
  inviterName: string;
  /** Penerbit token yang berlaku sekarang (pembuat / pengirim ulang terakhir). */
  issuer: { id: string; role: UserRole };
  organization: { id: string; name: string; timezone: string; productName: string | null };
}

export async function findInvitationByTokenHash(
  db: DbExecutor,
  tokenHash: string,
): Promise<InvitationByToken | undefined> {
  const [row] = await db
    .select({
      id: userInvitations.id,
      organizationId: userInvitations.organizationId,
      email: userInvitations.email,
      role: userInvitations.role,
      expiresAt: userInvitations.expiresAt,
      deliveryStatus: userInvitations.deliveryStatus,
      accepted: sql<boolean>`${userInvitations.acceptedAt} is not null`,
      revoked: sql<boolean>`${userInvitations.revokedAt} is not null`,
      expired: sql<boolean>`${userInvitations.expiresAt} <= now()`,
      inviterName: inviter.name,
      senderId: lastSender.id,
      senderRole: lastSender.role,
      senderDisabledAt: lastSender.disabledAt,
      organizationName: organizations.name,
      organizationTimezone: organizations.timezone,
      productName: organizations.productName,
    })
    .from(userInvitations)
    .innerJoin(inviter, joinInviter())
    .innerJoin(
      lastSender,
      and(
        eq(lastSender.organizationId, userInvitations.organizationId),
        eq(lastSender.id, userInvitations.lastSentByUserId),
      ),
    )
    .innerJoin(organizations, eq(organizations.id, userInvitations.organizationId))
    .where(eq(userInvitations.tokenHash, tokenHash))
    .limit(1);
  if (!row || row.role === 'owner') return undefined;
  const authorized = invitationIssuerAuthorized(row.role, {
    role: row.senderRole,
    disabledAt: row.senderDisabledAt,
  });
  return {
    id: row.id,
    organizationId: row.organizationId,
    email: row.email,
    role: row.role,
    expiresAt: row.expiresAt,
    deliveryStatus: row.deliveryStatus,
    state: row.accepted
      ? 'accepted'
      : row.revoked
        ? 'revoked'
        : !authorized
          ? 'inviter_unavailable'
          : row.expired
            ? 'expired'
            : 'open',
    inviterName: row.inviterName,
    issuer: { id: row.senderId, role: row.senderRole },
    organization: {
      id: row.organizationId,
      name: row.organizationName,
      timezone: row.organizationTimezone,
      productName: row.productName,
    },
  };
}

/**
 * Menandai undangan diterima oleh pengguna baru — hanya bila masih terbuka, belum kedaluwarsa, dan
 * tokennya masih yang sama (tidak dikirim ulang di tengah jalan). Hanya satu permintaan yang bisa.
 */
export async function markInvitationAccepted(
  db: DbExecutor,
  input: { organizationId: string; invitationId: string; tokenHash: string; userId: string },
): Promise<boolean> {
  const rows = await db
    .update(userInvitations)
    .set({
      acceptedAt: sql`now()`,
      acceptedUserId: input.userId,
      deliveryTokenEncrypted: null,
    })
    .where(
      and(
        eq(userInvitations.organizationId, input.organizationId),
        eq(userInvitations.id, input.invitationId),
        eq(userInvitations.tokenHash, input.tokenHash),
        openOnly(),
        sql`${userInvitations.expiresAt} > now()`,
      ),
    )
    .returning({ id: userInvitations.id });
  return rows.length > 0;
}
