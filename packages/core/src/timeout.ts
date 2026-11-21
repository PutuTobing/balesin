/** Dilempar `withTimeout` saat batas waktu terlewati. */
export class TimeoutError extends Error {
  constructor(label: string, timeoutMs: number) {
    super(`${label} melewati batas waktu ${timeoutMs} ms`);
    this.name = 'TimeoutError';
  }
}

/**
 * Menunggu `promise` paling lama `timeoutMs`. Pekerjaan aslinya tidak dibatalkan
 * (JavaScript tidak bisa), hanya tidak ditunggu lagi; hasil/galatnya kemudian diabaikan.
 */
export async function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(label, timeoutMs)), timeoutMs);
  });
  // Cegah "unhandled rejection" bila `promise` gagal setelah batas waktu terlewati.
  promise.catch(() => undefined);
  try {
    return await Promise.race([promise, timeout]);
  } finally {
    clearTimeout(timer);
  }
}
