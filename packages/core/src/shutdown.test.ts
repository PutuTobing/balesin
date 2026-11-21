import { EventEmitter } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createShutdown, registerCrashHandlers, registerShutdownSignals } from './shutdown';
import { createLogCapture } from './testing';
import { TimeoutError, withTimeout } from './timeout';

afterEach(() => {
  vi.useRealTimers();
});

describe('createShutdown', () => {
  it('menjalankan langkah berurutan lalu keluar dengan kode 0', async () => {
    const order: string[] = [];
    const exit = vi.fn();
    const { logger } = createLogCapture();
    const shutdown = createShutdown({
      logger,
      exit,
      steps: [
        {
          name: 'http',
          run: async () => {
            await new Promise((resolve) => setTimeout(resolve, 5));
            order.push('http');
          },
        },
        { name: 'postgres', run: () => void order.push('postgres') },
        { name: 'redis', run: () => void order.push('redis') },
      ],
    });

    await shutdown('SIGTERM');

    expect(order).toEqual(['http', 'postgres', 'redis']);
    expect(exit).toHaveBeenCalledExactlyOnceWith(0);
  });

  it('hanya berjalan sekali walau dipanggil berkali-kali', async () => {
    const run = vi.fn();
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger: createLogCapture().logger,
      exit,
      steps: [{ name: 'http', run }],
    });

    await Promise.all([shutdown('SIGTERM'), shutdown('SIGINT'), shutdown('SIGTERM')]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
  });

  it('langkah yang gagal dicatat, langkah berikutnya tetap jalan, kode keluar 1', async () => {
    const closeRedis = vi.fn();
    const exit = vi.fn();
    const capture = createLogCapture();
    const shutdown = createShutdown({
      logger: capture.logger,
      exit,
      steps: [
        {
          name: 'postgres',
          run: () => {
            throw new Error('pool macet');
          },
        },
        { name: 'redis', run: closeRedis },
      ],
    });

    await shutdown('SIGTERM');

    expect(closeRedis).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(capture.entries()).toContainEqual(
      expect.objectContaining({ level: 'error', step: 'postgres' }),
    );
  });

  it('memakai kode keluar yang diminta', async () => {
    const exit = vi.fn();
    const shutdown = createShutdown({ logger: createLogCapture().logger, exit, steps: [] });

    await shutdown('uncaughtException', 1);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });

  it('keluar paksa bila penutupan melewati batas waktu', async () => {
    vi.useFakeTimers();
    const exit = vi.fn();
    const shutdown = createShutdown({
      logger: createLogCapture().logger,
      exit,
      timeoutMs: 1_000,
      steps: [{ name: 'macet', run: () => new Promise(() => undefined) }],
    });

    void shutdown('SIGTERM');
    await vi.advanceTimersByTimeAsync(1_000);

    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
  });
});

describe('pendaftaran sinyal dan galat', () => {
  it('SIGTERM dan SIGINT memicu penutupan', () => {
    const source = new EventEmitter();
    const shutdown = vi.fn(() => Promise.resolve());
    registerShutdownSignals(shutdown, source);

    source.emit('SIGTERM');
    source.emit('SIGINT');

    expect(shutdown.mock.calls).toEqual([['SIGTERM'], ['SIGINT']]);
  });

  it('galat tak tertangani dicatat lewat logger (tersensor) lalu keluar dengan kode 1', () => {
    const source = new EventEmitter();
    const shutdown = vi.fn(() => Promise.resolve());
    const capture = createLogCapture();
    registerCrashHandlers(capture.logger, shutdown, source);

    source.emit('uncaughtException', new Error('gagal ke redis://:sandi-bocor@cache:6379'));
    source.emit('unhandledRejection', { token: 'token-bocor' });

    expect(shutdown.mock.calls).toEqual([
      ['uncaughtException', 1],
      ['unhandledRejection', 1],
    ]);
    expect(capture.entries().map((entry) => entry.level)).toEqual(['fatal', 'fatal']);
    expect(capture.text()).not.toContain('sandi-bocor');
    expect(capture.text()).not.toContain('token-bocor');
  });
});

describe('withTimeout', () => {
  it('meneruskan hasil bila selesai tepat waktu', async () => {
    await expect(withTimeout(Promise.resolve('ok'), 50, 'cek')).resolves.toBe('ok');
  });

  it('meneruskan galat aslinya', async () => {
    await expect(withTimeout(Promise.reject(new Error('rusak')), 50, 'cek')).rejects.toThrow(
      'rusak',
    );
  });

  it('melempar TimeoutError bila terlalu lama, dan galat susulan tidak bocor', async () => {
    let rejectLater: (error: Error) => void = () => undefined;
    const slow = new Promise<never>((_resolve, reject) => {
      rejectLater = reject;
    });

    await expect(withTimeout(slow, 10, 'Cek Postgres')).rejects.toBeInstanceOf(TimeoutError);
    rejectLater(new Error('gagal belakangan')); // tidak boleh jadi unhandledRejection
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
});
