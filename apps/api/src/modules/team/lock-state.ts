import { sha256Hex, type Logger } from '@balesin/core';
import { auditLogs, type DbExecutor } from '@balesin/db';
import { AUDIT_ACTIONS, LOGIN_LOCK_MINUTES } from '@balesin/shared';
import { and, eq, inArray, sql } from 'drizzle-orm';

import { ipRateLimitKey } from '../../http/client-info';
import type { RateLimitRule, RateLimiter } from '../../http/rate-limit';
import {
  ACCOUNT_LOCK_FLAG,
  DEVICE_LOCK_FLAG,
  LOGIN_ACCOUNT_RULE,
  LOGIN_DEVICE_RULE,
  LOGIN_SOURCE_RULE,
  SOURCE_LOCK_FLAG,
  loginAccountKey,
} from '../auth/login-rules';
import {
  TWO_FACTOR_ACCOUNT_LOCK_FLAG,
  TWO_FACTOR_ACCOUNT_RULE,
  TWO_FACTOR_DEVICE_LOCK_FLAG,
  TWO_FACTOR_DEVICE_RULE,
  TWO_FACTOR_REAUTH_RULE,
} from '../two-factor/two-factor-rules';

/**
 * Keadaan "terkunci sementara" seorang pengguna dan cara membukanya (Owner/Admin).
 *
 * Kunci masuk SENGAJA hanya ada di Redis (`login-rules.ts`, temuan R1/S1 review Fase 1): ember per
 * (email, asal jaringan), per email dari mana pun, per perangkat dikenal, dan langkah kedua 2FA per
 * akun/perangkat dikenal. Kunci per asal/perangkat memakai kunci Redis yang tidak bisa diturunkan
 * dari data pengguna saja, jadi setiap kunci mencatat kunci embernya (`lockRef`, hash — bukan
 * rahasia) di audit `auth.account.locked`. Dari audit 15 menit terakhir itulah kunci yang mungkin
 * masih berlaku ditemukan, lalu diperiksa ke Redis (kunci bisa sudah dilepas, mis. oleh atur ulang
 * password).
 */

export interface LockSubjectUser {
  id: string;
  email: string;
}

interface LockBucket {
  flag: string;
  key: string;
  rules: readonly RateLimitRule[];
}

interface LockEventRow {
  userId: string;
  scope: string | null;
  lockRef: string | null;
  ip: string | null;
}

const LOCK_WINDOW = sql.raw(`interval '${LOGIN_LOCK_MINUTES} minutes'`);

/** Kejadian kunci yang mungkin masih berlaku (audit `auth.account.locked` 15 menit terakhir). */
async function recentLockEvents(
  db: DbExecutor,
  organizationId: string,
  userIds: readonly string[],
): Promise<LockEventRow[]> {
  if (userIds.length === 0) return [];
  const rows = await db
    .select({
      userId: auditLogs.targetId,
      scope: sql<string | null>`${auditLogs.metadata} ->> 'scope'`,
      lockRef: sql<string | null>`${auditLogs.metadata} ->> 'lockRef'`,
      ip: auditLogs.ipAddress,
    })
    .from(auditLogs)
    .where(
      and(
        eq(auditLogs.organizationId, organizationId),
        eq(auditLogs.action, AUDIT_ACTIONS.accountLocked),
        eq(auditLogs.targetType, 'user'),
        inArray(auditLogs.targetId, [...userIds]),
        sql`${auditLogs.createdAt} > now() - ${LOCK_WINDOW}`,
      ),
    );
  return rows.flatMap((row) => (row.userId ? [{ ...row, userId: row.userId }] : []));
}

/** Kunci ember yang selalu dimiliki akun ini (tidak bergantung asal/perangkat). */
function twoFactorBuckets(user: LockSubjectUser): LockBucket[] {
  return [
    {
      flag: TWO_FACTOR_ACCOUNT_LOCK_FLAG,
      key: user.id,
      rules: [TWO_FACTOR_ACCOUNT_RULE, TWO_FACTOR_REAUTH_RULE],
    },
    { flag: TWO_FACTOR_DEVICE_LOCK_FLAG, key: user.id, rules: [TWO_FACTOR_DEVICE_RULE] },
  ];
}

