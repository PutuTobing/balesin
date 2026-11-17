import { broadcastCampaigns, contactEvents, contactTags, tags, type DbExecutor } from '@balesin/db';
import { BROADCAST_LIMITS, TAGS_PER_CONTACT_MAX } from '@balesin/shared';
import { and, count, eq, inArray, isNotNull, sql } from 'drizzle-orm';

/**
 * Balasan pelanggan atas broadcast (Fase 4): penerima yang membalas dalam
 * `BROADCAST_LIMITS.replyAttributionHours` jam setelah broadcast diproses ditandai `replied_at`
 * (laporan "dibalas"), dan — bila kampanyenya memilih tag otomatis — tag itu dipasang ke KONTAK
 * (tag menempel ke kontak, DECISIONS 2026-11-17).
 *
 * Dipanggil DI DALAM transaksi pesan masuk, sesudah kunci kontak & percakapan. Baris penerima dikunci
 * `FOR UPDATE SKIP LOCKED`: baris yang sedang dipegang worker broadcast (urutan kunci kebalikan)
 * dilewati, tidak pernah ditunggu (tanpa deadlock). Mengembalikan `true` bila tag kontak berubah.
 */
export async function recordBroadcastReply(
  tx: DbExecutor,
  input: { organizationId: string; contactId: string; channelId: string; receivedAt: Date },
): Promise<boolean> {
  const since = new Date(
    input.receivedAt.getTime() - BROADCAST_LIMITS.replyAttributionHours * 60 * 60 * 1000,
  );
  const replied = await tx.execute<{ campaign_id: string }>(sql`
    with due as (
      select r.id from broadcast_recipients r
      join broadcast_campaigns c on c.organization_id = r.organization_id and c.id = r.campaign_id
      where r.organization_id = ${input.organizationId}
        and r.contact_id = ${input.contactId}
        and r.status = 'queued'
        and r.replied_at is null
        and r.processed_at > ${since}
        and r.processed_at <= ${input.receivedAt}
        and c.channel_id = ${input.channelId}
      for update of r skip locked
    )
    update broadcast_recipients r set replied_at = ${input.receivedAt}, updated_at = now()
    from due where r.id = due.id
    returning r.campaign_id`);
  const campaignIds = [...new Set(replied.rows.map((row) => row.campaign_id))];
  if (campaignIds.length === 0) return false;

  const autoTags = await tx
    .selectDistinct({ id: tags.id, name: tags.name, color: tags.color })
    .from(broadcastCampaigns)
    .innerJoin(
      tags,
      and(
        eq(tags.organizationId, broadcastCampaigns.organizationId),
        eq(tags.id, broadcastCampaigns.autoTagId),
      ),
    )
    .where(
      and(
        eq(broadcastCampaigns.organizationId, input.organizationId),
        inArray(broadcastCampaigns.id, campaignIds),
        isNotNull(broadcastCampaigns.autoTagId),
      ),
    );
  let changed = false;
  for (const tag of autoTags) {
    const [current] = await tx
      .select({ total: count() })
      .from(contactTags)
      .where(
        and(
          eq(contactTags.organizationId, input.organizationId),
          eq(contactTags.contactId, input.contactId),
        ),
      );
    if (Number(current?.total ?? 0) >= TAGS_PER_CONTACT_MAX) break;
    const inserted = await tx
      .insert(contactTags)
      .values({
        organizationId: input.organizationId,
        contactId: input.contactId,
        tagId: tag.id,
        createdByUserId: null,
      })
      .onConflictDoNothing()
      .returning({ tagId: contactTags.tagId });
    if (inserted.length === 0) continue;
    changed = true;
    await tx.insert(contactEvents).values({
      organizationId: input.organizationId,
      contactId: input.contactId,
      kind: 'tag_added',
      actorUserId: null,
      tagName: tag.name,
      tagColor: tag.color,
    });
  }
  return changed;
}
