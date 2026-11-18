import {
  BOT_DAY_LABELS,
  DEPARTMENTS_PER_ORGANIZATION_MAX,
  DEPARTMENT_DESCRIPTION_MAX,
  DEPARTMENT_NAME_MAX,
  USER_ROLE_LABELS,
  createDepartmentRequestSchema,
  updateDepartmentRequestSchema,
  type DepartmentDetail,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Pencil, Plus, Trash2 } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useState, type FormEvent } from 'react';
import { ZodError } from 'zod';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { EmptyState } from '../../components/ui/EmptyState';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { inboxChannelsQuery } from '../inbox/inbox-queries';
import { departmentKeys, departmentSettingsQuery } from './department-queries';
import { hoursFormFrom, hoursSummary, teamHoursFrom, type HoursForm } from './team-hours';
import styles from './Departments.module.css';

const d = t.departments;

/** Jam kerja tim tidak sah (diperiksa sebelum dikirim). */
class HoursError extends Error {}

/**
 * Pengaturan → Departemen (`settings.workspace.manage`): daftar + anggota (tanda "hanya departemen
 * ini"), channel bawaan, jam kerja tim khusus; tambah/ubah/hapus. Anggota diatur per pengguna dari
 * Pengaturan → Tim (konfirmasi identitas bila melonggarkan akses).
 */
