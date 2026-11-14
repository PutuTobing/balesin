import { describe, expect, it } from 'vitest';

import { webhookUrlFor, webhookUrlWarning } from './channel-view';

const ID = '0190f000-0000-7000-8000-00000000abcd';

describe('URL webhook per channel', () => {
  it('menempel /webhooks/whatsapp/:channelId ke API_URL, path API_URL dipertahankan', () => {
    expect(webhookUrlFor('https://balesin.contoh.co.id', ID)).toBe(
      `https://balesin.contoh.co.id/webhooks/whatsapp/${ID}`,
    );
    expect(webhookUrlFor('https://balesin.contoh.co.id/api', ID)).toBe(
      `https://balesin.contoh.co.id/api/webhooks/whatsapp/${ID}`,
    );
    expect(webhookUrlFor('https://balesin.contoh.co.id/api/', ID)).toBe(
      `https://balesin.contoh.co.id/api/webhooks/whatsapp/${ID}`,
    );
  });

  it('peringatan bila bukan https publik', () => {
    expect(webhookUrlWarning('https://balesin.contoh.co.id/api')).toBeNull();
    expect(webhookUrlWarning('http://balesin.contoh.co.id')).toContain('https');
    expect(webhookUrlWarning('https://localhost:3000')).toContain('https');
  });
});
