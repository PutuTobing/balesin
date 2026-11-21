import { USER_ROLE_LABELS, type Conversation, type InboxAgent } from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Bot,
  Building2,
  CheckCircle2,
  EllipsisVertical,
  Hand,
  RotateCcw,
  Undo2,
  UserRoundCog,
  UsersRound,
} from 'lucide-react';
import { DropdownMenu, RadioGroup } from 'radix-ui';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { Icon } from '../../components/ui/Icon';
import { Tooltip } from '../../components/ui/Tooltip';
import { t } from '../../i18n/id';
import { endpoints } from '../../lib/api/endpoints';
import { media, useMediaQuery } from '../../lib/media';
import { useCan, useSession } from '../auth/session';
import { DepartmentDialog } from '../departments/DepartmentDialog';
import { departmentsQuery } from '../departments/department-queries';
import styles from './HandlingActions.module.css';
import { channelBotKey } from '../channels/bot-form';
import { agentsQuery, forgetConversation, inboxKeys, storeConversation } from './inbox-queries';
import { RESOLVED_NOTE_ID, useReopenBlocked } from './use-reopen-blocked';

const h = t.inbox.handling;

type Action = 'assign' | 'unassign' | 'resolve' | 'reopen' | 'claim' | 'botOff' | 'botOn';

/**
 * Penanganan percakapan (butir 7) di kepala chat: tandai selesai / buka lagi (tombol terlihat di
 * desktop), alihkan ke agen, kembalikan ke antrian (menu). Jawaban `{ conversation: null }` = pengguna
 * tidak lagi boleh melihat chat ini (mis. Teknisi mengembalikannya) → data dibuang, chat ditutup.
 */
