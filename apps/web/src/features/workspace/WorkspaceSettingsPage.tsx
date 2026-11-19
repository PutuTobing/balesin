import {
  ALLOCATION_MODES,
  AUTO_MESSAGE_KINDS,
  AUTO_MESSAGE_TEXT_MAX,
  AUTO_MESSAGE_VARIABLES,
  TEAM_HOLIDAYS_MAX,
  USER_ROLE_LABELS,
  updateWorkspaceSettingsRequestSchema,
  type AllocationAgent,
  type AllocationMode,
  type AutoMessageKind,
  type IdentityConfirmation,
  type TeamHoliday,
  type UpdateWorkspaceSettingsRequest,
  type WorkspaceSettings,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useRef, useState, type FormEvent } from 'react';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { EmptyState } from '../../components/ui/EmptyState';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDate, formatDateTimeInline } from '../../lib/format';
import { zodFieldErrors, type FieldErrors } from '../../lib/form';
import { isConfirmationError, needsConfirmation } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { HoursDays } from '../departments/HoursDays';
import { hoursFormFrom, teamHoursFrom, type HoursDay } from '../departments/team-hours';
import { workspaceAgentsQuery, workspaceKeys, workspaceQuery } from './workspace-queries';
import styles from './Workspace.module.css';

const w = t.workspace;

/**
 * Pengaturan → Jam kerja & alokasi (`settings.workspace.manage`): jam kerja tim + hari libur, cara
 * pembagian chat (ambil sendiri / round-robin + kapasitas), pesan otomatis (sapaan, di luar jam
 * kerja, saat ditangani agen — mengaktifkan/mengubah teks = konfirmasi identitas), dan agen.
 * Setiap bagian disimpan sendiri (`PUT` sebagian).
 */
export function WorkspaceSettingsPage() {
  const settings = useQuery(workspaceQuery);
  return (
    <Page>
      <div className={styles.page}>
        {settings.isPending ? (
          <SkeletonRegion className={styles.card}>
            <Skeleton className={styles.skeletonTitle} />
            <Skeleton className={styles.skeletonLine} />
            <Skeleton className={styles.skeletonLine} />
          </SkeletonRegion>
        ) : settings.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={w.loadFailedTitle}
            body={isApiError(settings.error) ? settings.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void settings.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : (
          <>
            <p className={styles.intro}>
              <StatusBadge
                tone={settings.data.settings.withinTeamHoursNow ? 'success' : 'neutral'}
                label={settings.data.settings.withinTeamHoursNow ? w.nowOpen : w.nowClosed}
              />
              <span>{w.timezone(settings.data.settings.timezone)}</span>
            </p>
            <HoursSection settings={settings.data.settings} />
            <AllocationSection settings={settings.data.settings} />
            <AutoMessagesSection settings={settings.data.settings} />
            <AgentsSection mode={settings.data.settings.allocation.mode} />
          </>
        )}
      </div>
    </Page>
  );
}

/** Simpan sebagian pengaturan; `onSaved` menerima keadaan terbaru. */
function useSaveWorkspace() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (body: UpdateWorkspaceSettingsRequest) => endpoints.workspace.update(body),
    onSuccess: (data) => queryClient.setQueryData(workspaceKeys.settings, data),
  });
}