export function DepartmentsPage() {
  const queryClient = useQueryClient();
  const list = useQuery(departmentSettingsQuery);
  const channels = useQuery(inboxChannelsQuery);
  const [editing, setEditing] = useState<DepartmentDetail | 'new' | null>(null);
  const [removing, setRemoving] = useState<DepartmentDetail | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const refresh = () => void queryClient.invalidateQueries({ queryKey: departmentKeys.all });

  const remove = useMutation({
    mutationFn: (department: DepartmentDetail) => endpoints.departments.remove(department.id),
    onMutate: () => setNotice(null),
    onSuccess: () => {
      setRemoving(null);
      setNotice(d.removed);
      refresh();
    },
    onError: () => setRemoving(null),
  });

  const departments = list.data?.departments ?? [];
  const channelName = (id: string) =>
    channels.data?.channels.find((channel) => channel.id === id)?.name ?? null;
  const add = (
    <Button variant="primary" onClick={() => setEditing('new')}>
      <Icon icon={Plus} size={16} />
      {d.add}
    </Button>
  );

  return (
    <Page>
      <div className={styles.page}>
        <p className={styles.intro}>{d.intro}</p>
        {notice ? (
          <Notice tone="success" role="status">
            {notice}
          </Notice>
        ) : null}
        {remove.isError ? (
          <Notice tone="danger" role="alert">
            {isApiError(remove.error) ? remove.error.message : t.api.network}
          </Notice>
        ) : null}
        {list.isPending ? (
          <SkeletonRegion className={styles.list}>
            {[0, 1].map((index) => (
              <div key={index} className={styles.card}>
                <Skeleton className={styles.skeletonTitle} />
                <Skeleton className={styles.skeletonLine} />
              </div>
            ))}
          </SkeletonRegion>
        ) : list.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={d.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : departments.length === 0 ? (
          <EmptyState title={d.emptyTitle} body={d.emptyBody} actions={add} />
        ) : (
          <>
            <ul className={styles.list} aria-label={d.listLabel}>
              {departments.map((department) => {
                const defaults = department.defaultChannelIds
                  .map(channelName)
                  .filter((name): name is string => name !== null);
                return (
                  <li key={department.id} className={styles.card}>
                    <div className={styles.cardHead}>
                      <div className={styles.cardText}>
                        <h2 className={styles.cardTitle}>{department.name}</h2>
                        {department.description ? (
                          <p className={styles.hint}>{department.description}</p>
                        ) : null}
                      </div>
                      <div className={styles.cardActions}>
                        <IconButton
                          label={d.edit(department.name)}
                          icon={Pencil}
                          onClick={() => setEditing(department)}
                        />
                        <IconButton
                          label={d.remove(department.name)}
                          icon={Trash2}
                          className={styles.danger}
                          onClick={() => setRemoving(department)}
                        />
                      </div>
                    </div>
                    <dl className={styles.facts}>
                      <dt>{d.members(department.members.length)}</dt>
                      <dd>
                        {department.members.length === 0 ? (
                          <span className={styles.muted}>—</span>
                        ) : (
                          <ul className={styles.members}>
                            {department.members.map((member) => (
                              <li key={member.id}>
                                <Link
                                  to="/pengaturan/tim/$userId"
                                  params={{ userId: member.id }}
                                  className={styles.member}
                                >
                                  {member.name}
                                  <span className={styles.memberRole}>
                                    {USER_ROLE_LABELS[member.role]}
                                  </span>
                                  {member.restricted ? (
                                    <span className={styles.restricted}>{d.restrictedBadge}</span>
                                  ) : null}
                                </Link>
                              </li>
                            ))}
                          </ul>
                        )}
                      </dd>
                      <dt>{d.defaultChannels}</dt>
                      <dd>
                        {defaults.length > 0 ? (
                          defaults.join(', ')
                        ) : (
                          <span className={styles.muted}>{d.noDefaultChannels}</span>
                        )}
                      </dd>
                      <dt>{d.hours}</dt>
                      <dd>{hoursSummary(department.teamHours ?? null)}</dd>
                    </dl>
                  </li>
                );
              })}
            </ul>
            <p className={styles.hint}>{d.membersNote}</p>
            {departments.length < DEPARTMENTS_PER_ORGANIZATION_MAX ? (
              <div className={styles.footer}>{add}</div>
            ) : null}
          </>
        )}
      </div>
      {editing ? (
        <DepartmentDialog
          department={editing === 'new' ? null : editing}
          channels={channels.data?.channels ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            setNotice(d.saved);
            refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={removing ? d.removeTitle(removing.name) : ''}
        body={d.removeBody}
        cancelLabel={d.cancel}
        confirmLabel={d.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </Page>
  );
}

function DepartmentDialog({
  department,
  channels,
  onClose,
  onSaved,
}: {
  department: DepartmentDetail | null;
  channels: readonly { id: string; name: string }[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(department?.name ?? '');
  const [description, setDescription] = useState(department?.description ?? '');
  const [channelIds, setChannelIds] = useState<string[]>(department?.defaultChannelIds ?? []);
  const [hours, setHours] = useState<HoursForm>(() => hoursFormFrom(department?.teamHours ?? null));
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: async () => {
      const builtHours = teamHoursFrom(hours);
      if (!builtHours.ok) throw new HoursError(builtHours.error);
      const values = {
        name,
        description: description.trim() ? description : null,
        defaultChannelIds: channelIds,
      };
      if (department) {
        const parsed = updateDepartmentRequestSchema.safeParse({
          ...values,
          teamHours: builtHours.hours,
        });
        if (!parsed.success) throw parsed.error;
        return endpoints.departments.update(department.id, parsed.data);
      }
      const parsed = createDepartmentRequestSchema.safeParse(values);
      if (!parsed.success) throw parsed.error;
      const created = await endpoints.departments.create(parsed.data);
      // Jam kerja khusus diatur lewat PATCH (POST tidak menerimanya).
      if (builtHours.hours) {
        return endpoints.departments.update(created.department.id, {
          teamHours: builtHours.hours,
        });
      }
      return created;
    },
    onSuccess: onSaved,
    onError: (error) => {
      if (error instanceof HoursError) setErrors({ teamHours: error.message });
      else if (error instanceof ZodError) setErrors(zodFieldErrors(error));
      else if (isApiError(error) && error.details.length > 0)
        setErrors(apiFieldErrors(error.details));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    save.mutate();
  };
  const general =
    save.isError && isApiError(save.error) && save.error.details.length === 0 ? save.error : null;
  const hoursError =
    errors.teamHours ?? Object.entries(errors).find(([key]) => key.startsWith('teamHours'))?.[1];

  return (
    <Dialog
      open
      title={department ? d.editTitle(department.name) : d.createTitle}
      onRequestClose={onClose}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        <TextField
          label={d.name}
          value={name}
          onChange={(event) => setName(event.target.value)}
          error={errors.name}
          maxLength={DEPARTMENT_NAME_MAX}
          autoComplete="off"
        />
        <TextAreaField
          label={d.description}
          optional
          value={description}
          onChange={(event) => setDescription(event.target.value)}
          error={errors.description}
          maxLength={DEPARTMENT_DESCRIPTION_MAX}
          rows={2}
        />
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{d.channelsLegend}</legend>
          <p className={styles.hint}>{d.channelsHint}</p>
          {channels.length === 0 ? (
            <p className={styles.hint}>{d.channelsEmpty}</p>
          ) : (
            channels.map((channel) => (
              <Checkbox
                key={channel.id}
                checked={channelIds.includes(channel.id)}
                onChange={(event) =>
                  setChannelIds((current) =>
                    event.target.checked
                      ? [...current, channel.id]
                      : current.filter((id) => id !== channel.id),
                  )
                }
              >
                {channel.name}
              </Checkbox>
            ))
          )}
        </fieldset>
        <fieldset className={styles.fieldset}>
          <legend className={styles.legend}>{d.hoursLegend}</legend>
          <p className={styles.hint}>{d.hoursHint}</p>
          <RadioGroup.Root
            className={styles.modes}
            value={hours.custom ? 'custom' : 'organization'}
            onValueChange={(value) => setHours({ ...hours, custom: value === 'custom' })}
            aria-label={d.hoursLegend}
          >
            {(
              [
                ['organization', d.hoursOrganization],
                ['custom', d.hoursCustom],
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
          {hours.custom ? (
            <div className={styles.days}>
              {hours.days.map((item, index) => {
                const label = BOT_DAY_LABELS[item.day] ?? '';
                const patch = (next: Partial<typeof item>) =>
                  setHours({
                    ...hours,
                    days: hours.days.map((day, position) =>
                      position === index ? { ...day, ...next } : day,
                    ),
                  });
                return (
                  <div key={item.day} className={styles.day}>
                    <Checkbox
                      checked={item.on}
                      onChange={(event) => patch({ on: event.target.checked })}
                      className={styles.dayToggle}
                    >
                      {label}
                    </Checkbox>
                    <input
                      type="time"
                      className={styles.time}
                      value={item.start}
                      onChange={(event) => patch({ start: event.target.value })}
                      disabled={!item.on}
                      aria-label={d.start(label)}
                    />
                    <span aria-hidden="true" className={styles.muted}>
                      –
                    </span>
                    <input
                      type="time"
                      className={styles.time}
                      value={item.end}
                      onChange={(event) => patch({ end: event.target.value })}
                      disabled={!item.on}
                      aria-label={d.end(label)}
                    />
                  </div>
                );
              })}
            </div>
          ) : null}
          {hoursError ? (
            <p className={styles.fieldError} role="alert">
              {hoursError}
            </p>
          ) : null}
        </fieldset>
        {general ? (
          <Notice tone="danger" role="alert">
            {general.message}
          </Notice>
        ) : save.isError &&
          !isApiError(save.error) &&
          !(save.error instanceof HoursError) &&
          !('issues' in save.error) ? (
          <Notice tone="danger" role="alert">
            {t.api.network}
          </Notice>
        ) : null}
        <DialogActions sticky>
          <Button onClick={onClose}>{d.cancel}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {save.isPending ? d.saving : d.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
