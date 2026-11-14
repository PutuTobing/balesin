import { PageHeader } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { usePageTitle } from '../../lib/use-page-title';
import { useCan } from '../auth/session';
import pageStyles from '../../components/ui/Page.module.css';
import styles from './Team.module.css';

/**
 * Kerangka Pengaturan → Tim: header asli, lalu kartu undangan dan kartu daftar di posisi layar
 * jadi. Teks yang tidak bergantung data (judul kartu, label isian) tampil asli.
 */
export function TeamSkeleton() {
  usePageTitle(t.team.title);
  const canInvite = useCan('team.invite');
  const canManage = useCan('team.manage');
  return (
    <div className={pageStyles.page}>
      <PageHeader title={t.team.title} parent="settings" />
      <div className={pageStyles.body}>
        <SkeletonRegion className={styles.content}>
          {canInvite ? <InvitationCardsSkeleton /> : null}
          {/*
            Tinggi daftar undangan bergantung data: kartu anggota di bawahnya baru tampil setelah
            data tiba, supaya tidak ada yang bergeser (kritikus butir 6 W2).
          */}
          {canManage && !canInvite ? <MembersCardSkeleton /> : null}
        </SkeletonRegion>
      </div>
    </div>
  );
}

/** Kartu anggota: judul dan petunjuk asli, dua baris anggota berupa balok. */
function MembersCardSkeleton() {
  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <h2 className={styles.cardTitle}>{t.team.members.title}</h2>
        <p className={styles.cardHint}>{t.team.members.hint}</p>
      </div>
      <div className={styles.list}>
        {[0, 1].map((index) => (
          <div key={index} className={styles.memberItem}>
            <div className={styles.memberLink}>
              <Skeleton className={styles.skeletonAvatar} />
              <div className={styles.memberMain}>
                <Skeleton className={styles.skeletonName} />
                <Skeleton className={styles.skeletonDetail} />
                <Skeleton className={styles.skeletonMeta} />
                <Skeleton className={styles.skeletonDetail} />
              </div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function InvitationCardsSkeleton() {
  return (
    <>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t.team.invite.title}</h2>
          <span className={styles.skeletonLines}>
            <Skeleton className={styles.skeletonHint} />
            {/* Di HP petunjuk ini tiga baris. */}
            <Skeleton className={styles.skeletonHintHp} />
            <Skeleton className={styles.skeletonHintShort} />
          </span>
        </div>
        <div className={styles.form}>
          <div className={styles.inviteRow}>
            <div className={styles.skeletonField}>
              <span className={styles.skeletonLabel}>{t.team.invite.email}</span>
              <Skeleton className={styles.skeletonControl} />
            </div>
            {/* Peran bawaan selalu CS: petunjuknya sudah pasti, tampil asli. */}
            <div className={styles.skeletonField}>
              <span className={styles.skeletonLabel}>{t.team.invite.role}</span>
              <Skeleton className={styles.skeletonControl} />
              <p className={styles.skeletonFieldHint}>{t.team.invite.roleHints.cs}</p>
            </div>
          </div>
          <div className={styles.formFooter}>
            <Skeleton className={styles.skeletonButtons} />
          </div>
        </div>
      </div>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>{t.team.list.title}</h2>
          <span className={styles.skeletonLines}>
            <Skeleton className={styles.skeletonHint} />
            {/* Di HP petunjuk daftar dua baris. */}
            <Skeleton className={styles.skeletonHintHp} />
          </span>
        </div>
        <div className={styles.list}>
          {[0, 1].map((index) => (
            <div key={index} className={styles.row}>
              <div className={styles.rowMain}>
                <Skeleton className={styles.skeletonEmail} />
                <Skeleton className={styles.skeletonMeta} />
                <Skeleton className={styles.skeletonDetail} />
                {/* Di HP keterangan pengundang + masa berlaku dua baris. */}
                <Skeleton className={styles.skeletonDetailHp} />
              </div>
              <Skeleton className={styles.skeletonButtons} />
            </div>
          ))}
        </div>
      </div>
    </>
  );
}
