import { describe, expect, it } from 'vitest';

import { AppError } from './errors';

describe('AppError', () => {
  it('memakai status dan pesan bawaan sesuai kode', () => {
    const error = new AppError('NOT_FOUND');
    expect(error).toBeInstanceOf(Error);
    expect(error.statusCode).toBe(404);
    expect(error.message).toBe('Data atau alamat yang diminta tidak ditemukan.');
    expect(error.details).toBeUndefined();
  });

  it('menerima pesan, status, rincian, dan penyebab khusus', () => {
    const cause = new Error('unique violation');
    const error = new AppError('CONFLICT', {
      message: 'Email sudah dipakai.',
      details: [{ location: 'body', field: 'email', message: 'Email sudah dipakai.' }],
      cause,
    });

    expect(error.statusCode).toBe(409);
    expect(error.message).toBe('Email sudah dipakai.');
    expect(error.details).toHaveLength(1);
    expect(error.cause).toBe(cause);
  });
});
