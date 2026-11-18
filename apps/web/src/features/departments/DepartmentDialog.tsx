import type { Conversation } from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { RadioGroup } from 'radix-ui';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { forgetConversation, inboxKeys, storeConversation } from '../inbox/inbox-queries';
import { departmentsQuery } from './department-queries';
import styles from './Departments.module.css';

const d = t.departments;
const NONE = '__tanpa__';

/**
 * Pindahkan percakapan ke departemen / lepas (`inbox.assign`). Jawaban `{ conversation: null }` =
 * pelaku tidak lagi melihat chat ini (mis. bertanda departemen) → data dibuang, chat ditutup.
 */
export function DepartmentDialog({
  conversation,
  onCancel,
  onDone,
  onError,
  onClosed,
}: {
  conversation: Conversation;
  onCancel: () => void;
  onDone: () => void;
  onError: (error: unknown) => void;
  onClosed?: () => void;
}) {
  const queryClient = useQueryClient();
  const departments = useQuery(departmentsQuery);
  const current = conversation.department?.id ?? NONE;
  const [selected, setSelected] = useState(current);
  const move = useMutation({
    mutationFn: () =>
      endpoints.departments.moveConversation(conversation.id, selected === NONE ? null : selected),
    onMutate: () => onError(null),
    onSuccess: ({ conversation: updated }) => {
      onDone();
      void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.events(conversation.id) });
      if (updated) {
        storeConversation(queryClient, updated);
        return;
      }
      forgetConversation(queryClient, conversation.id);
      onClosed?.();
    },
    onError: (error) => {
      onDone();
      onError(error);
    },
  });
  const list = departments.data?.departments ?? [];
  return (
    <Dialog
      open
      title={d.moveTitle}
      description={d.moveBody(conversation.department?.name ?? null)}
      onRequestClose={onCancel}
    >
      {departments.isPending ? (
        <p className={styles.hint}>{t.common.loading}</p>
      ) : departments.isError ? (
        <p className={styles.hint}>{d.moveFailed}</p>
      ) : (
        <RadioGroup.Root
          className={styles.options}
          value={selected}
          onValueChange={setSelected}
          aria-label={d.moveOptionsLabel}
        >
          {[
            ...list.map((item) => ({
              id: item.id,
              name: item.name,
              meta: d.members(item.memberCount),
            })),
            { id: NONE, name: d.moveNone, meta: null },
          ].map((option) => (
            <RadioGroup.Item key={option.id} value={option.id} className={styles.option}>
              <span className={styles.radio}>
                <RadioGroup.Indicator className={styles.radioDot} />
              </span>
              <span className={styles.optionText}>
                {option.name}
                {option.meta ? <span className={styles.optionMeta}>{option.meta}</span> : null}
              </span>
            </RadioGroup.Item>
          ))}
        </RadioGroup.Root>
      )}
      <DialogActions>
        <Button onClick={onCancel}>{d.cancel}</Button>
        <Button
          variant="primary"
          disabled={selected === current}
          loading={move.isPending}
          onClick={() => move.mutate()}
        >
          {move.isPending ? d.moving : d.moveConfirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
