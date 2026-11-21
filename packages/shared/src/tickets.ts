import { z } from 'zod';

import { attributeDefinitionSchema } from './crm';
import { departmentRefSchema } from './departments';
import { hasControlCharacters, isoDateTimeSchema } from './fields';
import {
  contactAttributesSchema,
  contactSummarySchema,
  conversationStatusSchema,
  inboxCursorSchema,
} from './inbox';

/**
 * Tiket / tugas (Fase 5, PRD §3.6; docs/KONTRAK-API-CRM-TIKET.md "Tiket").
 *
 * - Beberapa BOARD (proyek), tiap board punya KOLOM status berurutan (Kanban + Daftar). Kolom
 *   bertanda `isDone` = selesai: tiket yang masuk ke sana diberi `closedAt`.
 * - Tiket: judul, deskripsi, prioritas, penanggung jawab, tenggat, atribut kustom (definisi per
 *   board), tautan ke kontak & percakapan, komentar, riwayat.
 * - Izin: lihat/ubah = `tickets.manage` (Teknisi `own` = tiket yang ia pegang; pengguna bertanda
 *   departemen = `department`); board/kolom/atribut = `tickets.configure`.
 * - Teknisi yang memegang tiket TERBUKA yang menaut sebuah kontak boleh melihat & membalas
 *   percakapan kontak itu (cakupan `assigned` "terkait tiketnya", PRD §4).
 */

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const;
export const ticketPrioritySchema = z.enum(TICKET_PRIORITIES, {
  error: 'Prioritas tidak dikenal.',
});
export type TicketPriority = z.infer<typeof ticketPrioritySchema>;
export const TICKET_PRIORITY_LABELS: Readonly<Record<TicketPriority, string>> = {
  low: 'Rendah',
  normal: 'Normal',
  high: 'Tinggi',
  urgent: 'Mendesak',
};

export const TICKET_LIMITS = {
  boardsPerOrganization: 50,
  columnsPerBoard: 20,
  titleMax: 200,
  descriptionMax: 5_000,
  commentMax: 5_000,
  boardNameMax: 80,
  boardDescriptionMax: 300,
  columnNameMax: 40,
  /** Tiket per kolom di tampilan Kanban (sisanya lewat Daftar). */
  kanbanPerColumn: 100,
  pageDefault: 50,
  pageMax: 100,
} as const;

/** Kolom bawaan board baru (bisa diubah). */
export const DEFAULT_TICKET_COLUMNS = [
  { name: 'Baru', isDone: false },
  { name: 'Dikerjakan', isDone: false },
  { name: 'Selesai', isDone: true },
] as const;

const textField = (label: string, max: number) =>
  z
    .string({ error: `${label} wajib diisi.` })
    .trim()
    .min(1, `${label} wajib diisi.`)
    .max(max, `${label} maksimal ${max.toLocaleString('id-ID')} karakter.`)
    .refine((value) => !hasControlCharacters(value), `${label} memuat karakter khusus.`);

/** Teks banyak baris: baris baru & tab boleh, karakter tak terlihat lain tidak. */
const multilineField = (label: string, max: number) =>
  z
    .string()
    .trim()
    .min(1, `${label} kosong — kirim null untuk menghapusnya.`)
    .max(max, `${label} maksimal ${max.toLocaleString('id-ID')} karakter.`)
    .refine(
      (value) => !hasControlCharacters(value.replace(/\r?\n|\t/g, ' ')),
      `${label} memuat karakter khusus tak terlihat.`,
    );

// ── Board & kolom ───────────────────────────────────────────────────────────

export const ticketColumnSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  position: z.number().int(),
  isDone: z.boolean(),
});
export type TicketColumn = z.infer<typeof ticketColumnSchema>;

