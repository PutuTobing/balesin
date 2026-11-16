import { sql } from 'drizzle-orm';

import type { DbExecutor } from './client';
import { newId } from './ids';
import { outgoingEvents, webhookEndpoints } from './schema';

/**
 * Catat kejadian untuk webhook keluar (transactional outbox, Fase 3) — panggil di DALAM transaksi
 * yang membuat perubahannya, supaya kejadian ada bila dan hanya bila perubahannya commit. HANYA ID +
 * jenis (payload dibangun worker). Baris hanya ditulis bila ada endpoint AKTIF organisasi itu yang
 * melanggan jenis tersebut (tanpa langganan = tanpa biaya).
 */
export async function recordOutgoingEvent(
  db: DbExecutor,
  event: {
    organizationId: string;
    type: string;
    conversationId?: string | null;
    messageId?: string | null;
    contactId?: string | null;
    actorUserId?: string | null;
  },
): Promise<void> {
  await db.execute(sql`
    insert into ${outgoingEvents}
      (id, organization_id, type, conversation_id, message_id, contact_id, actor_user_id)
    select ${newId()}, ${event.organizationId}, ${event.type}, ${event.conversationId ?? null},
      ${event.messageId ?? null}, ${event.contactId ?? null}, ${event.actorUserId ?? null}
    where exists (
      select 1 from ${webhookEndpoints}
      where ${webhookEndpoints.organizationId} = ${event.organizationId}
        and ${webhookEndpoints.enabled}
        and ${event.type} = any(${webhookEndpoints.events})
    )`);
}
