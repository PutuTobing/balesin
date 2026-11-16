import { z } from 'zod';

import { USER_ROLES, type UserRole } from './roles';

/**
 * Matriks izin RBAC — SUMBER TUNGGAL (PRD §4, SECURITY.md §2 dan §5).
 *
 * - API menegakkannya: setiap rute terlindungi menyatakan satu izin (`requirePermission(...)` di
 *   `apps/api/src/http/route-access.ts`) atau secara eksplisit "cukup sesi" (`AUTHENTICATED`, hanya
 *   untuk data milik pengguna itu sendiri). Rute tanpa deklarasi membuat API menolak start.
 * - Web hanya memakainya untuk menyembunyikan menu/tombol. Daftar izin pengguna yang sedang masuk
 *   dikirim server di `permissions` pada respons sesi (`GET /auth/me`, login, dsb.) — web memakai
 *   daftar itu, bukan menghitung sendiri dari peran.
 *
 * Izin berbentuk aksi bernama `<domain>.<aksi>`. Sebagian izin punya CAKUPAN (`PermissionScope`):
 * peran boleh melakukan aksinya hanya pada sebagian data (mis. Teknisi hanya percakapan yang
 * di-assign kepadanya). Hook auth hanya memeriksa "boleh masuk ke rute ini"; cakupan diperiksa
 * service/repo modul lewat `permissionScope` + `isWithinScope` (atau filter SQL yang setara).
 *
 * Izin untuk fitur fase berikutnya sudah ada di sini supaya modulnya tinggal memakai. Mengubah
 * matriks = mengubah keamanan produk: perbarui `docs/DECISIONS.md`, tes tabel di
 * `permissions.test.ts`, dan minta review `security`.
 */

/**
 * Cakupan sebuah izin untuk satu peran:
 *  - `all`      — semua data organisasi.
 *  - `assigned` — hanya data yang di-assign ke pengguna itu, ATAU yang terkait tiket yang di-assign
 *                 kepadanya (percakapan/kontak untuk Teknisi, SECURITY.md §2).
 *  - `own`      — hanya data milik pengguna itu sendiri (tiket yang ia pegang, laporan kinerjanya).
 *
 * Nanti "akses departemen sendiri" (PRD §3.6, Fase 5) menyempitkan cakupan `all` per pengguna;
 * tambahkan nilai baru di sini, jangan membuat izin baru.
 */
export const PERMISSION_SCOPES = ['all', 'assigned', 'own'] as const;
export const permissionScopeSchema = z.enum(PERMISSION_SCOPES);
export type PermissionScope = z.infer<typeof permissionScopeSchema>;

