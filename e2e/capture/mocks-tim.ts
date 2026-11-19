import type { Page } from '@playwright/test';
import { apiError, json } from './mocks';

/**
 * Jawaban API tiruan untuk layar manajemen pengguna, sesi aktif, audit log, dan banner keamanan
 * (Fase 1 butir 6). Bentuknya mengikuti skema `@balesin/shared` (`team.ts`, `audit.ts`).
 */
const API = '**/api/v1';
const HOUR = 3_600_000;
const ago = (hours: number) => new Date(Date.now() - hours * HOUR).toISOString();
const ahead = (hours: number) => new Date(Date.now() + hours * HOUR).toISOString();

type Role = 'owner' | 'admin' | 'supervisor' | 'cs' | 'teknisi';
type Invitable = Exclude<Role, 'owner'>;

const ALL_ASSIGNABLE: Invitable[] = ['admin', 'supervisor', 'cs', 'teknisi'];

/** ID tetap supaya alamat detail anggota bisa dipakai di daftar layar. */
export const PHOTO_USER_IDS = {
  owner: '0b0e2d8c-6d3f-4b8a-9d55-5e2f8a1c0001',
  admin: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b02',
  supervisor: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b03',
  cs: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b04',
  teknisi: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b05',
  disabled: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b06',
} as const;

export interface PhotoUser {
  id: string;
  name: string;
  email: string;
  role: Role;
  status: 'active' | 'locked' | 'disabled';
  disabledAt: string | null;
  lockedUntil: string | null;
  emailVerified: boolean;
  lastLoginAt: string | null;
  createdAt: string;
  twoFactor: {
    enabled: boolean;
    required: boolean;
    enabledAt: string | null;
    enrollmentDueAt: string | null;
    enrollmentExpired: boolean;
  };
  activeSessions: number;
  isSelf: boolean;
  canManage: boolean;
  assignableRoles: Invitable[];
}

export function photoUser(
  overrides: Partial<PhotoUser> & Pick<PhotoUser, 'id' | 'name' | 'email' | 'role'>,
): PhotoUser {
  const required = ['owner', 'admin', 'supervisor'].includes(overrides.role);
  return {
    status: 'active',
    disabledAt: null,
    lockedUntil: null,
    emailVerified: true,
    lastLoginAt: ago(2),
    createdAt: ago(24 * 20),
    twoFactor: {
      enabled: required,
      required,
      enabledAt: required ? ago(24 * 19) : null,
      enrollmentDueAt: null,
      enrollmentExpired: false,
    },
    activeSessions: 1,
    isSelf: false,
    canManage: true,
    assignableRoles: ALL_ASSIGNABLE,
    ...overrides,
  };
}

/** Tim contoh dilihat Owner: semua keadaan yang mungkin tampil di daftar. */
export const PHOTO_TEAM: PhotoUser[] = [
  photoUser({
    id: PHOTO_USER_IDS.owner,
    name: 'Rina Kartika',
    email: 'rina@majujaya.co.id',
    role: 'owner',
    isSelf: true,
    canManage: false,
    assignableRoles: [],
    activeSessions: 2,
    lastLoginAt: ago(0.2),
  }),
  photoUser({
    id: PHOTO_USER_IDS.admin,
    name: 'Agus Pratama',
    email: 'agus.pratama@majujaya.co.id',
    role: 'admin',
    lastLoginAt: ago(26),
  }),
  photoUser({
    id: PHOTO_USER_IDS.supervisor,
    name: 'Sari Wulandari',
    email: 'sari.wulandari@majujaya.co.id',
    role: 'supervisor',
    lastLoginAt: null,
    activeSessions: 0,
    twoFactor: {
      enabled: false,
      required: true,
      enabledAt: null,
      enrollmentDueAt: ago(5),
      enrollmentExpired: true,
    },
  }),
  photoUser({
    id: PHOTO_USER_IDS.cs,
    name: 'Citra Maharani',
    email: 'citra@majujaya.co.id',
    role: 'cs',
    emailVerified: false,
    activeSessions: 2,
  }),
  photoUser({
    id: PHOTO_USER_IDS.teknisi,
    name: 'Tono Saputra',
    email: 'tono@majujaya.co.id',
    role: 'teknisi',
    status: 'locked',
    lockedUntil: ahead(0.25),
    twoFactor: {
      enabled: true,
      required: false,
      enabledAt: ago(24 * 6),
      enrollmentDueAt: null,
      enrollmentExpired: false,
    },
  }),
  photoUser({
    id: PHOTO_USER_IDS.disabled,
    name: 'Dewi Lestari',
    email: 'dewi.lestari@majujaya.co.id',
    role: 'cs',
    status: 'disabled',
    disabledAt: ago(24 * 3),
    lastLoginAt: ago(24 * 4),
    activeSessions: 0,
  }),
];

