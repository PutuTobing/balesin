/**
 * Server Graph API Meta TIRUAN untuk stack E2E, dijalankan `start-backend.mjs` (lewat tsx) sebelum
 * API dan worker. Memakai server tiruan yang sama dengan tes integrasi API
 * (`apps/api/src/testing/fake-meta.ts`), diisi data tetap dari `fake-meta-data.ts`, lalu mencetak
 * alamatnya (`FAKE_META_URL=…`) supaya API dijalankan dengan `META_GRAPH_BASE_URL` itu.
 * Hanya mendengarkan 127.0.0.1; tidak pernah meneruskan apa pun ke Meta sungguhan.
 */
import { startFakeMeta } from '../../apps/api/src/testing/fake-meta';
import { FAKE_META, FAKE_META_READY_PREFIX } from './fake-meta-data';

const meta = await startFakeMeta();

for (const token of [FAKE_META.token, FAKE_META.replacementToken]) {
  meta.tokens.set(token, { appSecret: FAKE_META.appSecret });
}
meta.wabas.add(FAKE_META.wabaId);
for (const number of Object.values(FAKE_META.numbers)) {
  meta.phoneNumbers.set(number.id, {
    id: number.id,
    wabaId: FAKE_META.wabaId,
    display_phone_number: number.display,
    verified_name: number.verifiedName,
    quality_rating: 'GREEN',
    status: 'CONNECTED',
    name_status: 'APPROVED',
    code_verification_status: 'VERIFIED',
    whatsapp_business_manager_messaging_limit: 'TIER_1K',
    throughput: { level: 'STANDARD' },
    profile: { ...FAKE_META.profile, websites: [...FAKE_META.profile.websites] },
  });
}

process.stdout.write(`${FAKE_META_READY_PREFIX}${meta.url}\n`);

const stop = () => {
  void meta.close().finally(() => process.exit(0));
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