/** Semua izin, dikelompokkan seperti layar "Peran & akses". Urutan ini = urutan di respons sesi. */
export const PERMISSIONS = [
  // ── Organisasi (Owner) ────────────────────────────────────────────────────
  /** Nama, zona waktu, branding white-label; nanti billing & lisensi. */
  'organization.manage',
  /** Cadangan & pemulihan dari UI (Pengaturan → Backup). */
  'backup.manage',
  // ── Pengaturan & integrasi (Owner/Admin, PENGATURAN-UI.md) ────────────────
  /** Channel (WhatsApp, Telegram, Email, Messenger/IG) beserta kredensialnya. */
  'channels.manage',
  /** Pengaturan → Email pengirim, termasuk tes koneksi dan pratinjau template email. */
  'settings.email.manage',
  /**
   * Pengaturan kerja tim: departemen, jam kerja (tim & bot), alokasi agen + kapasitas, tag,
   * pesan otomatis, CSAT. BUKAN rem pengiriman — itu `sending.limits.manage`.
   */
  'settings.workspace.manage',
  /**
   * Rem pengiriman (SECURITY.md §5): ambang persetujuan broadcast, batas kirim harian per
   * pengguna/organisasi, ambang rem darurat, ambang alarm biaya. Dipisah dari
   * `settings.workspace.manage` supaya memberi peran lain wewenang mengatur jam kerja/departemen
   * tidak ikut memberi kendali atas batas yang melindungi nomor (review RBAC R3). Modulnya WAJIB
   * mengaudit setiap perubahan dan memberi tahu semua Owner.
   */
  'sending.limits.manage',
  /** API key (scope, kedaluwarsa, cabut). */
  'api_keys.manage',
  /** Bot eksternal (n8n), webhook keluar, allowlist IP privat, konektor billing, alarm Telegram. */
  'integrations.manage',
  // ── Tim ───────────────────────────────────────────────────────────────────
  /** Undang anggota + kirim ulang/batalkan undangan. Peran yang boleh diundang: `INVITE_PERMISSIONS`. */
  'team.invite',
  /**
   * Kelola anggota: nonaktifkan/aktifkan, ubah peran, keluarkan sesi, reset 2FA pengguna lain.
   * Aturan turunan per peran sasaran (mis. Admin tidak atas Owner/Admin) ditegakkan modulnya.
   * Juga penerima pemberitahuan keamanan tim (mis. 2FA peran wajib diaktifkan).
   */
  'team.manage',
  /** Lihat audit log organisasi. */
  'audit.view',
  // ── Template & broadcast (SECURITY.md §5) ────────────────────────────────
  /** Buat, jadwalkan, jeda/batal broadcast. Di atas ambang tetap butuh `broadcast.approve`. */
  'broadcast.send',
  /** Setujui broadcast dengan penerima di atas ambang (bawaan 50). */
  'broadcast.approve',
  /** Lanjutkan antrian kirim setelah rem darurat berhenti otomatis. */
  'sending.resume',
  /** Sinkron, buat, dan ajukan template pesan Meta (termasuk preset industri). */
  'templates.manage',
  /** Template percakapan / quick reply `/`. */
  'quick_replies.manage',
  // ── Inbox ─────────────────────────────────────────────────────────────────
  /** Baca percakapan, pesan, media, panel detail. Bercakupan. */
  'inbox.view',
  /**
   * Kerjakan percakapan YANG SUDAH ADA (dalam cakupan): balas pesan/template di percakapan itu,
   * catatan sesi, tandai pesan, quick reply, tandai selesai/buka lagi, saklar bot per percakapan.
   * Bercakupan. Tag menempel ke KONTAK, jadi memasang/melepasnya = `contacts.manage` (butir 8).
   * TIDAK mencakup memulai percakapan ke nomor yang belum punya percakapan — itu `inbox.initiate`.
   */
  'inbox.reply',
  /**
   * Memulai percakapan baru / mengirim template ke nomor yang belum punya percakapan terbuka.
   * Dipisah dari `inbox.reply` supaya akun CS yang dibobol tidak bisa mengirim template satu per
   * satu ke ribuan nomor (broadcast terselubung yang melewati `broadcast.send` + persetujuan,
   * review RBAC S2). Modulnya WAJIB menerapkan batas harian per pengguna sejak hari pertama.
   */
  'inbox.initiate',
  /** Assign/alihkan percakapan ke agen lain, ambil dari antrian terbuka, ambil alih. */
  'inbox.assign',
  /**
   * Menghapus catatan sesi milik ORANG LAIN (moderasi, butir 8). Mengubah isi catatan tetap hanya
   * penulisnya — supaya tidak ada yang "menulis atas nama" rekan.
   */
  'inbox.notes.moderate',
  // ── CRM ───────────────────────────────────────────────────────────────────
  /** Lihat kontak dan riwayatnya. Bercakupan. */
  'contacts.view',
  /** Buat/ubah kontak, tag, atribut kustom, gabung duplikat. */
  'contacts.manage',
  /** Impor & ekspor kontak massal (data pribadi, UU PDP). */
  'contacts.export',
  /** Hapus kontak beserta data pribadinya (UU PDP, SECURITY.md §10). */
  'contacts.delete',
  /** Buat/ubah tiket, status, penanggung jawab, tenggat. Bercakupan. */
  'tickets.manage',
  /** Kelola board tiket, kolom status, atribut kustom tiket. */
  'tickets.configure',
  // ── Laporan ───────────────────────────────────────────────────────────────
  /**
   * Laporan & dashboard, ekspor CSV. Bercakupan: `own` = hanya kinerja sendiri; laporan tingkat
   * organisasi (biaya pesan Meta, per kampanye, per bot) hanya untuk cakupan `all`.
   */
  'reports.view',
] as const;

export const permissionSchema = z.enum(PERMISSIONS);
export type Permission = z.infer<typeof permissionSchema>;

/** Izin yang boleh punya cakupan selain `all` (dicek tes; modulnya WAJIB memeriksa cakupan). */
export const SCOPED_PERMISSIONS = [
  'inbox.view',
  'inbox.reply',
  'contacts.view',
  'tickets.manage',
  'reports.view',
] as const satisfies readonly Permission[];
export type ScopedPermission = (typeof SCOPED_PERMISSIONS)[number];

