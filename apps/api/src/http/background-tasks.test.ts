import { createLogCapture } from '@balesin/core/testing';
import { DrizzleQueryError } from 'drizzle-orm/errors';
import { describe, expect, it } from 'vitest';

import { createBackgroundTasks } from './background-tasks';

describe('BackgroundTasks', () => {
  it('menjalankan pekerjaan setelah pemanggil lanjut; drain menunggu sampai selesai', async () => {
    const logs = createLogCapture();
    const tasks = createBackgroundTasks();
    const order: string[] = [];
    tasks.run(
      'tes',
      () => {
        order.push('pekerjaan');
        return Promise.resolve();
      },
      logs.logger,
    );
    order.push('jawaban');
    await tasks.drain();
    expect(order).toEqual(['jawaban', 'pekerjaan']);
  });

  it('kegagalan tidak dilempar ke pemanggil, dicatat level error dengan nama tugas, tanpa nilai parameter query', async () => {
    const logs = createLogCapture();
    const tasks = createBackgroundTasks();
    const pgError = Object.assign(new Error('duplicate key value violates unique constraint'), {
      code: '23505',
      severity: 'ERROR',
      constraint: 'account_tokens_live_unique',
      detail: 'Key (user_id, purpose)=(nilai-baris-rahasia, password_reset) already exists.',
    });
    const failure = new DrizzleQueryError(
      'insert into "account_tokens" ("token_hash") values ($1)',
      ['hash-token-rahasia-0123456789abcdef'],
      pgError,
    );
    tasks.run('password-reset.issue', () => Promise.reject(failure), logs.logger);
    await expect(tasks.drain()).resolves.toBeUndefined();

    const [entry] = logs.entries();
    expect(entry).toMatchObject({
      level: 'error',
      task: 'password-reset.issue',
      msg: 'Pekerjaan latar belakang gagal',
    });
    const text = logs.text();
    expect(text).toContain('account_tokens_live_unique');
    expect(text).toContain('23505');
    expect(text).not.toContain('hash-token-rahasia');
    expect(text).not.toContain('nilai-baris-rahasia');
  });
});
