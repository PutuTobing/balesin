import { USER_ROLE_LABELS, type TeamUser } from '@balesin/shared';
import { Link } from '@tanstack/react-router';
import { ChevronRight } from 'lucide-react';
import { useState } from 'react';
import { Avatar } from '../../components/shell/UserMenu';
import { Icon } from '../../components/ui/Icon';
import { SearchField } from '../../components/ui/SearchField';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { formatDateTimeInline } from '../../lib/format';
import { MEMBER_SEARCH_THRESHOLD, filterMembers, memberBadges } from './member-status';
import styles from './Team.module.css';

const copy = t.team.members;
const HEADING_ID = 'tim-anggota';

/**
 * Daftar anggota tim (izin `team.manage`): yang aktif dulu, lalu kelompok "Nonaktif". Setiap baris
 * adalah tautan ke detail anggota; baris diri sendiri ke Keamanan akun (akun sendiri tidak
 * dikelola dari Tim). Anggota yang tidak bisa dikelola pemanggil tetap bisa dibuka (hanya dilihat).
 */
export function MembersCard({ users }: { users: readonly TeamUser[] }) {
  const [query, setQuery] = useState('');
  const searchable = users.length > MEMBER_SEARCH_THRESHOLD;
  const shown = filterMembers(users, searchable ? query : '');
  const active = shown.filter((user) => user.status !== 'disabled');
  const disabled = shown.filter((user) => user.status === 'disabled');

  return (
    <section className={styles.card} aria-labelledby={HEADING_ID}>
      <div className={styles.cardHead}>
        <h2 id={HEADING_ID} className={styles.cardTitle}>
          {copy.title}
          <span className={styles.count}>{users.length}</span>
        </h2>
        <p className={styles.cardHint}>{copy.hint}</p>
      </div>
      {searchable ? (
        <SearchField
          value={query}
          onChange={setQuery}
          label={copy.searchLabel}
          placeholder={copy.searchPlaceholder}
          clearLabel={t.inbox.clearSearch}
        />
      ) : null}
      {shown.length === 0 ? (
        <p className={styles.cardHint} role="status">
          {copy.searchEmpty(query.trim())}
        </p>
      ) : (
        <div className={styles.list}>
          {active.length > 0 ? (
            <ul className={styles.memberList} aria-label={copy.listLabel}>
              {active.map((user) => (
                <MemberRow key={user.id} user={user} />
              ))}
            </ul>
          ) : null}
          {disabled.length > 0 ? (
            <>
              <h3 className={styles.groupTitle}>{copy.disabledGroup(disabled.length)}</h3>
              <ul className={styles.memberList} aria-label={copy.disabledGroup(disabled.length)}>
                {disabled.map((user) => (
                  <MemberRow key={user.id} user={user} />
                ))}
              </ul>
            </>
          ) : null}
        </div>
      )}
    </section>
  );
}

function MemberRow({ user }: { user: TeamUser }) {
  const badges = memberBadges(user);
  const content = (
    <>
      <Avatar name={user.name} className={styles.memberAvatar} />
      <span className={styles.memberMain}>
        <span className={styles.memberName}>
          <span className={styles.memberNameText}>{user.name}</span>
          {user.isSelf ? <span className={styles.youTag}>{copy.you}</span> : null}
        </span>
        <span className={styles.memberEmail}>{user.email}</span>
        <span className={`${styles.rowMeta} ${styles.memberMeta}`}>
          <span className={styles.role}>{USER_ROLE_LABELS[user.role]}</span>
          {badges.map((badge) => (
            <StatusBadge
              key={badge.label}
              tone={badge.tone}
              label={badge.label}
              className={styles.badge}
            />
          ))}
        </span>
        <span className={styles.memberDetail}>
          <span className={styles.segment}>
            {user.lastLoginAt
              ? copy.lastLogin(formatDateTimeInline(user.lastLoginAt))
              : copy.neverLoggedIn}
            <span className={styles.separator} aria-hidden="true">
              {' ·'}
            </span>
            <span className="sr-only">.</span>
          </span>{' '}
          <span className={styles.segment}>{copy.sessions(user.activeSessions)}</span>
          {!user.canManage && !user.isSelf ? (
            <>
              <span className={styles.separator} aria-hidden="true">
                {' ·'}
              </span>
              <span className="sr-only">.</span>{' '}
              <span className={styles.segment}>{copy.viewOnly}</span>
            </>
          ) : null}
        </span>
      </span>
      <Icon icon={ChevronRight} size={16} className={styles.chevron} />
    </>
  );
  return (
    <li className={styles.memberItem}>
      {user.isSelf ? (
        <Link to="/pengaturan/keamanan" className={styles.memberLink}>
          {content}
        </Link>
      ) : (
        <Link
          to="/pengaturan/tim/$userId"
          params={{ userId: user.id }}
          className={styles.memberLink}
        >
          {content}
        </Link>
      )}
    </li>
  );
}
