import { USER_ROLE_LABELS, type SessionUser } from '@balesin/shared';
import { LogOut } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useLogout, useSession } from '../../features/auth/session';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { Icon } from '../ui/Icon';
import { Tooltip } from '../ui/Tooltip';
import { initialsOf } from './initials';
import { RAIL_POPOVER_OFFSET } from './rail';
import styles from './UserMenu.module.css';

export function Avatar({ name, className }: { name: string; className?: string }) {
  return (
    <span className={cx(styles.avatar, className)} aria-hidden="true">
      {initialsOf(name)}
    </span>
  );
}

/** Nama, email, dan peran pengguna yang sedang masuk. */
export function UserIdentity({ user }: { user: SessionUser }) {
  return (
    <div className={styles.identity}>
      <Avatar name={user.name} className={styles.identityAvatar} />
      <div className={styles.identityText}>
        <span className={styles.name}>{user.name}</span>
        <span className={styles.email}>{user.email}</span>
      </div>
      <span className={styles.role}>{USER_ROLE_LABELS[user.role]}</span>
    </div>
  );
}

/** Menu akun di dasar rail desktop: identitas + Keluar. */
export function UserMenu({ className }: { className?: string }) {
  const session = useSession();
  const logout = useLogout();
  if (!session) return null;
  const { user } = session;
  const label = t.auth.userMenu.open(user.name);

  return (
    // Non-modal: mode modal Radix menyuntikkan <style> inline (ditolak CSP `style-src 'self'`).
    <DropdownMenu.Root modal={false} onOpenChange={(open) => !open && logout.reset()}>
      <Tooltip label={label} side="right" sideOffset={RAIL_POPOVER_OFFSET}>
        <DropdownMenu.Trigger asChild>
          <button type="button" className={className} aria-label={label}>
            <Avatar name={user.name} />
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          side="right"
          align="end"
          sideOffset={RAIL_POPOVER_OFFSET}
          collisionPadding={8}
          className={styles.menu}
          aria-label={t.auth.userMenu.account}
        >
          <DropdownMenu.Label className={styles.heading}>
            {t.auth.userMenu.signedInAs}
          </DropdownMenu.Label>
          <UserIdentity user={user} />
          <DropdownMenu.Separator className={styles.separator} />
          <DropdownMenu.Item
            className={styles.item}
            disabled={logout.isPending}
            onSelect={(event) => {
              // Menu tetap terbuka sampai keluar selesai, supaya kegagalan bisa ditampilkan.
              event.preventDefault();
              logout.mutate();
            }}
          >
            <Icon icon={LogOut} size={16} className={styles.itemIcon} />
            {logout.isPending ? t.auth.userMenu.loggingOut : t.auth.userMenu.logout}
          </DropdownMenu.Item>
          {logout.isError ? (
            <p role="alert" className={styles.error}>
              {t.auth.userMenu.logoutFailed}
            </p>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}