export function HandlingActions({
  conversation,
  onError,
  onClosed,
}: {
  conversation: Conversation;
  onError: (error: unknown) => void;
  onClosed?: () => void;
}) {
  const queryClient = useQueryClient();
  const session = useSession();
  const isDesktop = useMediaQuery(media.desktop);
  const canReply = useCan('inbox.reply');
  const canAssign = useCan('inbox.assign');
  const reopenBlocked = useReopenBlocked(conversation);
  const [assignOpen, setAssignOpen] = useState(false);
  const [departmentOpen, setDepartmentOpen] = useState(false);
  const departments = useQuery({ ...departmentsQuery, enabled: canAssign }).data?.departments;
  const canMoveDepartment = canAssign && (departments?.length ?? 0) > 0;
  // Pengaturan bot channel HANYA bila sudah ada di cache (mis. habis membuka Pengaturan → Channel):
  // tidak ada permintaan tambahan per percakapan. Tanpa data → tombol tetap ada; server menjawab 409
  // dengan penjelasannya.
  const botSettings = useQuery({
    queryKey: channelBotKey(conversation.channel.id),
    queryFn: ({ signal }) => endpoints.channels.bot(conversation.channel.id, signal),
    // Hanya membaca cache (dan ikut berubah bila cache diperbarui) — tidak pernah memuat sendiri.
    enabled: false,
  }).data?.settings;
  const botBlocked = !botSettings
    ? null
    : !botSettings.enabled
      ? h.botResumeOff
      : botSettings.receiverReady === false
        ? h.botResumeNoReceiver
        : null;

  const mutation = useMutation({
    mutationFn: ({ action, userId }: { action: Action; userId?: string }) => {
      const id = conversation.id;
      switch (action) {
        case 'assign':
          return endpoints.inbox.assign(id, userId ?? '');
        case 'unassign':
          return endpoints.inbox.unassign(id);
        case 'resolve':
          return endpoints.inbox.resolve(id);
        case 'reopen':
          return endpoints.inbox.reopen(id);
        case 'claim':
          return endpoints.inbox.claim(id);
        case 'botOff':
          return endpoints.inbox.bot(id, false);
        case 'botOn':
          return endpoints.inbox.bot(id, true);
      }
    },
    onMutate: () => onError(null),
    onSuccess: ({ conversation: updated }) => {
      setAssignOpen(false);
      void queryClient.invalidateQueries({ queryKey: inboxKeys.countsAll });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.agents });
      if (updated) {
        storeConversation(queryClient, updated);
        return;
      }
      // Di luar cakupan sekarang: buang datanya dan tutup chat.
      forgetConversation(queryClient, conversation.id);
      onClosed?.();
    },
    onError: (error) => {
      onError(error);
      // 409 (diambil orang lain, sudah ada sesi terbuka, …): tampilkan keadaan terbaru.
      void queryClient.invalidateQueries({ queryKey: inboxKeys.conversation(conversation.id) });
    },
  });

  if (!canReply) return null;
  const resolved = conversation.status === 'resolved';
  const withBot = conversation.status === 'bot';
  const mine = conversation.assignee?.id === session?.user.id;
  const canUnassign = !resolved && conversation.assignee !== null && (canAssign || mine);
  const busy = mutation.isPending ? mutation.variables.action : null;
  const run = (action: Action) => mutation.mutate({ action });

  return (
    <>
      {isDesktop && withBot ? (
        // Dipegang bot: serahkan ke antrian tim (ambil alih ada di menu dan di dasar ruang chat).
        <Button onClick={() => run('botOff')} loading={busy === 'botOff'}>
          {busy === 'botOff' ? null : <Icon icon={UsersRound} size={16} />}
          {busy === 'botOff' ? h.working : h.botHandoff}
        </Button>
      ) : isDesktop ? (
        resolved ? (
          // Tanpa izin memulai percakapan & pelanggan diam ≥ 24 jam: nonaktif; alasannya terbaca di
          // catatan dasar ruang chat (`aria-describedby`).
          <Button
            onClick={() => run('reopen')}
            loading={busy === 'reopen'}
            disabled={reopenBlocked}
            aria-describedby={reopenBlocked ? RESOLVED_NOTE_ID : undefined}
          >
            {busy === 'reopen' ? null : <Icon icon={RotateCcw} size={16} />}
            {busy === 'reopen' ? h.working : h.reopen}
          </Button>
        ) : (
          <Button onClick={() => run('resolve')} loading={busy === 'resolve'}>
            {busy === 'resolve' ? null : <Icon icon={CheckCircle2} size={16} />}
            {busy === 'resolve' ? h.working : h.resolve}
          </Button>
        )
      ) : null}
      <DropdownMenu.Root modal={false}>
        <Tooltip label={h.menu} side="bottom">
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              className={styles.trigger}
              aria-label={h.menu}
              aria-busy={busy !== null || undefined}
            >
              <Icon icon={EllipsisVertical} size={20} />
            </button>
          </DropdownMenu.Trigger>
        </Tooltip>
        <DropdownMenu.Portal>
          <DropdownMenu.Content
            align="end"
            sideOffset={4}
            collisionPadding={8}
            className={styles.menu}
          >
            {withBot ? (
              <>
                {canAssign ? (
                  <DropdownMenu.Item className={styles.item} onSelect={() => run('claim')}>
                    <Icon icon={Hand} size={16} />
                    {h.botTakeOver}
                  </DropdownMenu.Item>
                ) : null}
                {!isDesktop ? (
                  <DropdownMenu.Item className={styles.item} onSelect={() => run('botOff')}>
                    <Icon icon={UsersRound} size={16} />
                    {h.botHandoff}
                  </DropdownMenu.Item>
                ) : null}
              </>
            ) : null}
            {(!isDesktop || withBot) && resolved && reopenBlocked ? (
              // Alasan TERBACA di menu: buka lagi chat "dingin" butuh izin memulai percakapan.
              <DropdownMenu.Item className={styles.item} disabled>
                <Icon icon={RotateCcw} size={16} />
                <span className={styles.itemText}>
                  {h.reopen}
                  <span className={styles.itemReason}>{h.reopenStale}</span>
                </span>
              </DropdownMenu.Item>
            ) : !isDesktop || withBot ? (
              <DropdownMenu.Item
                className={styles.item}
                onSelect={() => run(resolved ? 'reopen' : 'resolve')}
              >
                <Icon icon={resolved ? RotateCcw : CheckCircle2} size={16} />
                {resolved ? h.reopen : h.resolve}
              </DropdownMenu.Item>
            ) : null}
            {canAssign && !resolved ? (
              <DropdownMenu.Item className={styles.item} onSelect={() => setAssignOpen(true)}>
                <Icon icon={UserRoundCog} size={16} />
                {conversation.assignee ? h.reassign : h.assign}
              </DropdownMenu.Item>
            ) : null}
            {canMoveDepartment ? (
              <DropdownMenu.Item className={styles.item} onSelect={() => setDepartmentOpen(true)}>
                <Icon icon={Building2} size={16} />
                {t.departments.move}
              </DropdownMenu.Item>
            ) : null}
            {canUnassign ? (
              <DropdownMenu.Item className={styles.item} onSelect={() => run('unassign')}>
                <Icon icon={Undo2} size={16} />
                {h.unassign}
              </DropdownMenu.Item>
            ) : null}
            {!withBot && !resolved && (canAssign || mine) ? (
              // Hanya pemegang chat atau yang boleh menugaskan (chat orang lain tidak dioper ke bot
              // diam-diam). Bot channel mati → server menjawab 409 dengan penjelasannya.
              botBlocked ? (
                // Alasan TERBACA di menu (bukan hanya tooltip): bot belum bisa memegang chat.
                <DropdownMenu.Item className={styles.item} disabled>
                  <Icon icon={Bot} size={16} />
                  <span className={styles.itemText}>
                    {h.botResume}
                    <span className={styles.itemReason}>{botBlocked}</span>
                  </span>
                </DropdownMenu.Item>
              ) : (
                <DropdownMenu.Item className={styles.item} onSelect={() => run('botOn')}>
                  <Icon icon={Bot} size={16} />
                  {h.botResume}
                </DropdownMenu.Item>
              )
            ) : null}
            {isDesktop && resolved ? (
              <DropdownMenu.Item className={styles.item} disabled>
                {h.nothing}
              </DropdownMenu.Item>
            ) : null}
          </DropdownMenu.Content>
        </DropdownMenu.Portal>
      </DropdownMenu.Root>
      {canMoveDepartment && departmentOpen ? (
        <DepartmentDialog
          conversation={conversation}
          onCancel={() => setDepartmentOpen(false)}
          onError={onError}
          onClosed={onClosed}
          onDone={() => setDepartmentOpen(false)}
        />
      ) : null}
      {canAssign ? (
        <AssignDialog
          open={assignOpen}
          conversation={conversation}
          pending={busy === 'assign'}
          onCancel={() => setAssignOpen(false)}
          onConfirm={(userId) => mutation.mutate({ action: 'assign', userId })}
        />
      ) : null}
    </>
  );
}