type Grant = PermissionScope | null;
type Row = readonly [owner: Grant, admin: Grant, supervisor: Grant, cs: Grant, teknisi: Grant];

const Y = 'all';
const N = null;

/**
 * Tabel PRD §4, satu baris per izin. Kolom: Owner, Admin, Supervisor, CS, Teknisi.
 * `null` = tidak boleh. Alasan tiap baris di `docs/DECISIONS.md` (RBAC, Fase 1 butir 5).
 */
const MATRIX: Readonly<Record<Permission, Row>> = {
  'organization.manage': [Y, N, N, N, N],
  'backup.manage': [Y, N, N, N, N],
  'channels.manage': [Y, Y, N, N, N],
  'settings.email.manage': [Y, Y, N, N, N],
  'settings.workspace.manage': [Y, Y, N, N, N],
  'sending.limits.manage': [Y, Y, N, N, N],
  'api_keys.manage': [Y, Y, N, N, N],
  'integrations.manage': [Y, Y, N, N, N],
  'team.invite': [Y, Y, N, N, N],
  'team.manage': [Y, Y, N, N, N],
  'audit.view': [Y, Y, N, N, N],
  'broadcast.send': [Y, Y, Y, N, N],
  'broadcast.approve': [Y, Y, N, N, N],
  'sending.resume': [Y, Y, N, N, N],
  'templates.manage': [Y, Y, Y, N, N],
  'quick_replies.manage': [Y, Y, Y, N, N],
  'inbox.view': [Y, Y, Y, Y, 'assigned'],
  'inbox.reply': [Y, Y, Y, Y, 'assigned'],
  'inbox.initiate': [Y, Y, Y, N, N],
  'inbox.assign': [Y, Y, Y, Y, N],
  'inbox.notes.moderate': [Y, Y, N, N, N],
  'contacts.view': [Y, Y, Y, Y, 'assigned'],
  'contacts.manage': [Y, Y, Y, Y, N],
  'contacts.export': [Y, Y, Y, N, N],
  'contacts.delete': [Y, Y, N, N, N],
  'tickets.manage': [Y, Y, Y, Y, 'own'],
  'tickets.configure': [Y, Y, Y, N, N],
  'reports.view': [Y, Y, Y, 'own', 'own'],
};

function buildRolePermissions(): Record<
  UserRole,
  Readonly<Partial<Record<Permission, PermissionScope>>>
> {
  // Objek TANPA prototipe: kunci warisan (`toString`, `constructor`, `__proto__`) tidak pernah
  // terbaca sebagai izin yang dipegang (review RBAC R2).
  const byRole = Object.create(null) as Record<
    UserRole,
    Partial<Record<Permission, PermissionScope>>
  >;
  for (const role of USER_ROLES) {
    byRole[role] = Object.create(null) as Partial<Record<Permission, PermissionScope>>;
  }
  for (const permission of PERMISSIONS) {
    MATRIX[permission].forEach((grant, index) => {
      const role = USER_ROLES[index];
      if (role !== undefined && grant !== null) byRole[role][permission] = grant;
    });
  }
  for (const role of USER_ROLES) Object.freeze(byRole[role]);
  return Object.freeze(byRole);
}

/** Izin tiap peran beserta cakupannya. Izin yang tidak ada = tidak boleh. */
export const ROLE_PERMISSIONS: Readonly<
  Record<UserRole, Readonly<Partial<Record<Permission, PermissionScope>>>>
> = buildRolePermissions();

/** Cakupan izin untuk peran ini, atau `null` bila tidak boleh sama sekali. */
export function permissionScope(role: UserRole, permission: Permission): PermissionScope | null {
  // Lapis kedua selain objek tanpa prototipe: hanya kunci MILIK baris itu sendiri yang dihitung,
  // juga untuk peran/izin yang lolos dari pemeriksaan tipe (JSON, parameter, JavaScript polos).
  if (!Object.hasOwn(ROLE_PERMISSIONS, role)) return null;
  const row = ROLE_PERMISSIONS[role];
  if (!Object.hasOwn(row, permission)) return null;
  const scope = row[permission];
  return scope !== undefined && (PERMISSION_SCOPES as readonly string[]).includes(scope)
    ? scope
    : null;
}

/** Peran ini boleh melakukan aksi ini (pada cakupan apa pun). */
export function hasPermission(role: UserRole, permission: Permission): boolean {
  return permissionScope(role, permission) !== null;
}

