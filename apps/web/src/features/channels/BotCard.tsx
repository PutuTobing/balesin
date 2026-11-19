import {
  BOT_DAY_LABELS,
  CHANNEL_CAPABILITIES,
  CHANNEL_TYPE_LABELS,
  channelBotSettingsSchema,
  channelHasCustomerWindow,
  type ChannelBotSettings,
  type ChannelType,
} from '@balesin/shared';
import { Link } from '@tanstack/react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { CopyCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { botFormFrom, botSettingsFrom, channelBotKey, type BotForm } from './bot-form';
import styles from './Channels.module.css';

const copy = t.channels.bot;
/** Urutan tampil Senin → Minggu (indeks hari tetap 0 = Minggu). */
const WEEK = [1, 2, 3, 4, 5, 6, 0];

/**
 * Bot di halaman nomor (`integrations.manage`): saklar, jam kerja (24 jam / jadwal per hari di zona
 * organisasi), dan batas waktu menunggu balasan bot — bot aktif SELALU punya batas waktu (tidak
 * ada pilihan "tanpa batas", review bot R1). Tanpa konfirmasi identitas (bisa dibalik kapan saja);
 * mematikan bot meminta persetujuan karena chat yang dipegang bot pindah ke antrian.
 */
export function BotCard({ channelId }: { channelId: string }) {
  const settings = useQuery({
    queryKey: channelBotKey(channelId),
    queryFn: ({ signal }) => endpoints.channels.bot(channelId, signal),
  });
  const data = settings.data?.settings;
  // Klien/data lama tanpa `channelType`: kartu ini dulu hanya di halaman nomor WhatsApp.
  const channelType: ChannelType = data?.channelType ?? 'whatsapp';
  const place = channelType === 'whatsapp' ? copy.placeNumber : copy.placeChannel;
  const status = !data
    ? null
    : !data.enabled
      ? { tone: 'neutral' as const, label: copy.statusOff }
      : data.receiverReady === false
        ? // Tanpa penerima, bot tidak memegang chat apa pun (B1).
          { tone: 'warning' as const, label: copy.statusNoReceiver }
        : data.activeNow
          ? { tone: 'success' as const, label: copy.statusOn }
          : { tone: 'warning' as const, label: copy.statusOutside };

  return (
    <section id="bot" className={styles.card} aria-labelledby="channel-bot">
      <div className={styles.cardHeadRow}>
        <div className={styles.cardHead}>
          <h2 id="channel-bot" className={styles.cardTitle}>
            {copy.title}
          </h2>
          <p className={styles.hint}>{copy.hint(place)}</p>
          {data ? (
            <p className={styles.hint}>
              {/* Template hanya ada di channel yang mendukungnya (WhatsApp); Messenger/IG berjendela
                  tanpa template, Telegram/Email tanpa jendela. */}
              {!channelHasCustomerWindow(channelType)
                ? copy.noWindowNote(CHANNEL_TYPE_LABELS[channelType])
                : CHANNEL_CAPABILITIES[channelType].templates
                  ? copy.windowNote
                  : copy.windowNoteNoTemplate(CHANNEL_TYPE_LABELS[channelType])}
            </p>
          ) : null}
        </div>
        {status ? <StatusBadge tone={status.tone} label={status.label} /> : null}
      </div>
      {data?.enabled && data.receiverReady === false ? (
        // Bot aktif tetapi tidak ada yang menerima event-nya: chat baru tetap ke antrian tim.
        <Notice
          tone="warning"
          title={copy.receiverMissingTitle}
          actions={
            <Button asChild>
              <Link to="/pengaturan/webhook">{copy.openWebhooks}</Link>
            </Button>
          }
        >
          {channelType === 'whatsapp' ? copy.receiverMissingWhatsApp : copy.receiverMissingOther}
        </Notice>
      ) : null}
      {data ? (
        <BotForm
          place={place}
          receiverWarned={data.enabled && data.receiverReady === false}
          receiverReady={data.receiverReady === true}
          channelId={channelId}
          initial={botFormFrom(data)}
          timezone={data.timezone}
          wasEnabled={data.enabled}
        />
      ) : settings.isPending ? (
        <Skeleton className={styles.skeletonInput} />
      ) : (
        <Notice
          tone="danger"
          role="alert"
          title={copy.loadFailed}
          actions={
            <Button onClick={() => void settings.refetch()} loading={settings.isFetching}>
              {t.common.retry}
            </Button>
          }
        >
          {isApiError(settings.error) ? settings.error.message : t.api.network}
        </Notice>
      )}
    </section>
  );
}

