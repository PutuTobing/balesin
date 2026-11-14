import { randomToken, sha256Hex } from '@balesin/core';
import type { Database, DbExecutor } from '@balesin/db';
import {
  isTwoFactorRequired,
  type AuthenticatedSession,
  type MeResponse,
  type UserRole,
} from '@balesin/shared';

import type { ClientInfo } from '../../http/client-info';
import type { CsrfProtection } from './csrf';
import {
  findActiveSession,
  insertSession,
  revokeSession,
  revokeUserSessions,
  touchSession,
  ENROLLMENT_SESSION_SECONDS,
  SESSION_ABSOLUTE_SECONDS,
  type SessionKind,
} from './session.repo';

/**
 * Identitas permintaan yang sudah lolos pemeriksaan sesi. Dipasang hook auth di `request.auth`;
 * handler dan pemeriksaan peran membaca dari sini — tidak pernah dari input klien.
 */
export interface AuthContext {
  /** `user_sessions.id`. Di log pakai kunci `sessionRef` (kunci `sessionId` selalu disensor). */
  sessionRef: string;
  organizationId: string;
  user: { id: string; name: string; email: string; role: UserRole };
  organization: { id: string; name: string; timezone: string };
  csrfToken: string;
  /** Hash token sesi — untuk memverifikasi token CSRF. Bukan rahasia yang bisa dipakai masuk. */
  sessionTokenHash: string;
  idleExpiresAt: Date;
  absoluteExpiresAt: Date;
  twoFactor: TwoFactorState;
  /**
   * Jenis sesi saat dibuat. `two_factor_enrollment` = sesi terbatas yang dibuat TEPAT setelah
   * password dimasukkan — satu-satunya jenis yang boleh mulai mendaftar 2FA tanpa password.
   */
  sessionKind: SessionKind;
}

/** Keadaan 2FA permintaan ini (dari database, bukan dari klien). */
export interface TwoFactorState {
  /** 2FA pengguna aktif. */
  enabled: boolean;
  /**
   * Peran wajib 2FA tetapi 2FA belum aktif: sesi TERBATAS. Hook auth hanya mengizinkan rute
   * `AUTHENTICATED_OR_ENROLLING` (pendaftaran 2FA, "siapa saya", keluar).
   */
  enrollmentRequired: boolean;
}

export function twoFactorState(role: UserRole, enabled: boolean): TwoFactorState {
  return { enabled, enrollmentRequired: isTwoFactorRequired(role) && !enabled };
}

export interface IssuedSession {
  /** Token mentah untuk cookie. HANYA ada di sini — database menyimpan hash-nya. */
  token: string;
  auth: AuthContext;
}

export interface SessionService {
  /**
   * Sesi untuk token dari cookie, atau `undefined` bila tidak berlaku. Ikut menggeser batas idle.
   *
   * Jenis sesi harus cocok dengan keadaan 2FA pengguna SEKARANG. Sesi biasa milik pengguna yang
   * kini wajib mendaftar 2FA (mis. perannya dinaikkan menjadi Admin) — atau sesi pendaftaran yang
   * tidak lagi diperlukan — langsung dicabut: pengguna masuk ulang dengan password dan mendapat
   * sesi yang benar (temuan S2 review 2FA).
   */
  resolve(token: string): Promise<AuthContext | undefined>;
  /**
   * Membuat sesi baru dengan token baru (rotasi). Satu-satunya tempat sesi dibuat: login,
   * langkah kedua 2FA, aktivasi 2FA, dan akhir wizard setup memanggil fungsi ini.
   *
   * Sesi untuk peran wajib-2FA yang belum mengaktifkan 2FA otomatis menjadi sesi terbatas
   * berumur pendek; `twoFactorVerified` wajib `true` bila 2FA pengguna aktif.
   */
  issue(executor: DbExecutor, input: IssueSessionInput): Promise<IssuedSession>;
  revoke(executor: DbExecutor, organizationId: string, sessionRef: string): Promise<boolean>;
  revokeAllForUser(
    executor: DbExecutor,
    organizationId: string,
    userId: string,
    exceptSessionRef?: string,
  ): Promise<number>;
}

export interface IssueSessionInput {
  user: AuthContext['user'];
  organization: AuthContext['organization'];
  client: ClientInfo;
  /** 2FA pengguna aktif (sesudah transaksi ini). */
  twoFactorEnabled: boolean;
  /** Langkah kedua baru saja berhasil untuk sesi ini. */
  twoFactorVerified: boolean;
}