export const ticketBoardSchema = z.object({
  id: z.uuid(),
  name: z.string(),
  description: z.string().nullable(),
  department: departmentRefSchema.nullable(),
  position: z.number().int(),
  columns: z.array(ticketColumnSchema),
  attributes: z.array(attributeDefinitionSchema),
  archivedAt: isoDateTimeSchema.nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type TicketBoard = z.infer<typeof ticketBoardSchema>;
export const ticketBoardListResponseSchema = z.object({ boards: z.array(ticketBoardSchema) });
export type TicketBoardListResponse = z.infer<typeof ticketBoardListResponseSchema>;
export const ticketBoardResponseSchema = z.object({ board: ticketBoardSchema });
export type TicketBoardResponse = z.infer<typeof ticketBoardResponseSchema>;

export const ticketBoardIdParamsSchema = z.object({ boardId: z.string() });
export const ticketColumnParamsSchema = z.object({ boardId: z.string(), columnId: z.string() });
export const ticketBoardAttributeParamsSchema = z.object({
  boardId: z.string(),
  attributeId: z.string(),
});

const columnNameSchema = textField('Nama kolom', TICKET_LIMITS.columnNameMax);

export const createTicketBoardRequestSchema = z.object({
  name: textField('Nama board', TICKET_LIMITS.boardNameMax),
  description: multilineField('Deskripsi', TICKET_LIMITS.boardDescriptionMax)
    .nullable()
    .default(null),
  departmentId: z.uuid({ error: 'Departemen tidak valid.' }).nullable().default(null),
  /** Kosong = kolom bawaan (`DEFAULT_TICKET_COLUMNS`). */
  columns: z
    .array(z.object({ name: columnNameSchema, isDone: z.boolean().default(false) }))
    .min(1, 'Board butuh minimal satu kolom.')
    .max(TICKET_LIMITS.columnsPerBoard)
    .optional(),
});
export type CreateTicketBoardRequest = z.input<typeof createTicketBoardRequestSchema>;

export const updateTicketBoardRequestSchema = z
  .object({
    name: textField('Nama board', TICKET_LIMITS.boardNameMax).optional(),
    description: multilineField('Deskripsi', TICKET_LIMITS.boardDescriptionMax)
      .nullable()
      .optional(),
    departmentId: z.uuid({ error: 'Departemen tidak valid.' }).nullable().optional(),
    position: z.number().int().min(0).max(1000).optional(),
    /** `true` = arsipkan (tidak tampil di daftar bawaan, tiket tidak bisa dibuat). */
    archived: z.boolean().optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    error: 'Tidak ada yang diubah.',
  });
export type UpdateTicketBoardRequest = z.infer<typeof updateTicketBoardRequestSchema>;

export const createTicketColumnRequestSchema = z.object({
  name: columnNameSchema,
  isDone: z.boolean().default(false),
  /** Posisi sisip (0 = paling kiri); kosong = paling kanan. */
  position: z.number().int().min(0).max(TICKET_LIMITS.columnsPerBoard).optional(),
});
export type CreateTicketColumnRequest = z.input<typeof createTicketColumnRequestSchema>;

export const updateTicketColumnRequestSchema = z
  .object({
    name: columnNameSchema.optional(),
    isDone: z.boolean().optional(),
    position: z.number().int().min(0).max(TICKET_LIMITS.columnsPerBoard).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    error: 'Tidak ada yang diubah.',
  });
export type UpdateTicketColumnRequest = z.infer<typeof updateTicketColumnRequestSchema>;

/** `DELETE` kolom: tiket di dalamnya dipindah ke `moveToColumnId` (wajib bila kolom berisi). */
export const deleteTicketColumnRequestSchema = z.object({
  moveToColumnId: z.uuid({ error: 'Kolom tujuan tidak valid.' }).optional(),
});
export type DeleteTicketColumnRequest = z.infer<typeof deleteTicketColumnRequestSchema>;

// ── Tiket ───────────────────────────────────────────────────────────────────

const userRefSchema = z.object({ id: z.uuid(), name: z.string() });

export const ticketSchema = z.object({
  id: z.uuid(),
  /** Nomor publik berurutan (`#123`). */
  number: z.number().int().positive(),
  boardId: z.uuid(),
  column: ticketColumnSchema,
  title: z.string(),
  description: z.string().nullable(),
  priority: ticketPrioritySchema,
  assignee: userRefSchema.nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  /** Tenggat sudah lewat dan tiket belum selesai (jam server). */
  overdue: z.boolean(),
  contact: contactSummarySchema.nullable(),
  conversation: z
    .object({ id: z.uuid(), number: z.number().int(), status: conversationStatusSchema })
    .nullable(),
  attributes: z.array(z.object({ key: z.string(), value: z.string() })),
  /** Urutan di kolom Kanban (makin kecil makin atas). */
  position: z.number(),
  closedAt: isoDateTimeSchema.nullable(),
  /** Pembuat: pengguna, atau API key (bot/n8n) — nama key. */
  createdBy: z
    .object({ kind: z.enum(['user', 'api_key']), id: z.uuid(), name: z.string() })
    .nullable(),
  createdAt: isoDateTimeSchema,
  updatedAt: isoDateTimeSchema,
});
export type Ticket = z.infer<typeof ticketSchema>;
export const ticketResponseSchema = z.object({ ticket: ticketSchema });
export type TicketResponse = z.infer<typeof ticketResponseSchema>;
export const ticketIdParamsSchema = z.object({ ticketId: z.string() });
/**
 * Jawaban aksi tulis: keadaan terbaru menurut cakupan pemanggil SESUDAH aksi; `null` = berhasil tetapi
 * pemanggil tidak lagi boleh melihat tiket itu (mis. dialihkan ke orang lain di departemen lain).
 */
export const ticketActionResponseSchema = z.object({ ticket: ticketSchema.nullable() });
export type TicketActionResponse = z.infer<typeof ticketActionResponseSchema>;
export const ticketBoardListQuerySchema = z.object({
  archived: z
    .enum(['true', 'false'])
    .transform((value) => value === 'true')
    .optional(),
});

export const TICKET_STATUS_FILTERS = ['open', 'closed', 'all'] as const;
export const TICKET_DUE_FILTERS = ['overdue', 'today', 'week', 'none'] as const;

/** `GET /tickets` — saringan + kursor (`updatedAt` terbaru dulu). */
export const ticketListQuerySchema = z.object({
  boardId: z.uuid({ error: 'Board tidak valid.' }).optional(),
  columnId: z.uuid({ error: 'Kolom tidak valid.' }).optional(),
  /** UUID pengguna, `me`, atau `none` (belum ada penanggung jawab). */
  assignee: z
    .union([z.uuid(), z.literal('me'), z.literal('none')], {
      error: 'Penanggung jawab tidak valid.',
    })
    .optional(),
  priority: ticketPrioritySchema.optional(),
  status: z.enum(TICKET_STATUS_FILTERS, { error: 'Status tidak dikenal.' }).default('open'),
  due: z.enum(TICKET_DUE_FILTERS, { error: 'Saringan tenggat tidak dikenal.' }).optional(),
  contactId: z.uuid({ error: 'Kontak tidak valid.' }).optional(),
  conversationId: z.uuid({ error: 'Percakapan tidak valid.' }).optional(),
  /** Judul atau nomor tiket (`#12` / `12`); 2–100 karakter. */
  q: z
    .string()
    .trim()
    .min(1, 'Kata pencarian wajib diisi.')
    .max(100, 'Kata pencarian terlalu panjang (maks. 100 karakter).')
    .optional(),
  cursor: inboxCursorSchema.optional(),
  limit: z.coerce.number().int().min(1).max(TICKET_LIMITS.pageMax).optional(),
});
export type TicketListQuery = z.infer<typeof ticketListQuerySchema>;
export const ticketListResponseSchema = z.object({
  tickets: z.array(ticketSchema),
  nextCursor: z.string().nullable(),
});
export type TicketListResponse = z.infer<typeof ticketListResponseSchema>;

/** `GET /ticket-boards/:boardId/kanban` — per kolom maks. `kanbanPerColumn` tiket + jumlahnya. */
export const ticketKanbanQuerySchema = z.object({
  assignee: z
    .union([z.uuid(), z.literal('me'), z.literal('none')], {
      error: 'Penanggung jawab tidak valid.',
    })
    .optional(),
  priority: ticketPrioritySchema.optional(),
});
export const ticketKanbanResponseSchema = z.object({
  board: ticketBoardSchema,
  columns: z.array(
    z.object({
      column: ticketColumnSchema,
      total: z.number().int().nonnegative(),
      tickets: z.array(ticketSchema),
    }),
  ),
});
export type TicketKanbanResponse = z.infer<typeof ticketKanbanResponseSchema>;

const ticketFields = {
  title: textField('Judul', TICKET_LIMITS.titleMax),
  description: multilineField('Deskripsi', TICKET_LIMITS.descriptionMax).nullable(),
  priority: ticketPrioritySchema,
  assigneeUserId: z.uuid({ error: 'Penanggung jawab tidak valid.' }).nullable(),
  dueAt: isoDateTimeSchema.nullable(),
  contactId: z.uuid({ error: 'Kontak tidak valid.' }).nullable(),
  conversationId: z.uuid({ error: 'Percakapan tidak valid.' }).nullable(),
  attributes: contactAttributesSchema,
};

/**
 * `POST /tickets`. `columnId` kosong = kolom pertama board. `conversationId` mengisi `contactId`
 * otomatis (kontak percakapan itu). Tautan hanya ke data yang BOLEH dilihat pembuat.
 */
export const createTicketRequestSchema = z.object({
  boardId: z.uuid({ error: 'Pilih board.' }),
  columnId: z.uuid({ error: 'Kolom tidak valid.' }).optional(),
  title: ticketFields.title,
  description: ticketFields.description.default(null),
  priority: ticketFields.priority.default('normal'),
  assigneeUserId: ticketFields.assigneeUserId.default(null),
  dueAt: ticketFields.dueAt.default(null),
  contactId: ticketFields.contactId.default(null),
  conversationId: ticketFields.conversationId.default(null),
  attributes: ticketFields.attributes.default([]),
});
export type CreateTicketRequest = z.input<typeof createTicketRequestSchema>;

/** `PATCH /tickets/:id`. Teknisi (`own`) tidak bisa mengubah penanggung jawab & tautan. */
export const updateTicketRequestSchema = z
  .object({
    title: ticketFields.title.optional(),
    description: ticketFields.description.optional(),
    priority: ticketFields.priority.optional(),
    assigneeUserId: ticketFields.assigneeUserId.optional(),
    dueAt: ticketFields.dueAt.optional(),
    contactId: ticketFields.contactId.optional(),
    conversationId: ticketFields.conversationId.optional(),
    attributes: ticketFields.attributes.optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    error: 'Tidak ada yang diubah.',
  });
export type UpdateTicketRequest = z.infer<typeof updateTicketRequestSchema>;

/**
 * `POST /tickets/:id/move` — pindah kolom (boleh kolom board LAIN) dan/atau urutan Kanban.
 * `afterTicketId` = letakkan tepat di bawah tiket itu (`null` = paling atas; kosong = paling bawah).
 */
export const moveTicketRequestSchema = z.object({
  columnId: z.uuid({ error: 'Kolom tidak valid.' }),
  afterTicketId: z.uuid({ error: 'Tiket acuan tidak valid.' }).nullable().optional(),
});
export type MoveTicketRequest = z.infer<typeof moveTicketRequestSchema>;

// ── Komentar & riwayat ──────────────────────────────────────────────────────

export const ticketCommentSchema = z.object({
  id: z.uuid(),
  body: z.string(),
  author: z
    .object({ kind: z.enum(['user', 'api_key']), id: z.uuid(), name: z.string() })
    .nullable(),
  createdAt: isoDateTimeSchema,
});
export type TicketComment = z.infer<typeof ticketCommentSchema>;
export const ticketCommentListResponseSchema = z.object({
  comments: z.array(ticketCommentSchema),
});
export const ticketCommentResponseSchema = z.object({ comment: ticketCommentSchema });
export const createTicketCommentRequestSchema = z.object({
  body: multilineField('Komentar', TICKET_LIMITS.commentMax),
});
export type CreateTicketCommentRequest = z.infer<typeof createTicketCommentRequestSchema>;
export const ticketCommentParamsSchema = z.object({ ticketId: z.string(), commentId: z.string() });

/**
 * Riwayat tiket (TANPA isi deskripsi/komentar/nilai atribut — hanya nama isian):
 * `created`, `updated` (`fields`), `moved` (kolom asal → tujuan, nama saat kejadian), `assigned`
 * (penanggung jawab lama → baru), `closed`, `reopened`, `commented`.
 */
export const TICKET_EVENT_KINDS = [
  'created',
  'updated',
  'moved',
  'assigned',
  'closed',
  'reopened',
  'commented',
] as const;
export type TicketEventKind = (typeof TICKET_EVENT_KINDS)[number];
export const TICKET_EDITABLE_FIELDS = [
  'title',
  'description',
  'priority',
  'dueAt',
  'contactId',
  'conversationId',
  'attributes',
] as const;
export type TicketEditableField = (typeof TICKET_EDITABLE_FIELDS)[number];

export const TICKET_EVENT_LABELS: Readonly<Record<TicketEventKind, string>> = {
  created: 'Membuat tiket',
  updated: 'Mengubah tiket',
  moved: 'Memindahkan tiket',
  assigned: 'Mengganti penanggung jawab',
  closed: 'Menyelesaikan tiket',
  reopened: 'Membuka lagi tiket',
  commented: 'Menambah komentar',
};

export const ticketEventSchema = z.object({
  id: z.uuid(),
  kind: z.enum(TICKET_EVENT_KINDS),
  actor: z.object({ kind: z.enum(['user', 'api_key']), id: z.uuid(), name: z.string() }).nullable(),
  fields: z.array(z.enum(TICKET_EDITABLE_FIELDS)).nullable(),
  fromColumn: z.string().nullable(),
  toColumn: z.string().nullable(),
  assignee: userRefSchema.nullable(),
  previousAssignee: userRefSchema.nullable(),
  createdAt: isoDateTimeSchema,
});
export type TicketEvent = z.infer<typeof ticketEventSchema>;
export const ticketEventListResponseSchema = z.object({ events: z.array(ticketEventSchema) });

// ── API publik (bot/n8n) ────────────────────────────────────────────────────

/**
 * `POST /api/v1/public/tickets` (`tickets:write`). `boardId` kosong = board aktif pertama.
 * Kolom: `columnId` atau `columnName` (tanpa beda huruf). Kontak: `contactId` atau `contactPhone`
 * (E.164, harus sudah ada).
 */
export const publicCreateTicketRequestSchema = createTicketRequestSchema
  .omit({ boardId: true })
  .extend({
    boardId: z.uuid({ error: 'Board tidak valid.' }).optional(),
    columnName: z.string().trim().min(1).max(TICKET_LIMITS.columnNameMax).optional(),
    contactPhone: z
      .string()
      .trim()
      .regex(/^\+[1-9][0-9]{6,14}$/, 'Nomor harus format E.164, mis. +6281234567890.')
      .optional(),
  });
export type PublicCreateTicketRequest = z.input<typeof publicCreateTicketRequestSchema>;

/** `PATCH /api/v1/public/tickets/:id` — isian tiket + pindah kolom (`columnId`/`columnName`). */
export const publicUpdateTicketRequestSchema = z
  .object({
    title: ticketFields.title.optional(),
    description: ticketFields.description.optional(),
    priority: ticketFields.priority.optional(),
    assigneeUserId: ticketFields.assigneeUserId.optional(),
    dueAt: ticketFields.dueAt.optional(),
    attributes: ticketFields.attributes.optional(),
    columnId: z.uuid({ error: 'Kolom tidak valid.' }).optional(),
    columnName: z.string().trim().min(1).max(TICKET_LIMITS.columnNameMax).optional(),
  })
  .refine((value) => Object.values(value).some((item) => item !== undefined), {
    error: 'Tidak ada yang diubah.',
  })
  .refine((value) => value.columnId === undefined || value.columnName === undefined, {
    error: 'Pilih salah satu: columnId atau columnName.',
  });
export type PublicUpdateTicketRequest = z.infer<typeof publicUpdateTicketRequestSchema>;
