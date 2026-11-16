import { describe, expect, it } from 'vitest';

import {
  createInboxEventPublisher,
  dedupeInboxEvents,
  inboxEventsChannel,
  parseInboxBusMessage,
  type InboxBusEventInput,
} from './inbox-events';
import { createLogCapture } from './testing';
import type { Redis } from './redis';

const ORG = '018f0000-0000-7000-8000-000000000001';
const CONV = '018f0000-0000-7000-8000-000000000002';
const MSG = '018f0000-0000-7000-8000-000000000003';

describe('parseInboxBusMessage', () => {
  it('menerima event sah, menolak bentuk lain tanpa melempar', () => {
    expect(
      parseInboxBusMessage(
        JSON.stringify({
          v: 1,
          type: 'message.created',
          organizationId: ORG,
          conversationId: CONV,
          messageId: MSG,
        }),
      ),
    ).toMatchObject({ type: 'message.created', messageId: MSG });
    for (const raw of [
      'bukan json',
      '{}',
      JSON.stringify({
        v: 2,
        type: 'conversation.updated',
        organizationId: ORG,
        conversationId: CONV,
      }),
      JSON.stringify({ v: 1, type: 'message.created', organizationId: ORG, conversationId: CONV }),
      JSON.stringify({
        v: 1,
        type: 'conversation.updated',
        organizationId: ORG,
        conversationId: CONV,
        text: 'isi',
      }),
      JSON.stringify({ v: 1, type: 'lain', organizationId: ORG, conversationId: CONV }),
      'x'.repeat(3_000),
    ]) {
      expect(parseInboxBusMessage(raw), raw.slice(0, 40)).toBeNull();
    }
  });
});

describe('penerbit', () => {
  it('menggabungkan event ganda dan menerbitkan ke channel berawalan', async () => {
    const published: Array<[string, string]> = [];
    const redis = {
      pipeline: () => {
        const batch = {
          publish: (channel: string, message: string) => {
            published.push([channel, message]);
            return batch;
          },
          exec: () => Promise.resolve([]),
        };
        return batch;
      },
    } as unknown as Redis;
    const publisher = createInboxEventPublisher(redis, {
      prefix: 'tes',
      logger: createLogCapture().logger,
    });
    const event: InboxBusEventInput = {
      type: 'conversation.updated',
      organizationId: ORG,
      conversationId: CONV,
    };
    await publisher.publish([event, event]);
    expect(published).toEqual([[inboxEventsChannel('tes'), JSON.stringify({ v: 1, ...event })]]);
    expect(dedupeInboxEvents([])).toEqual([]);
  });

  it('galat Redis tidak dilempar (usaha terbaik), hanya dicatat', async () => {
    const logs = createLogCapture();
    const redis = {
      pipeline: () => ({
        publish: () => undefined,
        exec: () => Promise.reject(new Error('Redis mati')),
      }),
    } as unknown as Redis;
    const publisher = createInboxEventPublisher(redis, { logger: logs.logger });
    await expect(
      publisher.publish([
        { type: 'conversation.updated', organizationId: ORG, conversationId: CONV },
      ]),
    ).resolves.toBeUndefined();
    expect(logs.text()).toContain('gagal diterbitkan');
  });
});