export function createSessionService(db: Database, csrf: CsrfProtection): SessionService {
  return {
    async resolve(token) {
      const session = await findActiveSession(db, sha256Hex(token));
      if (!session) return undefined;

      const twoFactor = twoFactorState(session.user.role, session.twoFactorEnabled);
      const expectedKind: SessionKind = twoFactor.enrollmentRequired
        ? 'two_factor_enrollment'
        : 'standard';
      if (session.kind !== expectedKind) {
        await revokeSession(db, session.organizationId, session.id);
        return undefined;
      }

      let idleExpiresAt = session.idleExpiresAt;
      if (session.needsTouch) {
        idleExpiresAt =
          (await touchSession(db, session.organizationId, session.id)) ?? idleExpiresAt;
      }

      return {
        sessionRef: session.id,
        organizationId: session.organizationId,
        user: session.user,
        organization: session.organization,
        csrfToken: csrf.tokenFor(session.tokenHash),
        sessionTokenHash: session.tokenHash,
        idleExpiresAt,
        absoluteExpiresAt: session.absoluteExpiresAt,
        twoFactor,
        sessionKind: session.kind,
      };
    },

    async issue(executor, input) {
      if (input.twoFactorEnabled && !input.twoFactorVerified) {
        // Dijaga juga oleh query sesi; di sini supaya salah pakai gagal saat dibuat.
        throw new Error('Sesi untuk pengguna ber-2FA aktif harus melewati langkah kedua');
      }
      const twoFactor = twoFactorState(input.user.role, input.twoFactorEnabled);
      const kind: SessionKind = twoFactor.enrollmentRequired ? 'two_factor_enrollment' : 'standard';
      const token = randomToken(32);
      const tokenHash = sha256Hex(token);
      const row = await insertSession(executor, {
        organizationId: input.organization.id,
        userId: input.user.id,
        tokenHash,
        client: input.client,
        kind,
        twoFactorVerified: input.twoFactorVerified,
      });
      return {
        token,
        auth: {
          sessionRef: row.id,
          organizationId: input.organization.id,
          user: input.user,
          organization: input.organization,
          csrfToken: csrf.tokenFor(tokenHash),
          sessionTokenHash: tokenHash,
          idleExpiresAt: row.idleExpiresAt,
          absoluteExpiresAt: row.absoluteExpiresAt,
          twoFactor,
          sessionKind: kind,
        },
      };
    },

    revoke: (executor, organizationId, sessionRef) =>
      revokeSession(executor, organizationId, sessionRef),

    revokeAllForUser: (executor, organizationId, userId, exceptSessionRef) =>
      revokeUserSessions(executor, organizationId, userId, exceptSessionRef),
  };
}

/**
 * Bentuk respons sesi PENUH (login selesai, langkah kedua berhasil, 2FA baru aktif). Melempar
 * bila sesinya ternyata terbatas — pemanggil seharusnya memakai `toSessionResponse`.
 */
export function toAuthenticatedSession(auth: AuthContext): AuthenticatedSession {
  if (auth.twoFactor.enrollmentRequired) {
    throw new Error('Sesi terbatas (wajib mendaftar 2FA) bukan sesi penuh');
  }
  return {
    status: 'authenticated',
    user: auth.user,
    organization: auth.organization,
    csrfToken: auth.csrfToken,
    session: {
      idleExpiresAt: auth.idleExpiresAt.toISOString(),
      absoluteExpiresAt: auth.absoluteExpiresAt.toISOString(),
    },
  };
}

/** Sesi penuh, atau sesi terbatas "wajib mendaftar 2FA" (`GET /auth/me`, login, setup). */
export function toSessionResponse(auth: AuthContext): MeResponse {
  return {
    status: auth.twoFactor.enrollmentRequired ? 'two_factor_enrollment_required' : 'authenticated',
    user: auth.user,
    organization: auth.organization,
    csrfToken: auth.csrfToken,
    session: {
      idleExpiresAt: auth.idleExpiresAt.toISOString(),
      absoluteExpiresAt: auth.absoluteExpiresAt.toISOString(),
    },
  };
}

/** Umur cookie untuk sesi ini (sama dengan batas mutlaknya). */
export function sessionCookieMaxAge(auth: AuthContext): number {
  return auth.twoFactor.enrollmentRequired ? ENROLLMENT_SESSION_SECONDS : SESSION_ABSOLUTE_SECONDS;
}
