import { AppError } from '@balesin/core';
import {
  attributeDefinitions,
  isPgError,
  PG_ERROR_CODES,
  ticketBoards,
  type AttributeDefinitionRow,
  type Database,
  type DbExecutor,
} from '@balesin/db';
import {
  ATTRIBUTE_DEFINITION_LIMITS,
  type AttributeDefinition,
  type AttributeRule,
  type AttributeValueIssue,
  type CreateAttributeDefinitionRequest,
  type Permission,
  type UpdateAttributeDefinitionRequest,
} from '@balesin/shared';
import { and, asc, eq, isNull, sql } from 'drizzle-orm';

import type { ClientInfo } from '../../http/client-info';
import { AUDIT_ACTIONS, recordAudit } from '../audit/audit';
import { assertActorStillAuthorized } from '../auth/actor-check';
import type { AuthContext } from '../auth/session.service';

/**
 * Definisi atribut kustom (Fase 5) — KONTAK per organisasi (`settings.workspace.manage`) dan TIKET
 * per board (`tickets.configure`). Nilai atribut tetap tersimpan sebagai `{ key, value }` di baris
 * kontak/tiket; definisi menambah label, jenis, wajib, dan pilihan (`validateAttributeValues`).
 * Menghapus definisi TIDAK menghapus nilai yang tersimpan (menjadi atribut bebas).
 */

export type AttributeScope = { entity: 'contact' } | { entity: 'ticket'; boardId: string };

export const ATTRIBUTE_NOT_FOUND = 'Atribut tidak ditemukan.';