/** Pilih agen sasaran (aktif saja), dengan beban chat yang sedang dipegang. */
function AssignDialog({
  open,
  conversation,
  pending,
  onCancel,
  onConfirm,
}: {
  open: boolean;
  conversation: Conversation;
  pending: boolean;
  onCancel: () => void;
  onConfirm: (userId: string) => void;
}) {
  const agents = useQuery({ ...agentsQuery, enabled: open });
  const [selected, setSelected] = useState('');
  const options = (agents.data?.agents ?? []).filter(
    (agent) => agent.active && agent.id !== conversation.assignee?.id,
  );
  const close = () => {
    setSelected('');
    onCancel();
  };
  return (
    <Dialog
      open={open}
      title={conversation.assignee ? h.reassignTitle : h.assignTitle}
      description={
        conversation.assignee ? h.currentAssignee(conversation.assignee.name) : h.assignBody
      }
      onRequestClose={close}
    >
      {agents.isPending ? (
        <p className={styles.note}>{t.common.loading}</p>
      ) : agents.isError ? (
        <p className={styles.note}>{h.agentsFailed}</p>
      ) : options.length === 0 ? (
        <p className={styles.note}>{h.noAgents}</p>
      ) : (
        <RadioGroup.Root
          className={styles.agents}
          value={selected}
          onValueChange={setSelected}
          aria-label={h.agentsLabel}
        >
          {options.map((agent) => (
            <AgentOption key={agent.id} agent={agent} />
          ))}
        </RadioGroup.Root>
      )}
      <DialogActions>
        <Button onClick={close}>{h.cancel}</Button>
        <Button
          variant="primary"
          disabled={!selected}
          loading={pending}
          onClick={() => onConfirm(selected)}
        >
          {pending ? h.working : h.assignConfirm}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

function AgentOption({ agent }: { agent: InboxAgent }) {
  return (
    <RadioGroup.Item value={agent.id} className={styles.agent}>
      <span className={styles.radio}>
        <RadioGroup.Indicator className={styles.radioDot} />
      </span>
      <span className={styles.agentText}>
        <span className={styles.agentName}>{agent.name}</span>
        <span className={styles.agentRole}>{USER_ROLE_LABELS[agent.role]}</span>
      </span>
      <span className={styles.agentLoad}>{h.load(agent.openConversations)}</span>
    </RadioGroup.Item>
  );
}
