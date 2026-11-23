import type {
  MailDraft,
  MailIdentity,
  MailOutboxItem,
  MailSignature,
  MailAccount,
  MailFolder,
  MailMessageDetail,
  MailMessageSummary,
  MailSidebarResponse,
  RedactedMailAccount,
  TestMailAccountResponse,
} from '@balesin/shared';

/** Data tiruan modul Email (bentuk skema `packages/shared/src/mail.ts`). */

export const MAIL_IDS = {
  cs: '7a1b2c3d-0000-4000-8000-000000000001',
  billing: '7a1b2c3d-0000-4000-8000-000000000002',
  personal: '7a1b2c3d-0000-4000-8000-000000000003',
  other: '7a1b2c3d-0000-4000-8000-000000000004',
  csInbox: '7a1b2c3d-0000-4000-8000-0000000000a1',
  csSent: '7a1b2c3d-0000-4000-8000-0000000000a2',
  csVendor: '7a1b2c3d-0000-4000-8000-0000000000a3',
  billingInbox: '7a1b2c3d-0000-4000-8000-0000000000b1',
  message1: '7a1b2c3d-0000-4000-8000-0000000000e1',
  message2: '7a1b2c3d-0000-4000-8000-0000000000e2',
  message3: '7a1b2c3d-0000-4000-8000-0000000000e3',
  attachmentPdf: '7a1b2c3d-0000-4000-8000-0000000000c1',
  attachmentZip: '7a1b2c3d-0000-4000-8000-0000000000c2',
  attachmentExe: '7a1b2c3d-0000-4000-8000-0000000000c3',
} as const;

/** Ringkasan email di daftar (kontrak §7). */
export function fakeMailSummary(overrides: Partial<MailMessageSummary> = {}): MailMessageSummary {
  return {
    id: MAIL_IDS.message1,
    accountId: MAIL_IDS.cs,
    folderId: MAIL_IDS.csInbox,
    folderRole: 'inbox',
    account: { id: MAIL_IDS.cs, displayName: 'CS Maju Jaya', color: 'tagBlue' },
    from: { address: 'noc@nusaraya.example', name: 'NOC Nusaraya' },
    to: [{ address: 'cs@majujaya.co.id', name: null }],
    toCount: 1,
    ccCount: 0,
    subject: 'Jadwal pemeliharaan 26 November',
    snippet: 'Yth. tim, kami akan melakukan pemeliharaan terjadwal.',
    receivedAt: new Date(Date.now() - 30 * 60_000).toISOString(),
    sentAt: null,
    isRead: false,
    isStarred: false,
    isAnswered: false,
    hasAttachments: true,
    sizeBytes: 48_211,
    deliveredTo: 'cs@majujaya.co.id',
    deliveredToAlias: false,
    senderVerification: 'pass',
    warnings: [],
    pending: false,
    ...overrides,
  };
}

