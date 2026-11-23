import {
  abortMailSession,
  QUEUE_PREFIX,
  classifyMailImapError,
  defaultMailImapConnector,
  openMailAccountSecret,
  type Logger,
  type MailImapConnector,
  type MailImapSession,
  type Redis,
  type SecretBox,
} from '@balesin/core';
import { mailAccounts, type Database, type MailAccountRow } from '@balesin/db';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';

import { acquireLease, mailIdleLeaseKey, type Lease } from '../mail/lease';
import { inboxFolderOf, type MailSync } from '../mail/sync';

/**
 * Pengawas IDLE Kotak masuk (KONTRAK-API-EMAIL §11) — di dalam proses worker, bukan job:
 *  - SATU sambungan IDLE per akun di semua replika: sewa Redis `mail:idle:<accountId>`
 *    (`SET NX PX 60000`, diperpanjang tiap 20 dtk; sewa hilang → sambungan ditutup).
 *  - Daftar akun dipindai tiap 30 dtk; akun `paused`/`auth_failed`/`owner_inactive`/`deleting` (atau
 *    yang servernya tanpa IDLE) ditutup. Maks. 200 IDLE per proses; sisanya dipolling 2 menit (tick).
 *  - IDLE diperbarui tiap 25 menit (RFC 2177 < 29 menit); `EXISTS`/`EXPUNGE`/`FETCH` → antre
 *    `mail-sync-folder` Kotak masuk (debounce 2 dtk).
 *  - Gagal → sambungan ditutup, dicoba lagi ≥ 1 menit kemudian (status akun dicatat job sinkron).
 */

export interface IdleSupervisorDeps {
  db: Database;
  redis: Redis;
  logger: Logger;
  secretBox: SecretBox | null;
  sync: Pick<MailSync, 'policyFor'>;
  enqueueFolder(payload: {
    organizationId: string;
    accountId: string;
    folderId: string;
  }): Promise<void>;
  connector?: MailImapConnector;
  prefix?: string;
  maxConnections?: number;
  scanIntervalMs?: number;
  idleRefreshMs?: number;
  debounceMs?: number;
  leaseMs?: number;
  renewMs?: number;
  retryAfterFailureMs?: number;
}

interface Running {
  accountId: string;
  organizationId: string;
  /** Review 9A-1 R2: host/port/keamanan/username/kredensial saat IDLE dibuka. */
  fingerprint: string;
  abort: AbortController;
  done: Promise<void>;
}

export interface IdleSupervisor {
  /** Satu putaran pindai (publik untuk tes). */
  scan(): Promise<void>;
  running(): string[];
  close(): Promise<void>;
}

const ELIGIBLE_STATES = ['initial_sync', 'ready', 'syncing'] as const;

const fingerprintOf = (row: MailAccountRow) =>
  [row.imapHost, row.imapPort, row.imapSecurity, row.imapUsername, row.imapPasswordEncrypted].join(
    '|',
  );