function accountBuckets(user: LockSubjectUser): LockBucket[] {
  return [
    { flag: ACCOUNT_LOCK_FLAG, key: loginAccountKey(user.email), rules: [LOGIN_ACCOUNT_RULE] },
    ...twoFactorBuckets(user),
  ];
}

/** Ember per asal/perangkat yang tercatat di audit kunci. */
function eventBuckets(user: LockSubjectUser, events: readonly LockEventRow[]): LockBucket[] {
  const buckets: LockBucket[] = [];
  for (const event of events) {
    if (event.scope === 'source') {
      // Entri lama (sebelum `lockRef` dicatat): kunci ember asal bisa dihitung dari IP audit.
      const key =
        event.lockRef ??
        sha256Hex(`login|${user.email}|${ipRateLimitKey({ ip: event.ip, userAgent: null })}`).slice(
          0,
          40,
        );
      buckets.push({ flag: SOURCE_LOCK_FLAG, key, rules: [LOGIN_SOURCE_RULE] });
    } else if (event.scope === 'device' && event.lockRef) {
      buckets.push({ flag: DEVICE_LOCK_FLAG, key: event.lockRef, rules: [LOGIN_DEVICE_RULE] });
    }
  }
  return buckets;
}

export interface LockInspector {
  /**
   * Waktu berakhirnya kunci yang masih berlaku per pengguna (hanya pengguna yang terkunci ada di
   * peta). Redis bermasalah → pengguna dengan kejadian kunci dianggap terkunci sampai 15 menit
   * sejak kejadian (lebih baik tampil "terkunci" daripada diam).
   */
  lockedUntil(
    organizationId: string,
    users: readonly LockSubjectUser[],
  ): Promise<Map<string, Date>>;
  /** Membuka semua kunci masuk/2FA akun ini + menghapus hitungannya. Mengembalikan lingkup yang dibuka. */
  unlock(organizationId: string, user: LockSubjectUser): Promise<string[]>;
  /**
   * Hanya kunci langkah kedua (2FA) — setelah 2FA diatur ulang, tebakan kode lama tidak relevan lagi.
   * Kunci tebakan PASSWORD sengaja tidak disentuh.
   */
  unlockTwoFactor(user: LockSubjectUser): Promise<void>;
}

export function createLockInspector(deps: {
  db: DbExecutor;
  limiter: RateLimiter;
  logger: Pick<Logger, 'warn'>;
}): LockInspector {
  const { db, limiter, logger } = deps;

  return {
    async lockedUntil(organizationId, users) {
      const events = await recentLockEvents(
        db,
        organizationId,
        users.map((user) => user.id),
      );
      const result = new Map<string, Date>();
      for (const user of users) {
        const own = events.filter((event) => event.userId === user.id);
        if (own.length === 0) continue;
        try {
          let ttl = 0;
          for (const bucket of [...accountBuckets(user), ...eventBuckets(user, own)]) {
            ttl = Math.max(ttl, await limiter.flagTtl(bucket.flag, bucket.key));
          }
          if (ttl > 0) result.set(user.id, new Date(Date.now() + ttl * 1000));
        } catch (err) {
          logger.warn({ err, userRef: user.id }, 'Keadaan kunci akun tidak bisa dibaca dari Redis');
          result.set(user.id, new Date(Date.now() + LOGIN_LOCK_MINUTES * 60_000));
        }
      }
      return result;
    },

    async unlock(organizationId, user) {
      const events = await recentLockEvents(db, organizationId, [user.id]);
      const cleared = new Set<string>();
      for (const bucket of [...accountBuckets(user), ...eventBuckets(user, events)]) {
        if ((await limiter.flagTtl(bucket.flag, bucket.key)) > 0) cleared.add(bucket.flag);
        await limiter.clearFlag(bucket.flag, bucket.key);
        for (const rule of bucket.rules) await limiter.reset(rule, bucket.key);
      }
      return [...cleared].sort();
    },

    async unlockTwoFactor(user) {
      for (const bucket of twoFactorBuckets(user)) {
        await limiter.clearFlag(bucket.flag, bucket.key);
        for (const rule of bucket.rules) await limiter.reset(rule, bucket.key);
      }
    },
  };
}