/** Sudut pandang Admin: Owner dan Admin lain hanya dilihat. */
export function teamAsAdmin(): PhotoUser[] {
  return PHOTO_TEAM.map((user) => {
    if (user.role === 'owner')
      return { ...user, isSelf: false, canManage: false, assignableRoles: [] };
    if (user.role === 'admin')
      return { ...user, isSelf: true, canManage: false, assignableRoles: [] };
    return { ...user, assignableRoles: ['supervisor', 'cs', 'teknisi'] };
  });
}

export async function teamUsers(page: Page, users: PhotoUser[] = PHOTO_TEAM): Promise<void> {
  await page.route(`${API}/users`, (route) =>
    json(route, { users, manageableRoles: ['owner', 'admin', 'supervisor', 'cs', 'teknisi'] }),
  );
}

export function photoSessions(device = 'Chrome di Windows') {
  return [
    {
      id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c01',
      device,
      ipAddress: '203.0.113.*',
      createdAt: ago(30),
      lastSeenAt: ago(0.05),
      current: false,
      limited: false,
      confirmationRequired: false,
    },
    {
      id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c02',
      device: 'Chrome di Android',
      ipAddress: '2001:db8:85a3:*',
      createdAt: ago(24 * 3),
      lastSeenAt: ago(5),
      current: false,
      limited: false,
      confirmationRequired: false,
    },
  ];
}

/** Detail anggota + sesinya + riwayatnya (audit `?userId=`). */
export async function teamUserDetail(
  page: Page,
  user: PhotoUser,
  options: { sessions?: unknown[]; entries?: unknown[] } = {},
): Promise<void> {
  await page.route(`${API}/users/${user.id}`, (route) => json(route, { user }));
  await page.route(`${API}/users/${user.id}/sessions`, (route) =>
    json(route, { sessions: options.sessions ?? photoSessions() }),
  );
  // Riwayat aktivitas: hanya entri oleh atau terhadap anggota ini (seperti saringan `userId`).
  const related = photoAuditEntries().filter(
    (entry) => entry.actor?.id === user.id || entry.target.id === user.id,
  );
  await auditList(page, options.entries ?? related, null);
}

/** Sesi aktif milik sendiri (Keamanan akun). */
export async function ownSessions(page: Page, sessions: unknown[]): Promise<void> {
  await page.route(`${API}/auth/sessions`, (route) => json(route, { sessions }));
}

export function ownPhotoSessions() {
  return [
    {
      id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c11',
      device: 'Chrome di Windows',
      ipAddress: '203.0.113.*',
      createdAt: ago(5),
      lastSeenAt: ago(0),
      current: true,
      limited: false,
      confirmationRequired: false,
    },
    {
      id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c12',
      device: 'Safari di iOS',
      ipAddress: '198.51.100.*',
      createdAt: ago(24 * 2),
      lastSeenAt: ago(3),
      current: false,
      limited: false,
      confirmationRequired: false,
    },
    {
      id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c13',
      device: 'Firefox di Linux',
      ipAddress: null,
      createdAt: ago(1),
      lastSeenAt: ago(1),
      current: false,
      limited: false,
      confirmationRequired: true,
    },
  ];
}

const person = (id: string, name: string, email: string, role: Role) => ({ id, name, email, role });
const RINA = person(PHOTO_USER_IDS.owner, 'Rina Kartika', 'rina@majujaya.co.id', 'owner');
const AGUS = person(PHOTO_USER_IDS.admin, 'Agus Pratama', 'agus.pratama@majujaya.co.id', 'admin');

/** Entri audit contoh: aksi tim, keamanan, sistem, aksi belum dikenal. */
export function photoAuditEntries() {
  return [
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c01',
      createdAt: ago(0.3),
      action: 'user.role_changed',
      actor: RINA,
      target: { type: 'user', id: PHOTO_USER_IDS.cs, name: 'Citra Maharani' },
      metadata: { from: 'cs', to: 'supervisor', revokedSessions: 2, revokedInvitations: 0 },
      ipAddress: '203.0.113.24',
      device: 'Chrome di Windows',
    },
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c02',
      createdAt: ago(2),
      action: 'settings.email.updated',
      actor: AGUS,
      target: { type: 'email_settings', id: null, name: null },
      metadata: { previousHost: 'mail.majujaya.co.id', host: 'smtp.gmail.com', ownersNotified: 1 },
      ipAddress: '198.51.100.7',
      device: 'Edge di Windows',
    },
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c03',
      createdAt: ago(5),
      action: 'auth.account.locked',
      actor: null,
      target: { type: 'user', id: PHOTO_USER_IDS.teknisi, name: 'Tono Saputra' },
      metadata: { scope: 'account', lockedUntil: ahead(0.25) },
      ipAddress: '192.0.2.81',
      device: 'Chrome di Android',
    },
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c04',
      createdAt: ago(26),
      action: 'auth.login.success',
      actor: AGUS,
      target: { type: 'session', id: '5a4b3c2d-1e0f-4a9b-8c7d-6e5f4a3b2c02', name: null },
      metadata: {},
      ipAddress: '198.51.100.7',
      device: 'Edge di Windows',
    },
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c05',
      createdAt: ago(30),
      action: 'auth.access.denied',
      actor: person(PHOTO_USER_IDS.cs, 'Citra Maharani', 'citra@majujaya.co.id', 'cs'),
      target: { type: 'permission', id: 'team.invite', name: null },
      metadata: { permission: 'team.invite', method: 'POST' },
      ipAddress: '203.0.113.31',
      device: 'Chrome di Android',
    },
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c06',
      createdAt: ago(48),
      action: 'user.invitation.created',
      actor: RINA,
      target: { type: 'invitation', id: '7d1c4f8e-2b3a-4c5d-8e9f-0a1b2c3d4e01', name: null },
      metadata: { role: 'cs', email: 'citra@majujaya.co.id' },
      ipAddress: '203.0.113.24',
      device: 'Chrome di Windows',
    },
  ];
}