function SaveRow({ pending, saved, error }: { pending: boolean; saved: boolean; error: unknown }) {
  return (
    <>
      {error ? (
        <Notice tone="danger" role="alert">
          {isApiError(error) ? error.message : t.api.network}
        </Notice>
      ) : saved ? (
        <p className={styles.saved} role="status">
          {w.saved}
        </p>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={pending}>
          {pending ? w.saving : w.save}
        </Button>
      </div>
    </>
  );
}

function HoursSection({ settings }: { settings: WorkspaceSettings }) {
  const save = useSaveWorkspace();
  const [mode, setMode] = useState(settings.teamHours.mode);
  const [days, setDays] = useState<HoursDay[]>(() => hoursFormFrom(settings.teamHours).days);
  const [holidays, setHolidays] = useState<TeamHoliday[]>(settings.holidays);
  const [draft, setDraft] = useState({ date: '', name: '' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const built = mode === 'always' ? null : teamHoursFrom({ custom: true, days });
    if (built && !built.ok) {
      setErrors({ teamHours: built.error });
      return;
    }
    const parsed = updateWorkspaceSettingsRequestSchema.safeParse({
      teamHours: built ? built.hours : { mode: 'always' },
      holidays: [...holidays].sort((a, b) => a.date.localeCompare(b.date)),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(parsed.data, { onSuccess: () => setSaved(true) });
  };

  const addHoliday = () => {
    if (!draft.date || !draft.name.trim()) {
      setErrors({ holiday: !draft.date ? w.holidayDate : w.holidayName });
      return;
    }
    setHolidays((current) => [
      ...current.filter((item) => item.date !== draft.date),
      { date: draft.date, name: draft.name.trim() },
    ]);
    setDraft({ date: '', name: '' });
    setErrors({});
  };

  const hoursError =
    errors.teamHours ?? Object.entries(errors).find(([key]) => key.startsWith('teamHours'))?.[1];
  const holidayError =
    errors.holidays ?? Object.entries(errors).find(([key]) => key.startsWith('holidays'))?.[1];

  return (
    <form className={styles.card} onSubmit={submit} noValidate aria-labelledby="jam-kerja">
      <div>
        <h2 id="jam-kerja" className={styles.cardTitle}>
          {w.hoursTitle}
        </h2>
        <p className={styles.hint}>{w.hoursHint}</p>
      </div>
      <RadioGroup.Root
        className={styles.modes}
        value={mode}
        onValueChange={(value) => setMode(value === 'always' ? 'always' : 'schedule')}
        aria-label={w.hoursTitle}
      >
        {(
          [
            ['schedule', w.hoursSchedule],
            ['always', w.hoursAlways],
          ] as const
        ).map(([value, label]) => (
          <RadioGroup.Item key={value} value={value} className={styles.mode}>
            <span className={styles.radio}>
              <RadioGroup.Indicator className={styles.radioDot} />
            </span>
            {label}
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {mode === 'schedule' ? <HoursDays days={days} onChange={setDays} /> : null}
      {hoursError ? (
        <p className={styles.fieldError} role="alert">
          {hoursError}
        </p>
      ) : null}

      <div className={styles.subSection}>
        <h3 className={styles.subTitle}>{w.holidaysTitle}</h3>
        <p className={styles.hint}>{w.holidaysHint}</p>
        {holidays.length === 0 ? (
          <p className={styles.hint}>{w.holidaysEmpty}</p>
        ) : (
          <ul className={styles.holidays}>
            {[...holidays]
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((holiday) => (
                <li key={holiday.date} className={styles.holiday}>
                  <span className={styles.holidayDate}>
                    {formatDate(`${holiday.date}T00:00:00`)}
                  </span>
                  <span className={styles.holidayName}>{holiday.name}</span>
                  <IconButton
                    label={w.removeHoliday(holiday.name)}
                    icon={Trash2}
                    onClick={() =>
                      setHolidays((current) => current.filter((item) => item.date !== holiday.date))
                    }
                  />
                </li>
              ))}
          </ul>
        )}
        {holidays.length < TEAM_HOLIDAYS_MAX ? (
          <div className={styles.holidayForm}>
            <TextField
              label={w.holidayDate}
              type="date"
              value={draft.date}
              onChange={(event) => setDraft({ ...draft, date: event.target.value })}
            />
            <TextField
              label={w.holidayName}
              placeholder={w.holidayNamePlaceholder}
              value={draft.name}
              onChange={(event) => setDraft({ ...draft, name: event.target.value })}
              maxLength={60}
            />
            <Button onClick={addHoliday} className={styles.holidayAdd}>
              <Icon icon={Plus} size={16} />
              {w.addHoliday}
            </Button>
          </div>
        ) : (
          <p className={styles.hint}>{w.holidaysLimit(TEAM_HOLIDAYS_MAX)}</p>
        )}
        {holidayError || errors.holiday ? (
          <p className={styles.fieldError} role="alert">
            {holidayError ?? errors.holiday}
          </p>
        ) : null}
      </div>
      <SaveRow pending={save.isPending} saved={saved} error={save.error} />
    </form>
  );
}

function AllocationSection({ settings }: { settings: WorkspaceSettings }) {
  const save = useSaveWorkspace();
  const [mode, setMode] = useState<AllocationMode>(settings.allocation.mode);
  const [capacity, setCapacity] = useState(
    settings.allocation.maxOpenPerAgent === null ? '' : String(settings.allocation.maxOpenPerAgent),
  );
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const text = capacity.trim();
    const parsed = updateWorkspaceSettingsRequestSchema.safeParse({
      allocation: {
        mode,
        maxOpenPerAgent: text === '' ? null : /^\d+$/.test(text) ? Number(text) : Number.NaN,
      },
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(parsed.data, { onSuccess: () => setSaved(true) });
  };

  return (
    <form className={styles.card} onSubmit={submit} noValidate aria-labelledby="alokasi">
      <div>
        <h2 id="alokasi" className={styles.cardTitle}>
          {w.allocationTitle}
        </h2>
        <p className={styles.hint}>{w.allocationHint}</p>
      </div>
      <RadioGroup.Root
        className={styles.modes}
        value={mode}
        onValueChange={(value) =>
          setMode(ALLOCATION_MODES.find((item) => item === value) ?? 'manual')
        }
        aria-label={w.allocationTitle}
      >
        {ALLOCATION_MODES.map((value) => (
          <RadioGroup.Item key={value} value={value} className={styles.modeBlock}>
            <span className={styles.radio}>
              <RadioGroup.Indicator className={styles.radioDot} />
            </span>
            <span className={styles.modeText}>
              <span className={styles.modeLabel}>{w.allocationModes[value]}</span>
              <span className={styles.hint}>{w.allocationModeHints[value]}</span>
            </span>
          </RadioGroup.Item>
        ))}
      </RadioGroup.Root>
      {mode === 'round_robin' ? (
        <TextField
          label={w.capacity}
          hint={w.capacityHint}
          optional
          value={capacity}
          onChange={(event) => setCapacity(event.target.value)}
          error={errors['allocation.maxOpenPerAgent']}
          inputMode="numeric"
          maxLength={3}
          className={styles.capacity}
        />
      ) : null}
      <SaveRow pending={save.isPending} saved={saved} error={save.error} />
    </form>
  );
}

function AutoMessagesSection({ settings }: { settings: WorkspaceSettings }) {
  const save = useSaveWorkspace();
  const [values, setValues] = useState(settings.autoMessages);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saved, setSaved] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);

  const body = () => {
    const changed: Partial<Record<AutoMessageKind, { enabled: boolean; text: string }>> = {};
    for (const kind of AUTO_MESSAGE_KINDS) {
      const before = settings.autoMessages[kind];
      const after = values[kind];
      if (before.enabled !== after.enabled || before.text !== after.text) changed[kind] = after;
    }
    return changed;
  };
  /** Mengaktifkan atau mengubah teks (bukan sekadar mematikan) = konfirmasi identitas. */
  const sensitive = (changed: ReturnType<typeof body>) =>
    Object.entries(changed).some(([kind, after]) => {
      const before = settings.autoMessages[kind as AutoMessageKind];
      return after.enabled && (!before.enabled || before.text !== after.text);
    });

  const send = async (confirmation?: IdentityConfirmation) => {
    const changed = body();
    const parsed = updateWorkspaceSettingsRequestSchema.safeParse({
      autoMessages: changed,
      ...(confirmation ? { confirmation } : {}),
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    await save.mutateAsync(parsed.data);
    setSaved(true);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const changed = body();
    if (Object.keys(changed).length === 0) {
      setSaved(true);
      return;
    }
    const parsed = updateWorkspaceSettingsRequestSchema.safeParse({ autoMessages: changed });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    if (sensitive(changed)) {
      setConfirming(true);
      return;
    }
    try {
      await send();
    } catch (caught) {
      if (needsConfirmation(caught)) setConfirming(true);
    }
  };

  // Dialog konfirmasi DI LUAR <form>: form bersarang membuat browser mengirim isian dialog
  // (password, kode) sebagai GET biasa ke URL halaman.
  return (
    <>
      <form
        className={styles.card}
        onSubmit={(event) => void submit(event)}
        noValidate
        aria-labelledby="pesan-otomatis"
      >
        <div>
          <h2 id="pesan-otomatis" className={styles.cardTitle}>
            {w.autoTitle}
          </h2>
          <p className={styles.hint}>{w.autoHint}</p>
        </div>
        {AUTO_MESSAGE_KINDS.map((kind) => {
          const value = values[kind];
          const label = w.autoLabels[kind] ?? kind;
          return (
            <fieldset key={kind} className={styles.autoMessage}>
              <legend className="sr-only">{label}</legend>
              <Checkbox
                checked={value.enabled}
                onChange={(event) =>
                  setValues({ ...values, [kind]: { ...value, enabled: event.target.checked } })
                }
              >
                {w.autoEnabled(label)}
              </Checkbox>
              <TextAreaField
                label={`${w.autoText}: ${label}`}
                hint={w.autoVariables(
                  AUTO_MESSAGE_VARIABLES[kind].map((name) => `{${name}}`).join(', '),
                )}
                value={value.text}
                onChange={(event) =>
                  setValues({ ...values, [kind]: { ...value, text: event.target.value } })
                }
                error={errors[`autoMessages.${kind}.text`]}
                maxLength={AUTO_MESSAGE_TEXT_MAX}
                rows={3}
                dir="auto"
              />
            </fieldset>
          );
        })}
        {save.error && !isConfirmationError(save.error) ? (
          <Notice tone="danger" role="alert">
            {isApiError(save.error) ? save.error.message : t.api.network}
          </Notice>
        ) : saved ? (
          <p className={styles.saved} role="status">
            {w.saved}
          </p>
        ) : null}
        <div className={styles.actions}>
          <Button
            ref={submitRef}
            type="submit"
            variant="primary"
            loading={save.isPending && !confirming}
          >
            {save.isPending && !confirming ? w.saving : w.save}
          </Button>
        </div>
      </form>
      <IdentityDialog
        open={confirming}
        title={w.autoConfirmTitle}
        body={w.autoConfirmBody}
        confirmLabel={w.autoConfirm}
        pendingLabel={w.saving}
        requireCode
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(false)}
        onConfirm={async (confirmation) => {
          try {
            await send(confirmation);
            setConfirming(false);
          } catch (caught) {
            if (isConfirmationError(caught)) throw caught;
            setConfirming(false);
          }
        }}
      />
    </>
  );
}

function AgentsSection({ mode }: { mode: AllocationMode }) {
  const agents = useQuery(workspaceAgentsQuery);
  return (
    <section className={styles.card} aria-labelledby="agen-alokasi">
      <div>
        <h2 id="agen-alokasi" className={styles.cardTitle}>
          {w.agentsTitle}
        </h2>
        <p className={styles.hint}>{w.agentsHint}</p>
      </div>
      {mode === 'manual' ? <Notice tone="info">{w.manualNote}</Notice> : null}
      {agents.isPending ? (
        <SkeletonRegion className={styles.agents}>
          <Skeleton className={styles.skeletonLine} />
          <Skeleton className={styles.skeletonLine} />
        </SkeletonRegion>
      ) : agents.isError ? (
        <Notice
          tone="danger"
          actions={<Button onClick={() => void agents.refetch()}>{t.common.retry}</Button>}
        >
          {w.agentsFailed}
        </Notice>
      ) : agents.data.agents.length === 0 ? (
        <p className={styles.hint}>{w.agentsEmpty}</p>
      ) : (
        <ul className={styles.agents} aria-label={w.agentsLabel}>
          {agents.data.agents.map((agent) => (
            <AgentRow key={agent.userId} agent={agent} />
          ))}
        </ul>
      )}
    </section>
  );
}

function AgentRow({ agent }: { agent: AllocationAgent }) {
  const queryClient = useQueryClient();
  const update = useMutation({
    mutationFn: (patch: { available?: boolean; excluded?: boolean }) =>
      endpoints.workspace.updateAgent(agent.userId, patch),
    onSuccess: () => void queryClient.invalidateQueries({ queryKey: workspaceKeys.agents }),
  });
  return (
    <li className={styles.agent}>
      <div className={styles.agentText}>
        <span className={styles.agentName}>{agent.name}</span>
        <span className={styles.agentMeta}>
          {USER_ROLE_LABELS[agent.role]} · {w.load(agent.openConversations)} ·{' '}
          {agent.lastAssignedAt
            ? w.lastAssigned(formatDateTimeInline(agent.lastAssignedAt))
            : w.neverAssigned}
        </span>
        {update.isError ? (
          <span className={styles.fieldError} role="alert">
            {isApiError(update.error) ? update.error.message : t.api.network}
          </span>
        ) : null}
      </div>
      <div className={styles.agentToggles}>
        <Checkbox
          checked={agent.available}
          disabled={update.isPending}
          onChange={(event) => update.mutate({ available: event.target.checked })}
        >
          {w.available}
          <span className="sr-only">: {agent.name}</span>
        </Checkbox>
        <Checkbox
          checked={agent.excluded}
          disabled={update.isPending}
          onChange={(event) => update.mutate({ excluded: event.target.checked })}
        >
          {w.excluded}
          <span className="sr-only">: {agent.name}</span>
        </Checkbox>
      </div>
    </li>
  );
}
