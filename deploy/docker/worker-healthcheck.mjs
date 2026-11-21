// Healthcheck container worker (dipanggil Docker, lihat deploy/docker/Dockerfile).
//
// Worker tidak membuka port HTTP. Sehat = proses worker sedang tersambung ke Redis dengan nama
// koneksinya (`balesin-worker`, dari createRedis di apps/worker). Bila worker macet sebelum
// tersambung atau koneksinya putus terus, healthcheck gagal dan `balesin update` melakukan rollback.
// Tidak mencetak REDIS_URL (memuat password).
import { Redis } from 'ioredis';

const url = process.env.REDIS_URL;
if (!url) {
  console.error('REDIS_URL kosong');
  process.exit(1);
}

const redis = new Redis(url, {
  connectionName: 'balesin-worker-healthcheck',
  lazyConnect: true,
  maxRetriesPerRequest: 0,
  enableOfflineQueue: false,
  connectTimeout: 4000,
  retryStrategy: () => null,
});

try {
  await redis.connect();
  const clients = String(await redis.client('LIST'));
  const connected = clients
    .split('\n')
    .some((line) => /(^|\s)name=balesin-worker(\s|$)/.test(line));
  if (!connected) {
    console.error('Worker belum tersambung ke Redis');
    process.exitCode = 1;
  }
} catch {
  console.error('Redis tidak terjangkau dari container worker');
  process.exitCode = 1;
} finally {
  redis.disconnect();
}
