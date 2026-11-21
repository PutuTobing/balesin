import { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { fakeSession } from '../../test/fake-api';
import { queryKeys, storeSession } from './queries';

/** Data milik pengguna yang tidak boleh terbawa ke pengguna berikutnya di browser yang sama. */
const PRIVATE_KEY = ['settings', 'email'] as const;

function clientWith(previous: ReturnType<typeof fakeSession> | null): QueryClient {
  const client = new QueryClient();
  client.setQueryData(queryKeys.session, previous);
  client.setQueryData(PRIVATE_KEY, { host: 'mail.contoh.id' });
  client.setQueryData(queryKeys.branding, { productName: 'Balesin' });
  return client;
}

describe('storeSession', () => {
  it('menyimpan izin sesi (permissions) — tidak ada = []; field lain di luar sesi dibuang', () => {
    const client = new QueryClient();
    const session = fakeSession('admin');
    storeSession(client, { ...session, backupCodes: { codes: ['rahasia'] } } as typeof session);
    const stored = client.getQueryData<typeof session>(queryKeys.session);
    expect(stored?.permissions).toEqual(session.permissions);
    expect(stored?.permissions).toContain('team.invite');
    expect(JSON.stringify(stored)).not.toContain('rahasia');

    const { permissions: _omit, ...older } = session;
    storeSession(client, older);
    expect(client.getQueryData<typeof session>(queryKeys.session)?.permissions).toEqual([]);
  });

  it('membuang data pengguna sebelumnya bila yang masuk pengguna lain (komputer bersama)', () => {
    const client = clientWith(fakeSession('owner'));
    const next = fakeSession('cs', 'Budi');
    next.user.id = '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0099';

    storeSession(client, next);

    expect(client.getQueryData(PRIVATE_KEY)).toBeUndefined();
    // Data publik tetap ada supaya merek tidak berkedip.
    expect(client.getQueryData(queryKeys.branding)).toEqual({ productName: 'Balesin' });
    expect(client.getQueryData(queryKeys.session)).toMatchObject({ user: { name: 'Budi' } });
  });

  it('mempertahankan data bila pengguna yang sama memperbarui sesinya', () => {
    const client = clientWith(fakeSession('owner'));

    storeSession(client, fakeSession('owner'));

    expect(client.getQueryData(PRIVATE_KEY)).toEqual({ host: 'mail.contoh.id' });
  });
});