export function createIdleSupervisor(deps: IdleSupervisorDeps): IdleSupervisor {
  const { db, redis, logger } = deps;
  const connector = deps.connector ?? defaultMailImapConnector;
  const prefix = deps.prefix ?? QUEUE_PREFIX;
  const maxConnections = deps.maxConnections ?? 200;
  const leaseMs = deps.leaseMs ?? 60_000;
  const renewMs = deps.renewMs ?? 20_000;
  const idleRefreshMs = deps.idleRefreshMs ?? 25 * 60_000;
  const debounceMs = deps.debounceMs ?? 2_000;
  const retryAfterFailureMs = deps.retryAfterFailureMs ?? 60_000;
  const runs = new Map<string, Running>();
  const cooldown = new Map<string, number>();
  let closed = false;
  let warnedLimit = false;

  async function setIdleActive(
    row: Pick<MailAccountRow, 'id' | 'organizationId'>,
    active: boolean,
  ) {
    await db
      .update(mailAccounts)
      .set({ idleActive: active })
      .where(and(eq(mailAccounts.organizationId, row.organizationId), eq(mailAccounts.id, row.id)))
      .catch(() => undefined);
  }

  async function runIdle(row: MailAccountRow, lease: Lease, abort: AbortController): Promise<void> {
    const renewTimer = setInterval(() => {
      lease
        .renew(leaseMs)
        .then((ok) => {
          if (!ok) abort.abort();
        })
        .catch(() => abort.abort());
    }, renewMs);
    renewTimer.unref();
    let session: MailImapSession | null = null;
    let pending: ReturnType<typeof setTimeout> | null = null;
    try {
      if (!deps.secretBox || !row.imapPasswordEncrypted) throw new Error('tanpa kredensial');
      const password = openMailAccountSecret(
        deps.secretBox,
        row,
        'imapPassword',
        row.imapPasswordEncrypted,
      );
      const inbox = await inboxFolderOf(db, row.organizationId, row.id);
      if (!inbox) throw new Error('Kotak masuk belum tersinkron');
      session = await connector(
        {
          host: row.imapHost ?? '',
          port: row.imapPort ?? 993,
          security: row.imapSecurity === 'starttls' ? 'starttls' : 'ssl',
          username: row.imapUsername ?? '',
          password,
        },
        await deps.sync.policyFor(row.organizationId),
        { signal: abort.signal },
      );
      const opened = session;
      abort.signal.addEventListener('abort', () => abortMailSession(opened), { once: true });
      if (!session.capabilities.idle) return;
      await session.select(inbox.path);
      await setIdleActive(row, true);
      const trigger = () => {
        if (pending) return;
        pending = setTimeout(() => {
          pending = null;
          deps
            .enqueueFolder({
              organizationId: row.organizationId,
              accountId: row.id,
              folderId: inbox.id,
            })
            .catch((err: unknown) =>
              logger.warn({ err, accountId: row.id }, 'Sinkron IDLE gagal diantrekan'),
            );
        }, debounceMs);
        pending.unref();
      };
      while (!abort.signal.aborted && !closed) {
        await session.idle({ maxMs: idleRefreshMs, signal: abort.signal, onChange: trigger });
      }
    } catch (error) {
      cooldown.set(row.id, Date.now() + retryAfterFailureMs);
      const failure = classifyMailImapError(error);
      logger.warn({ accountId: row.id, code: failure.code }, 'IDLE akun email berhenti');
    } finally {
      clearInterval(renewTimer);
      if (pending) clearTimeout(pending);
      await session?.close().catch(() => undefined);
      await setIdleActive(row, false);
      await lease.release();
    }
  }

  async function scan(): Promise<void> {
    if (closed) return;
    const rows = await db
      .select()
      .from(mailAccounts)
      .where(
        and(
          isNull(mailAccounts.deletedAt),
          inArray(mailAccounts.syncState, [...ELIGIBLE_STATES]),
          sql`coalesce((${mailAccounts.capabilities} ->> 'idle')::boolean, false)`,
          // Review 9A-1 R2: pemilik akun pribadi nonaktif → IDLE ditutup pada pindaian ini juga.
          sql`(${mailAccounts.kind} = 'shared' or exists (select 1 from users u where u.organization_id = ${mailAccounts.organizationId} and u.id = ${mailAccounts.ownerUserId} and u.disabled_at is null))`,
        ),
      );
    const eligible = new Map(rows.map((row) => [row.id, row]));
    // Tutup yang tidak lagi memenuhi syarat.
    for (const [id, run] of runs) {
      const current = eligible.get(id);
      // Server/kredensial diganti → sambungan lama (host & password LAMA) ditutup.
      if (!current || fingerprintOf(current) !== run.fingerprint) run.abort.abort();
    }
    const nowMs = Date.now();
    for (const row of rows) {
      if (runs.has(row.id)) continue;
      if ((cooldown.get(row.id) ?? 0) > nowMs) continue;
      if (runs.size >= maxConnections) {
        if (!warnedLimit) {
          warnedLimit = true;
          logger.warn(
            { limit: maxConnections },
            'Batas IDLE per proses tercapai: akun lain dipolling 2 menit',
          );
        }
        break;
      }
      const lease = await acquireLease(redis, mailIdleLeaseKey(prefix, row.id), leaseMs);
      if (!lease) continue; // dipegang replika lain
      const abort = new AbortController();
      const run: Running = {
        accountId: row.id,
        organizationId: row.organizationId,
        fingerprint: fingerprintOf(row),
        abort,
        done: Promise.resolve(),
      };
      run.done = runIdle(row, lease, abort).finally(() => {
        runs.delete(row.id);
      });
      runs.set(row.id, run);
    }
  }

  const scanTimer = setInterval(() => {
    scan().catch((err: unknown) => logger.warn({ err }, 'Pemindaian IDLE akun email gagal'));
  }, deps.scanIntervalMs ?? 30_000);
  scanTimer.unref();

  return {
    scan,
    running: () => [...runs.keys()],
    async close() {
      closed = true;
      clearInterval(scanTimer);
      const all = [...runs.values()];
      for (const run of all) run.abort.abort();
      await Promise.allSettled(all.map((run) => run.done));
    },
  };
}
