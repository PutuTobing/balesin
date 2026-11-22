import type { InboxEventPublisher } from '@balesin/core';
import {
  channelAccessSql,
  conversationEvents,
  conversations,
  recordOutgoingEvent,
  userPrincipal,
  type DbExecutor,
} from '@balesin/db';
import { and, eq, isNotNull, not } from 'drizzle-orm';

import type { NotificationEnqueuer } from '../../queues/notification-queue';

/**
 * Review 9.0 R4: percakapan `served` yang pemegangnya KINI tidak berhak atas channel-nya (akses
 * channel dicabut, atau pengguna keluar dari departemen yang memberinya akses) dikembalikan ke
 * antrian — supaya pelanggan tidak menggantung atas nama agen yang tidak bisa melihatnya dan tidak
 * dihitung beban/kapasitas round-robin. Dipanggil DI transaksi perubahan akses (baris percakapan
 * dikunci `FOR UPDATE`); kejadian `unassigned` (pelaku = pengubah akses) + webhook keluar
 * `conversation.unassigned`. Setelah commit: `publishReleased`.
 */
export interface ReleasedConversation {
  id: string;
  previousAssigneeUserId: string;
}

export async function releaseInaccessibleAssignments(
  tx: DbExecutor,
  input: {
    organizationId: string;
    actorUserId: string;
    /** Batasi ke satu channel (ubah akses channel) atau satu pengguna (ubah departemen). */
    channelId?: string;
    assigneeUserId?: string;
  },
): Promise<ReleasedConversation[]> {
  const org = input.organizationId;
  const rows = await tx
    .select({
      id: conversations.id,
      contactId: conversations.contactId,
      assigneeUserId: conversations.assigneeUserId,
    })
    .from(conversations)
    .where(
      and(
        eq(conversations.organizationId, org),
        eq(conversations.status, 'served'),
        isNotNull(conversations.assigneeUserId),
        input.channelId === undefined ? undefined : eq(conversations.channelId, input.channelId),
        input.assigneeUserId === undefined
          ? undefined
          : eq(conversations.assigneeUserId, input.assigneeUserId),
        not(
          channelAccessSql(
            org,
            userPrincipal(conversations.assigneeUserId),
            conversations.channelId,
          ),
        ),
      ),
    )
    .for('update');
  const released: ReleasedConversation[] = [];
  for (const row of rows) {
    if (!row.assigneeUserId) continue;
    await tx
      .update(conversations)
      .set({ status: 'unserved', assigneeUserId: null })
      .where(and(eq(conversations.organizationId, org), eq(conversations.id, row.id)));
    await tx.insert(conversationEvents).values({
      organizationId: org,
      conversationId: row.id,
      kind: 'unassigned',
      actorUserId: input.actorUserId,
      assigneeUserId: null,
      previousAssigneeUserId: row.assigneeUserId,
    });
    await recordOutgoingEvent(tx, {
      organizationId: org,
      type: 'conversation.unassigned',
      conversationId: row.id,
      contactId: row.contactId,
    });
    released.push({ id: row.id, previousAssigneeUserId: row.assigneeUserId });
  }
  return released;
}

/** Setelah commit: pembaruan real-time + push "kembali ke antrian" (usaha terbaik). */
export async function publishReleased(
  deps: {
    publisher: Pick<InboxEventPublisher, 'publish'>;
    notifications?: NotificationEnqueuer;
  },
  organizationId: string,
  actorUserId: string,
  released: readonly ReleasedConversation[],
): Promise<void> {
  if (released.length === 0) return;
  await deps.publisher.publish(
    released.map((row) => ({
      type: 'conversation.updated' as const,
      organizationId,
      conversationId: row.id,
      previousAssigneeUserId: row.previousAssigneeUserId,
    })),
  );
  // Satu job per percakapan (antarmuka antrean menerima satu payload).
  for (const row of released) {
    await deps.notifications?.enqueue({
      organizationId,
      kind: 'queued',
      conversationId: row.id,
      actorUserId,
    });
  }
}