/** `GET /audit-logs` tiruan (hanya path itu, bukan ekspor/ringkasan). */
export async function auditList(
  page: Page,
  entries: unknown[],
  nextCursor: string | null = null,
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/v1/audit-logs',
    (route) => json(route, { entries, nextCursor }),
  );
}

export async function auditListError(page: Page, status: number): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/v1/audit-logs',
    (route) =>
      status === 429
        ? apiError(route, 429, 'RATE_LIMITED', 'Terlalu banyak permintaan dalam waktu singkat.', {
            'retry-after': '60',
          })
        : apiError(
            route,
            503,
            'SERVICE_UNAVAILABLE',
            'Database sedang tidak bisa dihubungi. Coba lagi sebentar lagi.',
          ),
  );
}

/** `GET /audit-logs/export` tiruan. */
export async function auditExport(
  page: Page,
  outcome: 'ok' | 'truncated' | 'limited',
): Promise<void> {
  await page.route(
    (url) => url.pathname === '/api/v1/audit-logs/export',
    (route) => {
      if (outcome === 'limited') {
        return apiError(
          route,
          429,
          'RATE_LIMITED',
          'Batas ekspor audit log (10 kali per jam) sudah tercapai.',
          { 'retry-after': '2520' },
        );
      }
      return route.fulfill({
        status: 200,
        contentType: 'text/csv; charset=utf-8',
        headers: {
          'content-disposition': 'attachment; filename="audit-log-20261114.csv"',
          'x-export-rows': outcome === 'truncated' ? '10000' : '128',
          'x-export-truncated': outcome === 'truncated' ? '1' : '0',
        },
        body: '﻿"Waktu (UTC)","Aksi"\r\n',
      });
    },
  );
}

const COUNTS = {
  email_sender_changed: 0,
  two_factor_reset: 0,
  two_factor_enrollment_reopened: 0,
  password_reset_without_two_factor: 0,
  account_locked: 0,
  role_changed: 0,
  user_disabled: 0,
  channel_changed: 0,
  business_profile_changed: 0,
  member_joined: 0,
  password_reset_burst: 0,
  webhook_signature_failed: 0,
  sending_paused: 0,
  sending_limit_reached: 0,
  sending_limits_changed: 0,
  inbox_bulk_action: 0,
  quick_reply_risky: 0,
  api_key_changed: 0,
  webhook_changed: 0,
  webhook_disabled: 0,
  bot_enabled: 0,
  auto_message_risky: 0,
  owner_password_reset_server: 0,
  branding_changed: 0,
};

/** Ringkasan keamanan tiruan dengan kejadian `warning` (banner tampil untuk Owner/Admin). */
export async function securitySummary(page: Page, warnings = 2): Promise<void> {
  const events = [
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c02',
      kind: 'email_sender_changed',
      severity: 'warning',
      occurredAt: ago(2),
      actor: AGUS,
      subject: null,
      details: { previousHost: 'mail.majujaya.co.id', host: 'smtp.gmail.com' },
    },
    {
      id: '9e8d7c6b-5a4f-4e3d-8c2b-1a0f9e8d7c03',
      kind: 'account_locked',
      severity: 'warning',
      occurredAt: ago(5),
      actor: null,
      subject: { id: PHOTO_USER_IDS.teknisi, name: 'Tono Saputra', role: 'teknisi' },
      details: { scope: 'account' },
    },
  ].slice(0, warnings);
  await page.route(`${API}/audit-logs/security-summary`, (route) =>
    json(route, {
      since: ago(24 * 7),
      events,
      counts: { ...COUNTS, email_sender_changed: 1, account_locked: warnings > 1 ? 1 : 0 },
      latestWarningAt: events[0]?.occurredAt ?? null,
    }),
  );
}

/** Banner keamanan tidak tampil (ringkasan tanpa kejadian). Dipakai layar yang bukan soal banner. */
export async function quietSecurity(page: Page): Promise<void> {
  await page.route(`${API}/audit-logs/security-summary`, (route) =>
    json(route, { since: ago(24 * 7), events: [], counts: COUNTS, latestWarningAt: null }),
  );
}
