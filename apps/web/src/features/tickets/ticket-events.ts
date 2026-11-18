import { TICKET_EVENT_LABELS, type TicketEvent } from '@balesin/shared';
import { t } from '../../i18n/id';

const k = t.tickets;

/** Satu baris riwayat tiket: "Rina · memindahkan tiket dari Baru ke Dikerjakan". */
export function describeEvent(event: TicketEvent): string {
  const actor = event.actor
    ? event.actor.kind === 'api_key'
      ? k.commentByKey(event.actor.name)
      : event.actor.name
    : k.systemActor;
  let detail = '';
  if (event.kind === 'moved' && event.fromColumn && event.toColumn) {
    detail = ` ${k.eventMoved(event.fromColumn, event.toColumn)}`;
  } else if (event.kind === 'assigned') {
    detail = ` ${k.eventAssigned(event.previousAssignee?.name ?? null, event.assignee?.name ?? null)}`;
  } else if (event.kind === 'updated' && event.fields && event.fields.length > 0) {
    detail = ` ${k.eventFields(event.fields.map((field) => k.fieldLabels[field] ?? field).join(', '))}`;
  }
  return `${actor} · ${TICKET_EVENT_LABELS[event.kind].toLocaleLowerCase('id-ID')}${detail}`;
}