/** Detail email (kontrak §8) dengan isi HTML siap + satu PDF, satu ZIP, satu berkas diblokir. */
export function fakeMailDetail(
  overrides: Partial<MailMessageDetail> = {},
  summary: Partial<MailMessageSummary> = {},
): MailMessageDetail {
  return {
    ...fakeMailSummary(summary),
    cc: [{ address: 'tono@majujaya.co.id', name: 'Tono' }],
    bcc: null,
    replyTo: [],
    messageIdHeader: '<abc@nusaraya.example>',
    myLevel: 'manage',
    receivedVia: {
      accountId: MAIL_IDS.cs,
      displayName: 'CS Maju Jaya',
      address: 'cs@majujaya.co.id',
    },
    verification: {
      result: 'pass',
      label: 'Terverifikasi',
      spf: 'pass',
      dkim: 'pass',
      dmarc: 'pass',
      authServId: 'mail.majujaya.co.id',
    },
    warningDetails: [],
    body: {
      state: 'ready',
      hasHtml: true,
      text: 'Yth. tim, kami akan melakukan pemeliharaan terjadwal.',
      remoteImages: { count: 2, senderAllowed: false, autoBlocked: false },
    },
    attachments: [
      {
        id: MAIL_IDS.attachmentPdf,
        filename: 'Jadwal-Pemeliharaan.pdf',
        contentType: 'application/pdf',
        sizeBytes: 253_952,
        isInline: false,
        risk: 'ok',
        riskMessage: null,
        previewable: false,
        cached: true,
      },
      {
        id: MAIL_IDS.attachmentZip,
        filename: 'Foto-ODP.zip',
        contentType: 'application/zip',
        sizeBytes: 4_404_019,
        isInline: false,
        risk: 'warn',
        riskMessage: null,
        previewable: false,
        cached: false,
      },
      {
        id: MAIL_IDS.attachmentExe,
        filename: 'faktur.exe',
        contentType: 'application/octet-stream',
        sizeBytes: 120_000,
        isInline: false,
        risk: 'blocked',
        riskMessage:
          'Lampiran ini diblokir karena berisiko (program, makro, atau halaman web). Minta pengirim mengirim dalam bentuk PDF.',
        previewable: false,
        cached: false,
      },
    ],
    ...overrides,
  };
}

export function fakeMailAccount(overrides: Partial<MailAccount> = {}): MailAccount {
  return {
    id: MAIL_IDS.cs,
    kind: 'shared',
    provider: 'cpanel',
    displayName: 'CS Maju Jaya',
    emailAddress: 'cs@majujaya.co.id',
    fromName: 'Layanan Pelanggan Maju Jaya',
    color: 'tagBlue',
    avatarUrl: null,
    owner: null,
    myLevel: 'manage',
    redacted: false,
    imap: {
      host: 'mail.majujaya.co.id',
      port: 993,
      security: 'ssl',
      username: 'cs@majujaya.co.id',
      password: '••••a1b2',
    },
    smtp: {
      host: 'mail.majujaya.co.id',
      port: 465,
      security: 'ssl',
      sameCredentials: true,
      username: null,
      password: null,
    },
    trustedAuthServIds: null,
    syncWindowDays: 90,
    periodicSyncMinutes: 5,
    sentCopyMode: 'auto',
    warnExternalRecipients: false,
    warnings: [],
    sync: {
      state: 'ready',
      lastSyncedAt: new Date(Date.now() - 60_000).toISOString(),
      lastErrorCode: null,
      lastErrorMessage: null,
      lastErrorAt: null,
      nextAttemptAt: null,
      idleActive: true,
      initialProgress: null,
      lastTest: {
        testedAt: '2026-11-23T01:00:00.000Z',
        incomingOk: true,
        outgoingOk: true,
      },
    },
    stats: {
      messageCount: 3482,
      unreadCount: 14,
      quota: { usedBytes: 812 * 1024 * 1024, limitBytes: 2 * 1024 * 1024 * 1024 },
    },
    createdAt: '2026-11-20T01:00:00.000Z',
    updatedAt: '2026-11-23T01:00:00.000Z',
    ...overrides,
  };
}

export function fakeRedactedAccount(
  overrides: Partial<RedactedMailAccount> = {},
): RedactedMailAccount {
  return {
    id: MAIL_IDS.other,
    kind: 'personal',
    provider: 'imap',
    displayName: 'Kantor Dimas',
    emailAddress: 'dimas@surel.id',
    color: 'tagPurple',
    avatarUrl: null,
    owner: { id: '3f6a2b1c-9d8e-4f7a-8b6c-5d4e3f2a1b04', name: 'Dimas Saputra', active: true },
    redacted: true,
    sync: { state: 'ready', lastSyncedAt: '2026-11-23T01:00:00.000Z', lastErrorCode: null },
    ...overrides,
  };
}