export function toAttributeDefinition(row: AttributeDefinitionRow): AttributeDefinition {
  return {
    id: row.id,
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: Array.isArray(row.options) ? row.options : [],
    position: row.position,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

function scopeWhere(organizationId: string, scope: AttributeScope) {
  return and(
    eq(attributeDefinitions.organizationId, organizationId),
    eq(attributeDefinitions.entity, scope.entity),
    scope.entity === 'ticket'
      ? eq(attributeDefinitions.boardId, scope.boardId)
      : isNull(attributeDefinitions.boardId),
  );
}

export async function listAttributeDefinitions(
  db: DbExecutor,
  organizationId: string,
  scope: AttributeScope,
): Promise<AttributeDefinitionRow[]> {
  return db
    .select()
    .from(attributeDefinitions)
    .where(scopeWhere(organizationId, scope))
    .orderBy(asc(attributeDefinitions.position), asc(attributeDefinitions.createdAt));
}

/** Aturan validasi nilai untuk satu cakupan. */
export async function attributeRules(
  db: DbExecutor,
  organizationId: string,
  scope: AttributeScope,
): Promise<AttributeRule[]> {
  const rows = await listAttributeDefinitions(db, organizationId, scope);
  return rows.map((row) => ({
    key: row.key,
    label: row.label,
    type: row.type,
    required: row.required,
    options: Array.isArray(row.options) ? row.options : [],
  }));
}

/** 400 dengan rincian per atribut (`attributes.<kunci>`). */
export function attributeValidationError(issues: readonly AttributeValueIssue[]): AppError {
  return new AppError('VALIDATION_ERROR', {
    message: issues[0]?.message ?? 'Nilai atribut tidak valid.',
    details: issues.map((issue) => ({
      location: 'body' as const,
      field: `attributes.${issue.key}`,
      message: issue.message,
    })),
  });
}

function configurePermission(scope: AttributeScope): Permission {
  return scope.entity === 'contact' ? 'settings.workspace.manage' : 'tickets.configure';
}

export interface AttributesService {
  list(organizationId: string, scope: AttributeScope): Promise<AttributeDefinition[]>;
  create(
    auth: AuthContext,
    scope: AttributeScope,
    input: CreateAttributeDefinitionRequest,
    client: ClientInfo,
  ): Promise<AttributeDefinition>;
  update(
    auth: AuthContext,
    scope: AttributeScope,
    attributeId: string,
    input: UpdateAttributeDefinitionRequest,
    client: ClientInfo,
  ): Promise<AttributeDefinition>;
  remove(
    auth: AuthContext,
    scope: AttributeScope,
    attributeId: string,
    client: ClientInfo,
  ): Promise<void>;
}

export function createAttributesService(deps: { db: Database }): AttributesService {
  const { db } = deps;

  async function assertBoard(tx: DbExecutor, organizationId: string, scope: AttributeScope) {
    if (scope.entity !== 'ticket') return;
    const [board] = await tx
      .select({ id: ticketBoards.id })
      .from(ticketBoards)
      .where(
        and(eq(ticketBoards.organizationId, organizationId), eq(ticketBoards.id, scope.boardId)),
      )
      .for('update');
    if (!board) throw new AppError('NOT_FOUND', { message: 'Board tidak ditemukan.' });
  }

  async function audit(
    tx: DbExecutor,
    auth: AuthContext,
    scope: AttributeScope,
    operation: 'created' | 'updated' | 'deleted',
    row: { id: string; key: string },
    client: ClientInfo,
    changedFields?: string[],
  ) {
    if (scope.entity === 'contact') {
      await recordAudit(tx, {
        organizationId: auth.organizationId,
        actorUserId: auth.user.id,
        action:
          operation === 'created'
            ? AUDIT_ACTIONS.attributeDefinitionCreated
            : operation === 'updated'
              ? AUDIT_ACTIONS.attributeDefinitionUpdated
              : AUDIT_ACTIONS.attributeDefinitionDeleted,
        targetType: 'attribute_definition',
        targetId: row.id,
        metadata: { entity: 'contact', key: row.key, ...(changedFields ? { changedFields } : {}) },
        client,
      });
      return;
    }
    await recordAudit(tx, {
      organizationId: auth.organizationId,
      actorUserId: auth.user.id,
      action: AUDIT_ACTIONS.ticketBoardConfigured,
      targetType: 'ticket_board',
      targetId: scope.boardId,
      metadata: {
        operation: `attribute_${operation}`,
        key: row.key,
        ...(changedFields ? { changedFields } : {}),
      },
      client,
    });
  }

  const duplicateKey = () =>
    new AppError('CONFLICT', {
      message: 'Nama atribut sudah dipakai.',
      details: [{ location: 'body', field: 'key', message: 'Nama atribut sudah dipakai.' }],
    });

  return {
    async list(organizationId, scope) {
      return (await listAttributeDefinitions(db, organizationId, scope)).map(toAttributeDefinition);
    },

    async create(auth, scope, input, client) {
      try {
        return await db.transaction(async (tx) => {
          await assertActorStillAuthorized(tx, auth, configurePermission(scope));
          await assertBoard(tx, auth.organizationId, scope);
          const [count] = await tx
            .select({ total: sql<number>`count(*)::int` })
            .from(attributeDefinitions)
            .where(scopeWhere(auth.organizationId, scope));
          const max =
            scope.entity === 'contact'
              ? ATTRIBUTE_DEFINITION_LIMITS.contactPerOrganization
              : ATTRIBUTE_DEFINITION_LIMITS.ticketPerBoard;
          if (Number(count?.total ?? 0) >= max) {
            throw new AppError('CONFLICT', {
              message: `Sudah ada ${String(max)} atribut (batas).`,
            });
          }
          const [row] = await tx
            .insert(attributeDefinitions)
            .values({
              organizationId: auth.organizationId,
              entity: scope.entity,
              boardId: scope.entity === 'ticket' ? scope.boardId : null,
              key: input.key,
              label: input.label,
              type: input.type,
              required: input.required ?? false,
              options: input.type === 'select' ? (input.options ?? []) : [],
              position: Number(count?.total ?? 0),
            })
            .returning();
          if (!row) throw new Error('Atribut tidak tersimpan');
          await audit(tx, auth, scope, 'created', row, client);
          return toAttributeDefinition(row);
        });
      } catch (error) {
        if (isPgError(error, PG_ERROR_CODES.uniqueViolation)) throw duplicateKey();
        throw error;
      }
    },

    async update(auth, scope, attributeId, input, client) {
      return db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, configurePermission(scope));
        const [current] = await tx
          .select()
          .from(attributeDefinitions)
          .where(
            and(scopeWhere(auth.organizationId, scope), eq(attributeDefinitions.id, attributeId)),
          )
          .for('update');
        if (!current) throw new AppError('NOT_FOUND', { message: ATTRIBUTE_NOT_FOUND });
        const type = input.type ?? current.type;
        let options = input.options ?? (Array.isArray(current.options) ? current.options : []);
        if (type !== 'select') options = [];
        if (type === 'select' && options.length === 0) {
          throw new AppError('VALIDATION_ERROR', {
            message: 'Atribut pilihan butuh minimal satu pilihan.',
            details: [
              {
                location: 'body',
                field: 'options',
                message: 'Atribut pilihan butuh minimal satu pilihan.',
              },
            ],
          });
        }
        const patch = {
          label: input.label ?? current.label,
          type,
          required: input.required ?? current.required,
          options,
          position: input.position ?? current.position,
        };
        const changedFields = (Object.keys(patch) as (keyof typeof patch)[]).filter(
          (field) => JSON.stringify(patch[field]) !== JSON.stringify(current[field]),
        );
        if (changedFields.length === 0) return toAttributeDefinition(current);
        const [row] = await tx
          .update(attributeDefinitions)
          .set(patch)
          .where(
            and(
              eq(attributeDefinitions.organizationId, auth.organizationId),
              eq(attributeDefinitions.id, attributeId),
            ),
          )
          .returning();
        if (!row) throw new AppError('NOT_FOUND', { message: ATTRIBUTE_NOT_FOUND });
        await audit(tx, auth, scope, 'updated', row, client, changedFields);
        return toAttributeDefinition(row);
      });
    },

    async remove(auth, scope, attributeId, client) {
      await db.transaction(async (tx) => {
        await assertActorStillAuthorized(tx, auth, configurePermission(scope));
        const [row] = await tx
          .delete(attributeDefinitions)
          .where(
            and(scopeWhere(auth.organizationId, scope), eq(attributeDefinitions.id, attributeId)),
          )
          .returning();
        if (!row) throw new AppError('NOT_FOUND', { message: ATTRIBUTE_NOT_FOUND });
        await audit(tx, auth, scope, 'deleted', row, client);
      });
    },
  };
}
