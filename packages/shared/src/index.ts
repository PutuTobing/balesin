/**
 * @balesin/shared — skema Zod, tipe, dan konstanta yang dipakai api, worker, dan web.
 * Jangan impor modul Node (fs, crypto, dsb.) di sini: paket ini ikut ter-bundle ke browser.
 */
export const APP_NAME = 'Balesin';

export * from './api-keys';
export * from './api-routes';
export * from './audit';
export * from './auth';
export * from './bot';
export * from './branding';
export * from './broadcasts';
export * from './channel-access';
export * from './channel-capabilities';
export * from './channel-connections';
export * from './channels';
export * from './crm';
export * from './departments';
export * from './email';
export * from './email-message-templates';
export * from './email-send';
export * from './email-settings';
export * from './email-template-presets';
export * from './email-templates';
export * from './email-verification';
export * from './errors';
export * from './fields';
export * from './health';
export * from './inbox';
export * from './interactive';
export * from './invitations';
export * from './outbound';
export * from './outgoing-webhooks';
export * from './links';
export * from './mobichat';
export * from './notifications';
export * from './password';
export * from './password-reset';
export * from './permissions';
export * from './public-api';
export * from './quick-replies';
export * from './reports';
export * from './roles';
export * from './sending-limits';
export * from './setup';
export * from './tags';
export * from './team';
export * from './template-presets';
export * from './templates';
export * from './tickets';
export * from './two-factor';
export * from './webhooks';
export * from './workspace';
export * from './zod-locale';