function BotForm({
  place,
  receiverWarned,
  receiverReady,
  channelId,
  initial,
  timezone,
  wasEnabled,
}: {
  place: string;
  /** Peringatan "belum ada penerima" sudah tampil di atas: petunjuk umumnya tidak diulang. */
  receiverWarned: boolean;
  /** Penerima bot sudah siap: kalimat positif singkat, bukan syarat umum (BS2). */
  receiverReady: boolean;
  channelId: string;
  initial: BotForm;
  timezone: string;
  wasEnabled: boolean;
}) {
  const queryClient = useQueryClient();
  const [form, setForm] = useState<BotForm>(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [confirmOff, setConfirmOff] = useState<ChannelBotSettings | null>(null);

  const change = (next: Partial<BotForm>) => {
    setForm((current) => ({ ...current, ...next }));
    setSaved(false);
  };
  const changeDay = (day: number, next: Partial<BotForm['days'][number]>) => {
    setForm((current) => ({
      ...current,
      days: current.days.map((item) => (item.day === day ? { ...item, ...next } : item)),
    }));
    setSaved(false);
  };

  const activeDays = form.days.filter((item) => item.on);
  const firstActive = activeDays[0];
  /** Jam hari aktif pertama disalin ke semua hari aktif lain. */
  const copyFirstHours = () => {
    if (!firstActive) return;
    setForm((current) => ({
      ...current,
      days: current.days.map((item) =>
        item.on ? { ...item, start: firstActive.start, end: firstActive.end } : item,
      ),
    }));
    setSaved(false);
  };

  const save = async (body: ChannelBotSettings) => {
    setSaving(true);
    setFailure(null);
    try {
      const response = await endpoints.channels.updateBot(channelId, body);
      queryClient.setQueryData(channelBotKey(channelId), response);
      setForm(botFormFrom(response.settings));
      setSaved(true);
    } catch (caught) {
      if (isApiError(caught) && caught.code === 'VALIDATION_ERROR') {
        setErrors(apiFieldErrors(caught.details));
      } else {
        setFailure(caught);
      }
    } finally {
      setSaving(false);
    }
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setSaved(false);
    const built = botSettingsFrom(form);
    const nextErrors: FieldErrors = {};
    if (built.timeoutInvalid) nextErrors.timeoutMinutes = copy.timeoutInvalid;
    if (built.noDay) nextErrors.hours = copy.noDay;
    const parsed = channelBotSettingsSchema.safeParse(built.settings);
    if (!parsed.success || Object.keys(nextErrors).length > 0) {
      setErrors({ ...(parsed.success ? {} : zodFieldErrors(parsed.error)), ...nextErrors });
      return;
    }
    setErrors({});
    if (wasEnabled && !parsed.data.enabled) {
      setConfirmOff(parsed.data);
      return;
    }
    void save(parsed.data);
  };

  const hoursError =
    errors.hours ?? Object.entries(errors).find(([key]) => key.startsWith('hours'))?.[1];

  return (
    <form className={styles.form} onSubmit={submit} noValidate>
      <Checkbox
        checked={form.enabled}
        onChange={(event) => change({ enabled: event.target.checked })}
      >
        {copy.enable(place)}
      </Checkbox>
      {form.enabled ? (
        <>
          {receiverWarned ? null : (
            <p className={styles.hint}>{receiverReady ? copy.receiverReady : copy.noReceiver}</p>
          )}
          <fieldset className={styles.botFieldset}>
            <legend className={styles.botLegend}>{copy.hoursLabel}</legend>
            <div className={styles.botModes} role="radiogroup" aria-label={copy.hoursLabel}>
              {(['always', 'schedule'] as const).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  role="radio"
                  aria-checked={form.mode === mode}
                  className={styles.botMode}
                  onClick={() => change({ mode })}
                >
                  {mode === 'always' ? copy.always : copy.schedule}
                </button>
              ))}
            </div>
            {form.mode === 'schedule' ? (
              <>
                <p className={styles.hint}>{copy.timezone(timezone)}</p>
                <div className={styles.botSchedule}>
                  {/* Judul kolom sekali saja; tiap isian jam punya label sendiri untuk pembaca layar. */}
                  <div className={styles.botScheduleHead} aria-hidden="true">
                    <span>{copy.day}</span>
                    <span>{copy.start}</span>
                    <span />
                    <span>{copy.end}</span>
                  </div>
                  <ul className={styles.botDays}>
                    {WEEK.map((day) => {
                      const item = form.days.find((entry) => entry.day === day)!;
                      const label = BOT_DAY_LABELS[day] ?? '';
                      return (
                        <li key={day} className={styles.botDay}>
                          <Checkbox
                            checked={item.on}
                            onChange={(event) => changeDay(day, { on: event.target.checked })}
                            aria-label={copy.dayOn(label)}
                            className={styles.botDayCheck}
                          >
                            {label}
                          </Checkbox>
                          {item.on ? (
                            <>
                              <input
                                type="time"
                                value={item.start}
                                onChange={(event) => changeDay(day, { start: event.target.value })}
                                aria-label={copy.startOf(label)}
                                className={styles.botTime}
                              />
                              <span className={styles.botDash} aria-hidden="true">
                                –
                              </span>
                              <input
                                type="time"
                                value={item.end}
                                onChange={(event) => changeDay(day, { end: event.target.value })}
                                aria-label={copy.endOf(label)}
                                className={styles.botTime}
                              />
                            </>
                          ) : (
                            <span className={styles.botOff}>{copy.dayOff}</span>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                  {activeDays.length >= 2 ? (
                    <Button variant="ghost" className={styles.botCopy} onClick={copyFirstHours}>
                      <Icon icon={CopyCheck} size={16} />
                      {copy.copyHours}
                    </Button>
                  ) : null}
                </div>
              </>
            ) : null}
            {hoursError ? (
              <p className={styles.fieldError} role="alert">
                {hoursError}
              </p>
            ) : null}
          </fieldset>
          <TextField
            label={copy.timeoutLabel}
            hint={copy.timeoutHint}
            value={form.timeout}
            onChange={(event) => change({ timeout: event.target.value })}
            error={errors.timeoutMinutes}
            inputMode="numeric"
            maxLength={4}
            className={styles.botTimeout}
          />
        </>
      ) : null}
      {saved ? (
        <Notice tone="success" role="status">
          {copy.saved}
        </Notice>
      ) : null}
      {failure ? (
        <Notice tone="danger" role="alert">
          {isApiError(failure) ? failure.message : t.api.network}
        </Notice>
      ) : null}
      <div className={styles.actions}>
        <Button type="submit" variant="primary" loading={saving}>
          {saving ? copy.saving : copy.save}
        </Button>
      </div>
      <ConfirmDialog
        open={confirmOff !== null}
        title={copy.disableTitle(place)}
        body={copy.disableBody(place)}
        cancelLabel={copy.cancel}
        confirmLabel={copy.disableConfirm}
        confirmVariant="danger"
        onCancel={() => setConfirmOff(null)}
        onConfirm={() => {
          const body = confirmOff;
          setConfirmOff(null);
          if (body) void save(body);
        }}
      />
    </form>
  );
}