/** Semua izin peran ini, berurutan seperti `PERMISSIONS`. */
export function permissionsForRole(role: UserRole): Permission[] {
  return PERMISSIONS.filter((permission) => hasPermission(role, permission));
}

/**
 * Peran yang memegang izin ini (dengan cakupan `all` bila `fullScopeOnly`), dari wewenang tertinggi.
 * Untuk query penerima, mis. "semua yang boleh menyetujui broadcast".
 */
export function rolesWithPermission(
  permission: Permission,
  options: { fullScopeOnly?: boolean } = {},
): UserRole[] {
  return USER_ROLES.filter((role) => {
    const scope = permissionScope(role, permission);
    return scope !== null && (!options.fullScopeOnly || scope === 'all');
  });
}

/**
 * Hubungan satu data (percakapan, kontak, tiket, baris laporan) dengan pengguna — diisi repo modul.
 */
export interface ScopeTarget {
  /**
   * Pengguna yang memegang data ini LANGSUNG: agen utama/peserta percakapan, penanggung jawab
   * tiket, pengguna yang kinerjanya dilaporkan.
   */
  holderUserIds: readonly string[];
  /**
   * Penanggung jawab tiket yang MENAUT data ini (mis. percakapan/kontak yang terkait tiket
   * perbaikan seorang Teknisi). Hanya dihitung untuk cakupan `assigned`.
   */
  linkedTicketHolderUserIds?: readonly string[];
}

/**
 * `true` bila pengguna dengan cakupan ini boleh menyentuh data ini. Untuk DAFTAR, modul memakai
 * filter SQL yang setara (jangan mengambil semua lalu menyaring di memori). Data di luar
 * cakupan dijawab 404 — bukan 403 — supaya keberadaannya tidak terbuka.
 */
export function isWithinScope(
  scope: PermissionScope,
  userId: string,
  target: ScopeTarget,
): boolean {
  switch (scope) {
    case 'all':
      return true;
    case 'assigned':
      return (
        target.holderUserIds.includes(userId) ||
        (target.linkedTicketHolderUserIds ?? []).includes(userId)
      );
    case 'own':
      return target.holderUserIds.includes(userId);
  }
}

/** Nama izin untuk layar "Peran & akses" (bahasa Indonesia). */
export const PERMISSION_LABELS: Readonly<Record<Permission, string>> = {
  'organization.manage': 'Pengaturan organisasi, billing, dan lisensi',
  'backup.manage': 'Cadangan dan pemulihan data',
  'channels.manage': 'Kelola channel dan kredensial Meta',
  'settings.email.manage': 'Atur email pengirim',
  'settings.workspace.manage': 'Atur departemen, jam kerja, alokasi agen, dan tag',
  'sending.limits.manage': 'Atur batas kirim, ambang persetujuan, dan alarm biaya',
  'api_keys.manage': 'Kelola API key',
  'integrations.manage': 'Kelola webhook, bot, dan integrasi',
  'team.invite': 'Undang anggota tim',
  'team.manage': 'Kelola dan nonaktifkan anggota tim',
  'audit.view': 'Lihat audit log',
  'broadcast.send': 'Buat dan kirim broadcast',
  'broadcast.approve': 'Setujui broadcast di atas ambang',
  'sending.resume': 'Lanjutkan pengiriman setelah rem darurat',
  'templates.manage': 'Kelola template pesan',
  'quick_replies.manage': 'Kelola template percakapan',
  'inbox.view': 'Lihat percakapan',
  'inbox.reply': 'Balas percakapan yang sudah ada',
  'inbox.initiate': 'Mulai percakapan ke nomor baru',
  'inbox.assign': 'Assign dan alihkan percakapan',
  'inbox.notes.moderate': 'Hapus catatan sesi milik orang lain',
  'contacts.view': 'Lihat kontak',
  'contacts.manage': 'Ubah kontak',
  'contacts.export': 'Impor dan ekspor kontak',
  'contacts.delete': 'Hapus kontak',
  'tickets.manage': 'Kelola tiket',
  'tickets.configure': 'Atur board dan kolom tiket',
  'reports.view': 'Lihat laporan',
};

/** Arti cakupan terbatas untuk ditampilkan di samping nama izin. */
export const PERMISSION_SCOPE_LABELS: Readonly<Record<PermissionScope, string>> = {
  all: 'Semua',
  assigned: 'Hanya yang di-assign atau terkait tiketnya',
  own: 'Hanya milik sendiri',
};