export function fakeMailFolder(overrides: Partial<MailFolder> = {}): MailFolder {
  return {
    id: MAIL_IDS.csInbox,
    accountId: MAIL_IDS.cs,
    path: 'INBOX',
    name: 'Kotak masuk',
    role: 'inbox',
    parentId: null,
    depth: 0,
    selectable: true,
    unreadCount: 6,
    totalCount: 1200,
    syncEnabled: true,
    hasOlderOnServer: false,
    ...overrides,
  };
}

/** Kolom kiri untuk akun-akun tertentu (Kotak masuk + Terkirim + satu folder sendiri untuk CS). */
export function fakeSidebar(accounts: readonly MailAccount[]): MailSidebarResponse {
  return {
    unified: { unreadCount: 14 },
    unread: { count: 16 },
    starred: { count: 3 },
    accounts: accounts.map((account) => ({
      account: {
        id: account.id,
        displayName: account.displayName,
        emailAddress: account.emailAddress,
        color: account.color,
        avatarUrl: account.avatarUrl,
        myLevel: account.myLevel ?? 'read',
        sync: { state: account.sync.state },
      },
      folders:
        account.id === MAIL_IDS.cs
          ? [
              fakeMailFolder(),
              fakeMailFolder({
                id: MAIL_IDS.csSent,
                path: 'Sent',
                name: 'Terkirim',
                role: 'sent',
                unreadCount: 0,
              }),
              fakeMailFolder({
                id: MAIL_IDS.csVendor,
                path: 'INBOX.Vendor',
                name: 'Vendor',
                role: null,
                unreadCount: 2,
              }),
            ]
          : [
              fakeMailFolder({
                id: `${account.id.slice(0, -2)}f1`,
                accountId: account.id,
                unreadCount: 8,
              }),
            ],
    })),
  };
}

export function fakeTestResult(
  outgoingOk = true,
  overrides: Partial<TestMailAccountResponse> = {},
): TestMailAccountResponse {
  return {
    testedAt: '2026-11-23T01:00:00.000Z',
    incoming: {
      ok: true,
      code: 'ok',
      message: 'Masuk ke IMAP berhasil.',
      durationMs: 1100,
      details: {
        folderCount: 14,
        inboxTotal: 3482,
        specialFolders: ['sent', 'drafts', 'junk', 'trash', 'archive'],
        idle: true,
        quota: null,
        estimatedInitialSync: 640,
      },
    },
    outgoing: outgoingOk
      ? {
          ok: true,
          code: 'ok',
          message: 'Masuk ke SMTP berhasil. Tidak ada email yang dikirim saat tes.',
          durationMs: 900,
        }
      : {
          ok: false,
          code: 'smtp_auth_failed',
          message: 'Username atau password SMTP ditolak server. Periksa lagi keduanya.',
          durationMs: 800,
        },
    ...overrides,
  };
}

// ── 9B: tulis, identitas, draf, outbox ─────────────────────────────────────

export const COMPOSE_IDS = {
  identityCs: '7a1b2c3d-0000-4000-8000-0000000000d1',
  identityTagihan: '7a1b2c3d-0000-4000-8000-0000000000d2',
  identityBilling: '7a1b2c3d-0000-4000-8000-0000000000d3',
  draft: '7a1b2c3d-0000-4000-8000-0000000000f1',
  draft2: '7a1b2c3d-0000-4000-8000-0000000000f2',
  outbox: '7a1b2c3d-0000-4000-8000-0000000000f9',
  attachment: '7a1b2c3d-0000-4000-8000-0000000000fa',
  signature: '7a1b2c3d-0000-4000-8000-0000000000fb',
} as const;

