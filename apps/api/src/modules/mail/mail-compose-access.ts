import type { DbExecutor, MailAccountRow } from '@balesin/db';
import {
  hasPermission,
  mailLevelAtLeast,
  type MailAccessLevel,
  type MailAccessUser,
} from '@balesin/shared';

import { ACCESS_RULES, forbidByRule, type AccessDeniedRecorder } from '../auth/access-denied';
import type { AuthContext } from '../auth/session.service';
import type { ClientInfo } from '../../http/client-info';
import { levelOf, loadAccountRow, mailNotFound, viewerOf } from './mail.repo';

/**
 * Hak per akun untuk rute 9B (KONTRAK-API-EMAIL-TULIS §1): hak dibaca SEGAR per permintaan
 * (`resolveMailAccess`). Tanpa hak sama sekali / akun pribadi orang lain → 404 (termasuk Owner);
 * level kurang → `forbidByRule` (403 + audit `auth.access.denied`).
 */

export interface AccountAccess {
  viewer: MailAccessUser;
  row: MailAccountRow;
  level: MailAccessLevel;
}

export function createComposeAccess(deps: { db: DbExecutor; accessDenied: AccessDeniedRecorder }) {
  const { db, accessDenied } = deps;

  async function load(
    auth: AuthContext,
    accountId: string,
    options: { includeDeleted?: boolean } = {},
  ): Promise<AccountAccess> {
    const viewer = await viewerOf(db, auth);
    const row = await loadAccountRow(db, auth.organizationId, accountId, {
      includeDeleted: options.includeDeleted,
    });
    if (!row) throw mailNotFound();
    const level = await levelOf(db, viewer, auth.organizationId, row);
    if (!level) throw mailNotFound();
    return { viewer, row, level };
  }

  async function deny(
    auth: AuthContext,
    client: ClientInfo,
    details: Readonly<Record<string, string>>,
    message: string,
  ): Promise<never> {
    return forbidByRule(accessDenied, {
      auth,
      rule: ACCESS_RULES.mailAccountLevel,
      client,
      details,
      message,
    });
  }

  /**
   * Level minimum. `send` juga butuh izin `mail.send` (peran) — hak per akun saja tidak cukup.
   */
  async function require(
    auth: AuthContext,
    accountId: string,
    minimum: MailAccessLevel,
    client: ClientInfo,
    options: { includeDeleted?: boolean } = {},
  ): Promise<AccountAccess> {
    const access = await load(auth, accountId, options);
    const needsSend = minimum !== 'read';
    if (
      !mailLevelAtLeast(access.level, minimum) ||
      (needsSend && !hasPermission(auth.user.role, 'mail.send'))
    ) {
      await deny(
        auth,
        client,
        { required: minimum, level: access.level },
        minimum === 'manage'
          ? 'Hanya pemegang hak Kelola di akun email ini yang bisa mengubahnya.'
          : 'Kamu hanya punya hak Baca di akun email ini, jadi tidak bisa menulis atau mengirim email.',
      );
    }
    return access;
  }

  return { load, require, deny };
}

export type ComposeAccess = ReturnType<typeof createComposeAccess>;
