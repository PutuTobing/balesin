import {
  BROADCAST_IMPORT_ISSUE_LABELS,
  BROADCAST_LIMITS,
  type BroadcastCampaign,
  type BroadcastImportIssue,
  type BroadcastImportReport,
  type BroadcastMapping,
  type BroadcastSourceKind,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate } from '@tanstack/react-router';
import { Check, Plus, Trash2, Upload } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { SelectField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { useCan, useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { inboxChannelsQuery, tagsQuery } from '../inbox/inbox-queries';
import { approvedTemplatesQuery, templateQuery } from '../templates/template-queries';
import { TemplateBubble } from '../templates/TemplateBubble';
import {
  guessMapping,
  isoToZoned,
  mappingComplete,
  mappingSlots,
  slotSource,
  usableForBroadcast,
  withSlot,
  zonedToIso,
  type MappingSlot,
} from './broadcast-logic';
import {
  broadcastKeys,
  connectorOptionsQuery,
  setBroadcastFlash,
  storeBroadcast,
} from './broadcast-queries';
import styles from './Broadcast.module.css';

const b = t.broadcast;
const STEPS = ['basics', 'recipients', 'variables', 'send'] as const;
/** Nilai pilihan "teks tetap" di daftar sumber variabel (bukan nama kolom). */
const TEXT_SOURCE = '__teks_tetap__';
type Step = (typeof STEPS)[number];

function firstOpenStep(campaign: BroadcastCampaign | null): Step {
  if (!campaign?.template) return 'basics';
  if (campaign.counts.recipients === 0) return 'recipients';
  return 'variables';
}

/**
 * Wizard kampanye: dasar (nama, nomor, template) → penerima (unggah CSV/XLSX, segmen tag/atribut,
 * konektor) → isi variabel + pratinjau → jadwal, kecepatan, anti-dobel, tag otomatis, perkiraan
 * biaya → Ajukan (konfirmasi identitas). Draf disimpan di server sejak langkah pertama.
 */
export function BroadcastWizard({ campaign }: { campaign: BroadcastCampaign | null }) {
  const [step, setStep] = useState<Step>(() => firstOpenStep(campaign));
  const index = STEPS.indexOf(step);
  const reachable = (target: Step) => {
    if (!campaign) return target === 'basics';
    if (target === 'basics' || target === 'recipients') return campaign.template !== null;
    return campaign.counts.recipients > 0;
  };
  return (
    // Judul tetap "Kampanye baru" sampai diajukan (review broadcast BC-S4).
    <Page title={b.newTitle}>
      <div className={styles.wizard}>
        <ol className={styles.steps} aria-label={b.stepsLabel}>
          {STEPS.map((item, position) => {
            const current = item === step;
            const done = position < index;
            return (
              <li key={item}>
                <button
                  type="button"
                  className={styles.step}
                  data-state={current ? 'current' : done ? 'done' : 'todo'}
                  aria-current={current ? 'step' : undefined}
                  disabled={!current && !reachable(item)}
                  onClick={() => setStep(item)}
                >
                  <span className={styles.stepNumber} aria-hidden="true">
                    {done ? <Icon icon={Check} size={16} /> : position + 1}
                  </span>
                  <span className={styles.stepLabel}>{b.steps[item]}</span>
                </button>
              </li>
            );
          })}
        </ol>
        <p className={styles.stepOf}>{b.stepOf(index + 1, STEPS.length)}</p>
        {step === 'basics' ? (
          <StepBasics campaign={campaign} onDone={() => setStep('recipients')} />
        ) : campaign ? (
          step === 'recipients' ? (
            <StepRecipients
              campaign={campaign}
              onBack={() => setStep('basics')}
              onDone={() => setStep('variables')}
            />
          ) : step === 'variables' ? (
            <StepVariables
              campaign={campaign}
              onBack={() => setStep('recipients')}
              onDone={() => setStep('send')}
            />
          ) : (
            <StepSend campaign={campaign} onBack={() => setStep('variables')} />
          )
        ) : null}
        {campaign ? <DeleteDraft campaign={campaign} /> : null}
      </div>
    </Page>
  );
}

function Failure({ error }: { error: unknown }) {
  if (!error) return null;
  return (
    <Notice tone="danger" role="alert">
      {isApiError(error) ? error.message : error instanceof Error ? error.message : t.api.network}
    </Notice>
  );
}

// ── 1. Dasar ────────────────────────────────────────────────────────────────

function StepBasics({
  campaign,
  onDone,
}: {
  campaign: BroadcastCampaign | null;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const canTemplates = useCan('templates.manage');
  const channels = useQuery(inboxChannelsQuery);
  const senders = (channels.data?.channels ?? []).filter(
    (channel) => channel.type === 'whatsapp' && channel.enabled,
  );
  const [name, setName] = useState(campaign?.name ?? '');
  const [channelId, setChannelId] = useState(campaign?.channel.id ?? '');
  // Nomor bawaan = nomor pertama yang PUNYA template siap broadcast (audit akhir QA R3), bukan
  // sekadar nomor pertama — supaya pengguna tidak langsung disambut "belum ada template".
  const candidates = useQueries({
    queries: channelId ? [] : senders.map((channel) => approvedTemplatesQuery(channel.id)),
  });
  const choosingDefault = !channelId && candidates.some((query) => query.isPending);
  const defaultSender =
    senders.find((_, index) => (candidates[index]?.data?.templates ?? []).some(usableForBroadcast))
      ?.id ??
    senders[0]?.id ??
    '';
  const sender = channelId || (choosingDefault ? '' : defaultSender);
  const templates = useQuery({ ...approvedTemplatesQuery(sender), enabled: sender !== '' });
  const usable = (templates.data?.templates ?? []).filter(usableForBroadcast);
  const [templateId, setTemplateId] = useState(campaign?.template?.id ?? '');
  const chosenTemplate = templateId || usable[0]?.id || '';
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [saving, setSaving] = useState(false);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = 'Nama kampanye wajib diisi.';
    if (!chosenTemplate) problems.templateId = b.noTemplates;
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    try {
      if (!campaign) {
        const { broadcast } = await endpoints.broadcasts.create({
          name: name.trim(),
          channelId: sender,
          templateId: chosenTemplate,
        });
        storeBroadcast(queryClient, broadcast);
        void navigate({
          to: '/broadcast/$broadcastId',
          params: { broadcastId: broadcast.id },
          replace: true,
        });
        return;
      }
      const changes = {
        ...(name.trim() !== campaign.name ? { name: name.trim() } : {}),
        ...(chosenTemplate !== campaign.template?.id ? { templateId: chosenTemplate } : {}),
      };
      if (Object.keys(changes).length > 0) {
        const { broadcast } = await endpoints.broadcasts.update(campaign.id, changes);
        storeBroadcast(queryClient, broadcast);
      }
      onDone();
    } catch (caught) {
      if (isApiError(caught) && caught.details.length > 0) {
        setErrors(
          Object.fromEntries(caught.details.map((detail) => [detail.field, detail.message])),
        );
      } else {
        setFailure(caught);
      }
    } finally {
      setSaving(false);
    }
  };

  return (
    <form className={styles.card} onSubmit={(event) => void submit(event)} noValidate>
      <h2 className={styles.cardTitle}>{b.steps.basics}</h2>
      <TextField
        label={b.nameLabel}
        hint={b.nameHint}
        value={name}
        onChange={(event) => setName(event.target.value)}
        error={errors.name}
        maxLength={80}
      />
      {channels.isSuccess && senders.length === 0 ? (
        <Notice tone="warning" role="status">
          {b.noChannel}
        </Notice>
      ) : choosingDefault || channels.isPending ? (
        <Skeleton className={styles.skeletonField} />
      ) : campaign ? (
        <p className={styles.fact}>
          <span className={styles.factLabel}>{b.channelLabel}</span>
          <span>{campaign.channel.name}</span>
        </p>
      ) : (
        <SelectField
          label={b.channelLabel}
          value={sender}
          onChange={(event) => {
            setChannelId(event.target.value);
            setTemplateId('');
          }}
          options={senders.map((channel) => ({
            value: channel.id,
            label: channel.displayPhoneNumber
              ? `${channel.name} · ${channel.displayPhoneNumber}`
              : channel.name,
          }))}
        />
      )}
      {(templates.isPending && sender) || choosingDefault || channels.isPending ? (
        <Skeleton className={styles.skeletonField} />
      ) : usable.length === 0 ? (
        <Notice
          tone="warning"
          role="status"
          actions={
            canTemplates ? (
              <Link to="/pengaturan/template" className={styles.noticeLink}>
                {b.manageTemplates}
              </Link>
            ) : undefined
          }
        >
          {b.noTemplates}
        </Notice>
      ) : (
        <SelectField
          label={b.templateLabel}
          hint={
            campaign?.template && chosenTemplate !== campaign.template.id
              ? b.templateChangeWarning
              : b.templateHint
          }
          value={chosenTemplate}
          onChange={(event) => setTemplateId(event.target.value)}
          error={errors.templateId}
          options={usable.map((template) => ({
            value: template.id,
            label: `${template.name} · ${t.templates.categoryShort[template.category]}`,
          }))}
        />
      )}
      <Failure error={failure} />
      <div className={styles.stepActions}>
        <Button type="submit" variant="primary" loading={saving} disabled={!sender}>
          {saving ? b.saving : b.next}
        </Button>
      </div>
    </form>
  );
}

// ── 2. Penerima ─────────────────────────────────────────────────────────────

/**
 * Hasil pemeriksaan berkas: SATU daftar per penyebab (review broadcast BC3) — jumlah baris,
 * penyebabnya, lalu maksimal 3 nomor baris contoh + "dan n lainnya".
 */
function ImportReport({ report }: { report: BroadcastImportReport }) {
  const causes = (Object.entries(report.issueCounts) as [BroadcastImportIssue, number][]).filter(
    ([, count]) => count > 0,
  );
  return (
    <section className={styles.report} aria-label={b.reportTitle}>
      <p className={styles.reportSummary}>
        <Icon icon={Check} size={16} />
        {b.reportSummary(report.recipients, report.sourceRows)}
      </p>
      {report.rejectedRows > 0 ? (
        <>
          <p className={styles.hint}>{b.rejectedRows(report.rejectedRows)}</p>
          <ul className={styles.causes}>
            {causes.map(([issue, count]) => {
              const rows = report.issues
                .filter((item) => item.issue === issue)
                .map((item) => item.row);
              const shown = rows.slice(0, 3);
              return (
                <li key={issue} className={styles.cause}>
                  <span className={styles.causeCount}>{b.issueCount(count)}</span>
                  <span className={styles.causeText}>
                    <span>{BROADCAST_IMPORT_ISSUE_LABELS[issue]}</span>
                    {shown.length > 0 ? (
                      <span className={styles.causeRows}>
                        {b.issueRows(shown.join(', '), count - shown.length)}
                      </span>
                    ) : null}
                  </span>
                </li>
              );
            })}
          </ul>
        </>
      ) : null}
    </section>
  );
}

function StepRecipients({
  campaign,
  onBack,
  onDone,
}: {
  campaign: BroadcastCampaign;
  onBack: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<BroadcastSourceKind>(campaign.source?.kind ?? 'upload');
  const [report, setReport] = useState<BroadcastImportReport | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [phoneColumn, setPhoneColumn] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const tags = useQuery(tagsQuery);
  const [tagIds, setTagIds] = useState<string[]>([]);
  const [tagMatch, setTagMatch] = useState<'any' | 'all'>('any');
  const [attributes, setAttributes] = useState<{ key: string; value: string }[]>([]);
  const [segmentError, setSegmentError] = useState<string | null>(null);
  const connectors = useQuery({ ...connectorOptionsQuery, enabled: kind === 'connector' });
  const [connectorId, setConnectorId] = useState('');

  const run = async (
    action: () => Promise<{ broadcast: BroadcastCampaign; report: BroadcastImportReport }>,
  ) => {
    setBusy(true);
    setFailure(null);
    try {
      const result = await action();
      storeBroadcast(queryClient, result.broadcast);
      setReport(result.report);
      setPhoneColumn(result.report.phoneColumn);
    } catch (caught) {
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };

  const upload = (picked: File, column?: string) =>
    void run(() => endpoints.broadcasts.upload(campaign.id, picked, column));

  const applySegment = () => {
    const filled = attributes.filter((item) => item.key.trim() && item.value.trim());
    if (tagIds.length === 0 && filled.length === 0) {
      setSegmentError(b.segmentEmpty);
      return;
    }
    setSegmentError(null);
    void run(() =>
      endpoints.broadcasts.segment(campaign.id, { tagIds, tagMatch, attributes: filled }),
    );
  };

  const chosenConnector = connectorId || connectors.data?.connectors[0]?.id || '';

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{b.sourceTitle}</h2>
      {campaign.source ? (
        <p className={styles.current}>
          {b.currentSource(campaign.source.label, campaign.counts.recipients)}
        </p>
      ) : null}
      <div
        className={cx(styles.segments, styles.segmentsStack)}
        role="radiogroup"
        aria-label={b.sourceTitle}
      >
        {(['upload', 'segment', 'connector'] as const).map((value) => (
          <button
            key={value}
            type="button"
            role="radio"
            aria-checked={kind === value}
            className={styles.segment}
            onClick={() => setKind(value)}
          >
            {b.sources[value]}
          </button>
        ))}
      </div>
      {campaign.source ? <p className={styles.hint}>{b.replaceSource}</p> : null}

      {kind === 'upload' ? (
        <div className={styles.group}>
          <p className={styles.hint}>{b.uploadHint}</p>
          <input
            ref={fileRef}
            type="file"
            accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
            className="sr-only"
            tabIndex={-1}
            aria-hidden="true"
            data-testid="broadcast-file"
            onChange={(event) => {
              const picked = event.target.files?.[0];
              event.target.value = '';
              if (!picked) return;
              setFile(picked);
              upload(picked);
            }}
          />
          <div className={styles.inline}>
            <Button loading={busy} onClick={() => fileRef.current?.click()}>
              {busy ? null : <Icon icon={Upload} size={16} />}
              {busy ? b.uploading : b.pickFile}
            </Button>
            {file ? <span className={styles.fileName}>{file.name}</span> : null}
          </div>
          {report && file && report.columns.length > 1 ? (
            <div className={styles.inlineField}>
              <SelectField
                label={b.phoneColumnLabel}
                hint={b.phoneColumnHint}
                value={phoneColumn}
                onChange={(event) => setPhoneColumn(event.target.value)}
                options={report.columns.map((column) => ({ value: column, label: column }))}
              />
              {phoneColumn !== report.phoneColumn ? (
                <Button disabled={busy} onClick={() => upload(file, phoneColumn)}>
                  {b.reupload}
                </Button>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : kind === 'segment' ? (
        <div className={styles.group}>
          <fieldset className={styles.fieldset}>
            <legend className={styles.groupLabel}>{b.tagsLabel}</legend>
            {tags.data && tags.data.tags.length === 0 ? (
              <p className={styles.hint}>{b.noTags}</p>
            ) : (
              <div className={styles.tagGrid}>
                {(tags.data?.tags ?? []).map((tag) => (
                  <Checkbox
                    key={tag.id}
                    checked={tagIds.includes(tag.id)}
                    onChange={(event) =>
                      setTagIds((current) =>
                        event.target.checked
                          ? [...current, tag.id].slice(0, 10)
                          : current.filter((id) => id !== tag.id),
                      )
                    }
                  >
                    {tag.name}
                  </Checkbox>
                ))}
              </div>
            )}
            {tagIds.length > 1 ? (
              <div className={styles.segments} role="radiogroup" aria-label={b.tagsLabel}>
                {(['any', 'all'] as const).map((value) => (
                  <button
                    key={value}
                    type="button"
                    role="radio"
                    aria-checked={tagMatch === value}
                    className={styles.segment}
                    onClick={() => setTagMatch(value)}
                  >
                    {b.tagMatch[value]}
                  </button>
                ))}
              </div>
            ) : null}
          </fieldset>
          <fieldset className={styles.fieldset}>
            <legend className={styles.groupLabel}>{b.attributesLabel}</legend>
            {attributes.map((attribute, position) => (
              <div key={position} className={styles.attributeRow}>
                <TextField
                  label={b.attributeKey(position + 1)}
                  value={attribute.key}
                  onChange={(event) =>
                    setAttributes((current) =>
                      current.map((item, i) =>
                        i === position ? { ...item, key: event.target.value } : item,
                      ),
                    )
                  }
                  maxLength={64}
                />
                <TextField
                  label={b.attributeValue(position + 1)}
                  value={attribute.value}
                  onChange={(event) =>
                    setAttributes((current) =>
                      current.map((item, i) =>
                        i === position ? { ...item, value: event.target.value } : item,
                      ),
                    )
                  }
                  maxLength={500}
                />
                <IconButton
                  label={b.removeAttribute(position + 1)}
                  icon={Trash2}
                  onClick={() =>
                    setAttributes((current) => current.filter((_, i) => i !== position))
                  }
                />
              </div>
            ))}
            {attributes.length < 5 ? (
              <Button
                variant="ghost"
                className={styles.alignStart}
                onClick={() => setAttributes((current) => [...current, { key: '', value: '' }])}
              >
                <Icon icon={Plus} size={16} />
                {b.addAttribute}
              </Button>
            ) : null}
          </fieldset>
          {segmentError ? (
            <p className={styles.fieldError} role="alert">
              {segmentError}
            </p>
          ) : null}
          <Button className={styles.alignStart} loading={busy} onClick={applySegment}>
            {busy ? b.applying : b.segmentApply}
          </Button>
        </div>
      ) : (
        <div className={styles.group}>
          {connectors.data && connectors.data.connectors.length === 0 ? (
            <p className={styles.hint}>{b.noConnectors}</p>
          ) : (
            <div className={styles.inlineField}>
              <SelectField
                label={b.connectorLabel}
                value={chosenConnector}
                onChange={(event) => setConnectorId(event.target.value)}
                options={(connectors.data?.connectors ?? []).map((item) => ({
                  value: item.id,
                  label: item.name,
                }))}
              />
              <Button
                loading={busy}
                disabled={!chosenConnector}
                onClick={() =>
                  void run(() => endpoints.broadcasts.fromConnector(campaign.id, chosenConnector))
                }
              >
                {busy ? b.applying : b.connectorApply}
              </Button>
            </div>
          )}
        </div>
      )}

      {report ? <ImportReport report={report} /> : null}
      <Failure error={failure} />
      <div className={styles.stepActions}>
        <Button onClick={onBack}>{b.back}</Button>
        <Button
          variant="primary"
          disabled={busy || campaign.counts.recipients === 0}
          onClick={onDone}
        >
          {b.next}
        </Button>
      </div>
      {campaign.counts.recipients === 0 && !busy ? (
        <p className={styles.hint}>{b.needRecipients}</p>
      ) : null}
    </div>
  );
}

// ── 3. Isi variabel + pratinjau ─────────────────────────────────────────────

function slotLabel(slot: MappingSlot): string {
  return slot.kind === 'header'
    ? b.headerVariable
    : slot.kind === 'body'
      ? b.variableLabel(slot.name)
      : b.buttonVariable(Number(slot.name) + 1);
}

function StepVariables({
  campaign,
  onBack,
  onDone,
}: {
  campaign: BroadcastCampaign;
  onBack: () => void;
  onDone: () => void;
}) {
  const queryClient = useQueryClient();
  const template = useQuery({
    ...templateQuery(campaign.template?.id ?? ''),
    enabled: campaign.template !== null,
  });
  const content = template.data?.template.content;
  const slots = useMemo(() => (content ? mappingSlots(content) : []), [content]);
  // Sebelum diubah pengguna: pemetaan tersimpan + tebakan awal (kolom bernama sama).
  const [edited, setEdited] = useState<BroadcastMapping | null>(null);
  const mapping = edited ?? guessMapping(campaign.mapping, slots, campaign.columns);
  const setMapping = (update: (current: BroadcastMapping) => BroadcastMapping) =>
    setEdited(update(mapping));
  const complete = mappingComplete(mapping, slots, campaign.columns);
  const savedComplete = mappingComplete(campaign.mapping, slots, campaign.columns);
  const [saving, setSaving] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const [touched, setTouched] = useState(false);

  // Simpan otomatis (jeda singkat) setelah pemetaan lengkap berubah → pratinjau server diperbarui.
  const dirty = JSON.stringify(mapping) !== JSON.stringify(campaign.mapping);
  useEffect(() => {
    if (!dirty || !complete) return;
    const timer = window.setTimeout(() => {
      setSaving(true);
      endpoints.broadcasts
        .update(campaign.id, { mapping })
        .then(({ broadcast }) => {
          storeBroadcast(queryClient, broadcast);
          void queryClient.invalidateQueries({ queryKey: broadcastKeys.preview(campaign.id) });
        })
        .catch(setFailure)
        .finally(() => setSaving(false));
    }, 600);
    return () => window.clearTimeout(timer);
  }, [dirty, complete, mapping, campaign.id, queryClient]);

  const preview = useQuery({
    queryKey: broadcastKeys.preview(campaign.id),
    queryFn: ({ signal }) => endpoints.broadcasts.preview(campaign.id, signal),
    // Hanya setelah isi template diketahui dan pemetaan lengkap tersimpan.
    enabled: content !== undefined && savedComplete && !dirty,
  });

  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{b.variablesTitle}</h2>
      {template.isPending ? (
        <Skeleton className={styles.skeletonField} />
      ) : slots.length === 0 ? (
        <p className={styles.hint}>{b.noVariables}</p>
      ) : (
        <>
          <p className={styles.hint}>{b.variablesHint}</p>
          <div className={styles.slots}>
            {slots.map((slot) => {
              const source = slotSource(mapping, slot);
              const label = slotLabel(slot);
              const empty =
                !source || (source.kind === 'text' ? !source.value.trim() : !source.column);
              return (
                <div key={slot.key} className={styles.slot}>
                  {/* Satu pilihan per variabel: kolom data penerima, atau teks tetap. */}
                  <SelectField
                    label={label}
                    value={source?.kind === 'text' ? TEXT_SOURCE : (source?.column ?? '')}
                    onChange={(event) =>
                      setMapping((current) =>
                        withSlot(
                          current,
                          slot,
                          event.target.value === TEXT_SOURCE
                            ? { kind: 'text', value: '' }
                            : { kind: 'column', column: event.target.value },
                        ),
                      )
                    }
                    error={
                      touched && empty && source?.kind !== 'text' ? b.mappingIncomplete : undefined
                    }
                    options={[
                      ...(source ? [] : [{ value: '', label: b.pickColumn }]),
                      ...campaign.columns.map((column) => ({
                        value: column,
                        label: b.columnOption(column),
                      })),
                      { value: TEXT_SOURCE, label: b.sourceKinds.text },
                    ]}
                  />
                  {source?.kind === 'text' ? (
                    <TextField
                      label={b.textLabel(label)}
                      value={source.value}
                      onChange={(event) =>
                        setMapping((current) =>
                          withSlot(current, slot, { kind: 'text', value: event.target.value }),
                        )
                      }
                      error={touched && empty ? b.mappingIncomplete : undefined}
                      maxLength={200}
                    />
                  ) : null}
                </div>
              );
            })}
          </div>
        </>
      )}

      {content ? (
        <section className={styles.previewSection} aria-label={b.previewTitle}>
          <h3 className={styles.groupLabel}>{b.previewTitle}</h3>
          {preview.data ? (
            <>
              <ul className={styles.previewList}>
                {preview.data.samples.map((sample) => (
                  <li key={sample.recipientId} className={styles.previewItem}>
                    <p className={styles.previewMeta}>{b.previewRow(sample.row, sample.phone)}</p>
                    <div className={styles.previewStage}>
                      <TemplateBubble
                        content={{ ...content, body: { ...content.body, text: sample.text } }}
                        category={template.data?.template.category ?? 'UTILITY'}
                        values={{}}
                        headerValue={sample.headerText ?? ''}
                      />
                    </div>
                    {sample.missing.length > 0 ? (
                      <p className={styles.fieldError}>{b.previewMissing}</p>
                    ) : sample.invalid.length > 0 ? (
                      <p className={styles.fieldError}>{b.previewInvalid}</p>
                    ) : null}
                  </li>
                ))}
              </ul>
              {preview.data.problems.missing + preview.data.problems.invalid > 0 ? (
                <Notice tone="warning" role="status">
                  {b.problems(preview.data.problems.missing, preview.data.problems.invalid)}
                </Notice>
              ) : null}
            </>
          ) : preview.isError ? (
            <p className={styles.hint}>{b.previewFailed}</p>
          ) : complete ? (
            <Skeleton className={styles.skeletonPreview} />
          ) : (
            <div className={styles.previewStage}>
              <TemplateBubble
                content={content}
                category={template.data?.template.category ?? 'UTILITY'}
                values={{}}
              />
            </div>
          )}
        </section>
      ) : null}

      <Failure error={failure} />
      <div className={styles.stepActions}>
        <Button onClick={onBack}>{b.back}</Button>
        <Button
          variant="primary"
          loading={saving}
          onClick={() => {
            setTouched(true);
            if (complete && !dirty) onDone();
          }}
        >
          {saving ? b.saving : b.next}
        </Button>
      </div>
    </div>
  );
}

// ── 4. Jadwal & kirim ───────────────────────────────────────────────────────

function StepSend({ campaign, onBack }: { campaign: BroadcastCampaign; onBack: () => void }) {
  const queryClient = useQueryClient();
  const zone = useSession()?.organization.timezone ?? 'Asia/Jakarta';
  const tags = useQuery(tagsQuery);
  const [later, setLater] = useState(campaign.scheduledAt !== null);
  const [when, setWhen] = useState(() =>
    campaign.scheduledAt
      ? isoToZoned(campaign.scheduledAt, zone)
      : isoToZoned(new Date(Date.now() + 60 * 60_000).toISOString(), zone),
  );
  const [rate, setRate] = useState(String(campaign.ratePerSecond));
  const [dedupeOn, setDedupeOn] = useState(campaign.dedupe.hours !== null);
  const [dedupeHours, setDedupeHours] = useState(String(campaign.dedupe.hours ?? 24));
  const [dedupeScope, setDedupeScope] = useState(campaign.dedupe.scope);
  const [autoTagId, setAutoTagId] = useState(campaign.autoTag?.id ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [confirming, setConfirming] = useState(false);
  const [saving, setSaving] = useState(false);
  const submitRef = useRef<HTMLButtonElement>(null);
  const estimate = useQuery({
    queryKey: broadcastKeys.estimate(campaign.id),
    queryFn: ({ signal }) => endpoints.broadcasts.estimate(campaign.id, signal),
  });
  const maxRate = BROADCAST_LIMITS.ratePerSecond.max;

  const prepare = async () => {
    const problems: Record<string, string> = {};
    const rateValue = Number(rate);
    if (!Number.isInteger(rateValue) || rateValue < 1 || rateValue > maxRate) {
      problems.ratePerSecond = b.rateInvalid(maxRate);
    }
    const hours = Number(dedupeHours);
    if (dedupeOn && (!Number.isInteger(hours) || hours < 1 || hours > 720)) {
      problems.dedupe = b.dedupeHoursInvalid;
    }
    const scheduledAt = later ? zonedToIso(when, zone) : null;
    if (later && (!scheduledAt || Date.parse(scheduledAt) <= Date.now())) {
      problems.scheduledAt = b.schedulePast;
    }
    setErrors(problems);
    setFailure(null);
    if (Object.keys(problems).length > 0) return;
    setSaving(true);
    try {
      const { broadcast } = await endpoints.broadcasts.update(campaign.id, {
        scheduledAt,
        ratePerSecond: rateValue,
        dedupe: { hours: dedupeOn ? hours : null, scope: dedupeScope },
        autoTagId: autoTagId || null,
      });
      storeBroadcast(queryClient, broadcast);
      setConfirming(true);
    } catch (caught) {
      if (isApiError(caught) && caught.details.length > 0) {
        setErrors(
          Object.fromEntries(caught.details.map((detail) => [detail.field, detail.message])),
        );
      } else {
        setFailure(caught);
      }
    } finally {
      setSaving(false);
    }
  };

  const submit = async (confirmation: IdentityConfirmation) => {
    try {
      const { broadcast } = await endpoints.broadcasts.submit(campaign.id, confirmation);
      setConfirming(false);
      storeBroadcast(queryClient, broadcast);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(false);
      setFailure(caught);
    }
  };

  const data = estimate.data?.estimate;
  return (
    <div className={styles.card}>
      <h2 className={styles.cardTitle}>{b.steps.send}</h2>
      <fieldset className={styles.fieldset}>
        <legend className={styles.groupLabel}>{b.scheduleTitle}</legend>
        <div className={styles.segments} role="radiogroup" aria-label={b.scheduleTitle}>
          {([false, true] as const).map((value) => (
            <button
              key={String(value)}
              type="button"
              role="radio"
              aria-checked={later === value}
              className={styles.segment}
              onClick={() => setLater(value)}
            >
              {value ? b.scheduleLater : b.scheduleNow}
            </button>
          ))}
        </div>
        {later ? (
          <TextField
            label={b.scheduleAt}
            type="datetime-local"
            hint={b.scheduleHint(zone)}
            value={when}
            onChange={(event) => setWhen(event.target.value)}
            error={errors.scheduledAt}
            className={styles.short}
          />
        ) : null}
      </fieldset>
      <TextField
        label={b.rateLabel}
        hint={b.rateHint(maxRate)}
        value={rate}
        onChange={(event) => setRate(event.target.value)}
        error={errors.ratePerSecond}
        inputMode="numeric"
        maxLength={2}
        className={styles.short}
      />
      <fieldset className={styles.fieldset}>
        <legend className={styles.groupLabel}>{b.dedupeTitle}</legend>
        <Checkbox checked={dedupeOn} onChange={(event) => setDedupeOn(event.target.checked)}>
          {b.dedupeOn}
        </Checkbox>
        {dedupeOn ? (
          <div className={styles.inlineField}>
            <TextField
              label={b.dedupeHours}
              value={dedupeHours}
              onChange={(event) => setDedupeHours(event.target.value)}
              error={errors.dedupe}
              inputMode="numeric"
              maxLength={3}
              className={styles.tiny}
            />
            <SelectField
              label={b.dedupeScopeLabel}
              value={dedupeScope}
              onChange={(event) => setDedupeScope(event.target.value as 'template' | 'any')}
              options={[
                { value: 'template', label: b.dedupeScope.template },
                { value: 'any', label: b.dedupeScope.any },
              ]}
            />
          </div>
        ) : null}
      </fieldset>
      <SelectField
        label={b.autoTagLabel}
        value={autoTagId}
        onChange={(event) => setAutoTagId(event.target.value)}
        options={[
          { value: '', label: b.autoTagNone },
          ...(tags.data?.tags ?? []).map((tag) => ({ value: tag.id, label: tag.name })),
        ]}
        className={styles.short}
      />

      <section className={styles.estimate} aria-label={b.estimateTitle}>
        <h3 className={styles.groupLabel}>{b.estimateTitle}</h3>
        {data ? (
          <>
            <p className={styles.estimateTotal}>{b.money(data.currency, data.total)}</p>
            <ul className={styles.estimateList}>
              <li>{b.recipients(data.recipients)}</li>
              <li>{b.estimateBillable(data.billable)}</li>
              {data.free > 0 ? <li>{b.estimateFree(data.free)}</li> : null}
              {data.unknownRate > 0 ? <li>{b.estimateUnknown(data.unknownRate)}</li> : null}
            </ul>
            <p className={styles.hint}>
              {b.estimateNote} {data.rateSource}
            </p>
          </>
        ) : estimate.isError ? (
          <p className={styles.hint}>{b.estimateFailed}</p>
        ) : (
          <Skeleton className={styles.skeletonField} />
        )}
      </section>
      <p className={styles.hint}>{b.approvalWillBeNeeded(campaign.approval.threshold)}</p>

      <Failure error={failure} />
      <div className={styles.stepActions}>
        <Button onClick={onBack}>{b.back}</Button>
        <Button ref={submitRef} variant="primary" loading={saving} onClick={() => void prepare()}>
          {saving ? b.saving : b.submit}
        </Button>
      </div>
      <IdentityDialog
        open={confirming}
        title={b.confirmSubmitTitle}
        body={b.confirmSubmitBody(campaign.counts.pending || campaign.counts.recipients)}
        confirmLabel={b.submit}
        pendingLabel={b.submitting}
        requireCode
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(false)}
        onConfirm={submit}
      />
    </div>
  );
}

// ── Hapus draf ──────────────────────────────────────────────────────────────

function DeleteDraft({ campaign }: { campaign: BroadcastCampaign }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<unknown>(null);
  const remove = async () => {
    setBusy(true);
    try {
      await endpoints.broadcasts.remove(campaign.id);
      queryClient.removeQueries({ queryKey: broadcastKeys.detail(campaign.id) });
      void queryClient.invalidateQueries({ queryKey: broadcastKeys.lists });
      setBroadcastFlash(b.deleted(campaign.name));
      void navigate({ to: '/broadcast', replace: true });
    } catch (caught) {
      setOpen(false);
      setFailure(caught);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={cx(styles.deleteRow)}>
      <Failure error={failure} />
      <Button variant="ghost" className={styles.dangerButton} onClick={() => setOpen(true)}>
        <Icon icon={Trash2} size={16} />
        {b.deleteDraft}
      </Button>
      <ConfirmDialog
        open={open}
        title={b.confirmDeleteTitle}
        body={b.confirmDeleteBody}
        cancelLabel={b.cancel}
        confirmLabel={busy ? b.deleting : b.deleteDraft}
        confirmVariant="danger"
        onCancel={() => setOpen(false)}
        onConfirm={() => {
          if (!busy) void remove();
        }}
      />
    </div>
  );
}
