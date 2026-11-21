import {
  ALLOCATION_MODES,
  AUTO_MESSAGE_KINDS,
  type BotHours,
  type TeamHoliday,
} from '@balesin/shared';
import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { createdAtColumn, idColumn, timestamptz, updatedAtColumn } from './columns';
import { conversations } from './conversations';
import { organizations } from './organizations';
import { users } from './users';

export const allocationMode = pgEnum('allocation_mode', ALLOCATION_MODES);
export const autoMessageKind = pgEnum('auto_message_kind', AUTO_MESSAGE_KINDS);

/**
 * Pengaturan kerja tim per organisasi (Fase 5): jam kerja tim (format `BotHours`, zona organisasi),
 * hari libur, mode alokasi + kapasitas per agen, dan teks pesan otomatis. Satu baris per organisasi
 * (dibuat saat pertama diubah; tanpa baris = bawaan).
 */
export const workspaceSettings = pgTable(
  'workspace_settings',
  {
    organizationId: uuid('organization_id')
      .primaryKey()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    teamHours: jsonb('team_hours').$type<BotHours>().notNull().default({ mode: 'always' }),
    holidays: jsonb('holidays').$type<TeamHoliday[]>().notNull().default([]),
    allocationMode: allocationMode('allocation_mode').notNull().default('manual'),
    maxOpenPerAgent: integer('max_open_per_agent'),
    greetingEnabled: boolean('greeting_enabled').notNull().default(false),
    greetingText: text('greeting_text').notNull(),
    awayEnabled: boolean('away_enabled').notNull().default(false),
    awayText: text('away_text').notNull(),
    assignedEnabled: boolean('assigned_enabled').notNull().default(false),
    assignedText: text('assigned_text').notNull(),
    updatedByUserId: uuid('updated_by_user_id'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'workspace_settings_organization_id_updated_by_user_id_fk',
      columns: [table.organizationId, table.updatedByUserId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    check(
      'workspace_settings_capacity_range',
      sql`${table.maxOpenPerAgent} is null or ${table.maxOpenPerAgent} between 1 and 200`,
    ),
    check(
      'workspace_settings_text_lengths',
      sql`char_length(${table.greetingText}) between 1 and 1000 and char_length(${table.awayText}) between 1 and 1000 and char_length(${table.assignedText}) between 1 and 1000 and jsonb_typeof(${table.holidays}) = 'array' and jsonb_array_length(${table.holidays}) <= 60`,
    ),
  ],
);

export type WorkspaceSettingsRow = typeof workspaceSettings.$inferSelect;
export type NewWorkspaceSettingsRow = typeof workspaceSettings.$inferInsert;

/**
 * Keadaan agen untuk alokasi otomatis: tersedia (saklar agen), dikecualikan (Owner/Admin), dan waktu
 * terakhir mendapat penugasan otomatis (urutan round-robin = paling lama lebih dulu). Baris dibuat
 * worker/api bila belum ada (bawaan: Owner/Admin dikecualikan).
 */
export const agentStates = pgTable(
  'agent_states',
  {
    userId: uuid('user_id').primaryKey(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    available: boolean('available').notNull().default(true),
    excluded: boolean('excluded').notNull().default(false),
    lastAssignedAt: timestamptz('last_assigned_at'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'agent_states_organization_id_user_id_fk',
      columns: [table.organizationId, table.userId],
      foreignColumns: [users.organizationId, users.id],
    }).onDelete('restrict'),
    index('agent_states_organization_id_idx').on(table.organizationId),
  ],
);

export type AgentStateRow = typeof agentStates.$inferSelect;

/**
 * Pesan otomatis per percakapan — penjamin "sekali per sesi": `slot` `welcome` (sapaan ATAU di luar
 * jam kerja) dan `assigned`, unik per percakapan. Baris dibuat SEBELUM pesan dikirim (klaim); yang
 * dilewati dicatat `skip_reason` (mis. jendela tertutup, rem darurat, nonaktif).
 */
export const conversationAutoMessages = pgTable(
  'conversation_auto_messages',
  {
    id: idColumn(),
    organizationId: uuid('organization_id')
      .notNull()
      .references(() => organizations.id, { onDelete: 'restrict' }),
    conversationId: uuid('conversation_id').notNull(),
    slot: text('slot').notNull(),
    kind: autoMessageKind('kind').notNull(),
    /** Pesan yang dikirim (tanpa FK: pesan bisa terhapus bersama kontak). */
    messageId: uuid('message_id'),
    skipReason: text('skip_reason'),
    createdAt: createdAtColumn(),
    updatedAt: updatedAtColumn(),
  },
  (table) => [
    foreignKey({
      name: 'conversation_auto_messages_organization_id_conversation_id_fk',
      columns: [table.organizationId, table.conversationId],
      foreignColumns: [conversations.organizationId, conversations.id],
    }).onDelete('cascade'),
    uniqueIndex('conversation_auto_messages_slot_unique').on(table.conversationId, table.slot),
    check(
      'conversation_auto_messages_slot_kind',
      sql`(${table.slot} = 'assigned') = (${table.kind} = 'assigned') and ${table.slot} in ('welcome', 'assigned')`,
    ),
  ],
);

export type ConversationAutoMessageRow = typeof conversationAutoMessages.$inferSelect;
