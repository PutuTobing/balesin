import { ATTRIBUTE_DEFINITION_LIMITS } from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { EmptyState } from '../../components/ui/EmptyState';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { AttributeManager } from './AttributeManager';
import { contactAttributesQuery, crmKeys } from './contact-queries';
import styles from './Attributes.module.css';

const a = t.attributes;

/** Pengaturan → Atribut kontak (`settings.workspace.manage`): definisi atribut organisasi. */
export function AttributeDefinitionsPage() {
  const queryClient = useQueryClient();
  const list = useQuery(contactAttributesQuery);
  return (
    <Page>
      <div className={styles.page}>
        <p className={styles.intro}>{a.intro}</p>
        {list.isPending ? (
          <SkeletonRegion className={styles.card}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className={styles.skeleton} />
            ))}
          </SkeletonRegion>
        ) : list.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={a.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : (
          <section className={styles.card} aria-label={a.title}>
            <AttributeManager
              scope={{ kind: 'contact' }}
              attributes={list.data}
              max={ATTRIBUTE_DEFINITION_LIMITS.contactPerOrganization}
              onChanged={() => void queryClient.invalidateQueries({ queryKey: crmKeys.attributes })}
            />
          </section>
        )}
      </div>
    </Page>
  );
}