/** Identitas akun (kontrak 9B §3.4). */
export function fakeMailIdentity(overrides: Partial<MailIdentity> = {}): MailIdentity {
  const verified = overrides.verification?.state ?? 'verified';
  return {
    id: COMPOSE_IDS.identityCs,
    accountId: MAIL_IDS.cs,
    address: 'cs@majujaya.co.id',
    displayName: 'CS Maju Jaya',
    isPrimary: true,
    replyTo: null,
    verification: {
      state: verified,
      verifiedAt: verified === 'verified' ? new Date(Date.now() - 86_400_000).toISOString() : null,
      method: verified === 'verified' ? 'mailbox' : null,
      pending: null,
      available: true,
      unavailableReason: null,
    },
    approval: { state: 'not_required', decidedAt: null },
    defaultSignatures: { new: null, reply: null },
    canSend: verified === 'verified',
    cannotSendReason: verified === 'verified' ? null : 'identity_unverified',
    createdAt: new Date(Date.now() - 30 * 86_400_000).toISOString(),
    ...overrides,
  };
}

/** Pilihan "Dari" (identitas + akun ringkas). */
export function fakeComposeIdentity(
  overrides: Partial<MailIdentity> = {},
  account: Partial<{
    id: string;
    displayName: string;
    color: MailAccount['color'];
    kind: MailAccount['kind'];
  }> = {},
) {
  const identity = fakeMailIdentity(overrides);
  return {
    ...identity,
    account: {
      id: identity.accountId,
      displayName: 'CS Maju Jaya',
      color: 'tagBlue' as const,
      kind: 'shared' as const,
      avatarUrl: null,
      ...account,
    },
  };
}

/** Draf (kontrak 9B §6.2). */
export function fakeDraft(overrides: Partial<MailDraft> = {}): MailDraft {
  const now = new Date().toISOString();
  return {
    id: COMPOSE_IDS.draft,
    accountId: MAIL_IDS.cs,
    identityId: COMPOSE_IDS.identityCs,
    mode: 'new',
    sourceMessageId: null,
    threadKey: null,
    to: [],
    cc: [],
    bcc: [],
    subject: '',
    format: 'html',
    bodyHtml: '<p><br></p>',
    bodyText: null,
    includeQuote: false,
    quote: { available: false, messageId: null, from: null, sentAt: null, hasHtml: false },
    attachments: [],
    attachmentTotalBytes: 0,
    version: 1,
    state: 'editing',
    lastSendError: null,
    serverCopy: { state: 'pending', syncedAt: null },
    threadSeenAt: now,
    canSend: true,
    cannotSendReason: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

/** Outbox (kontrak 9B §9.2): `pending` dengan masa batal 10 dtk. */
export function fakeOutbox(overrides: Partial<MailOutboxItem> = {}): MailOutboxItem {
  const created = new Date();
  return {
    id: COMPOSE_IDS.outbox,
    draftId: COMPOSE_IDS.draft,
    accountId: MAIL_IDS.cs,
    identity: {
      id: COMPOSE_IDS.identityCs,
      address: 'cs@majujaya.co.id',
      displayName: 'CS Maju Jaya',
    },
    status: 'pending',
    holdReason: null,
    sendAfter: new Date(created.getTime() + 10_000).toISOString(),
    nextAttemptAt: null,
    attempts: 0,
    subject: 'Penawaran paket',
    recipientCount: 1,
    toPreview: ['Rina Wulandari'],
    sentAt: null,
    failure: null,
    rejectedRecipients: [],
    sentCopy: { state: 'pending' },
    createdAt: created.toISOString(),
    ...overrides,
  };
}

/** Tanda tangan (kontrak 9B §4). */
export function fakeSignature(overrides: Partial<MailSignature> = {}): MailSignature {
  const now = new Date().toISOString();
  return {
    id: COMPOSE_IDS.signature,
    accountId: MAIL_IDS.cs,
    scope: 'shared',
    name: 'Formal',
    html: '<p>Salam hangat,<br>{{nama_agen}}<br>{{nama_organisasi}}</p>',
    text: 'Salam hangat,\n{{nama_agen}}\n{{nama_organisasi}}',
    logoUrl: null,
    editable: true,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}
