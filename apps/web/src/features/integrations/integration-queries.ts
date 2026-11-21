/** Kunci cache halaman integrasi (API key, webhook keluar). */
export const integrationKeys = {
  apiKeys: ['integrations', 'api-keys'] as const,
  apiSettings: ['integrations', 'api-settings'] as const,
  webhooks: ['integrations', 'webhooks'] as const,
  deliveries: (webhookId: string) => ['integrations', 'webhooks', webhookId, 'deliveries'] as const,
  privateNetwork: ['integrations', 'private-network'] as const,
};
