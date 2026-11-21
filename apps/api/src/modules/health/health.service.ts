import { withTimeout } from '@balesin/core';
import type { DependencyStatus, ReadyResponse } from '@balesin/shared';
import type { FastifyBaseLogger } from 'fastify';

/** Pemeriksaan satu dependensi: selesai tanpa error = sehat. */
export type ReadinessProbe = () => Promise<void>;

export interface ReadinessProbes {
  postgres: ReadinessProbe;
  redis: ReadinessProbe;
}

export interface ReadinessServiceOptions {
  probes: ReadinessProbes;
  logger: FastifyBaseLogger;
  /** Batas waktu tiap pemeriksaan. Bawaan 2 detik. */
  timeoutMs?: number;
}

export interface ReadinessService {
  check(): Promise<ReadyResponse>;
}

type DependencyName = keyof ReadinessProbes;

const DEFAULT_TIMEOUT_MS = 2_000;
const DEPENDENCY_LABELS: Record<DependencyName, string> = {
  postgres: 'Postgres',
  redis: 'Redis',
};

/**
 * Pemeriksaan kesiapan untuk `GET /ready`.
 *
 * - Tiap dependensi diberi batas waktu, jadi `/ready` tidak pernah menggantung.
 * - Hasilnya hanya `ok`/`down`: penyebab aslinya dicatat di log, tidak dikirim ke klien.
 * - Permintaan yang datang bersamaan berbagi satu pemeriksaan yang sama, sehingga `/ready`
 *   (endpoint publik) tidak bisa dipakai membanjiri Postgres/Redis.
 * - Log hanya ditulis saat status berubah, supaya dependensi yang mati tidak membanjiri log.
 */
export function createReadinessService(options: ReadinessServiceOptions): ReadinessService {
  const { probes, logger } = options;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const lastStatus: Partial<Record<DependencyName, DependencyStatus>> = {};
  let inFlight: Promise<ReadyResponse> | undefined;

  async function checkDependency(name: DependencyName): Promise<DependencyStatus> {
    const label = DEPENDENCY_LABELS[name];
    let status: DependencyStatus = 'ok';
    try {
      await withTimeout(Promise.resolve().then(probes[name]), timeoutMs, `Pemeriksaan ${label}`);
    } catch (err) {
      status = 'down';
      if (lastStatus[name] !== 'down') {
        logger.warn({ err, dependency: name }, `${label} tidak bisa dihubungi`);
      }
    }
    if (status === 'ok' && lastStatus[name] === 'down') {
      logger.info({ dependency: name }, `${label} kembali terhubung`);
    }
    lastStatus[name] = status;
    return status;
  }

  async function run(): Promise<ReadyResponse> {
    const [postgres, redis] = await Promise.all([
      checkDependency('postgres'),
      checkDependency('redis'),
    ]);
    const allOk = postgres === 'ok' && redis === 'ok';
    return { status: allOk ? 'ok' : 'unavailable', dependencies: { postgres, redis } };
  }

  return {
    check() {
      inFlight ??= run().finally(() => {
        inFlight = undefined;
      });
      return inFlight;
    },
  };
}
