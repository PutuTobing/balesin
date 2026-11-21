import {
  TEMPLATE_CATEGORIES,
  TEMPLATE_LIMITS,
  TEMPLATE_STATUS_LABELS,
  type MessageTemplate,
  type TemplateCategory,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { CircleCheck, CircleAlert, Plus, Trash2, Variable } from 'lucide-react';
import { useMemo, useRef, useState, type FocusEvent, type FormEvent } from 'react';
import {
  LoadFailedIllustration,
  NotFoundIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import { formatDateTimeInline } from '../../lib/format';
import { inboxChannelsQuery } from '../inbox/inbox-queries';
import { TemplateBubble } from './TemplateBubble';
import {
  bodyVariables,
  canSubmit,
  contentFrom,
  draftFrom,
  draftIssues,
  editability,
  emptyDraft,
  headerVariable,
  issueMap,
  newButton,
  nextVariable,
  statusTone,
  type ButtonDraft,
  type ButtonKind,
  type TemplateDraft,
} from './template-form';
import {
  setTemplateFlash,
  storeTemplate,
  takeTemplateFlash,
  templateKeys,
  type TemplateFlash,
  templateQuery,
} from './template-queries';
import { languageLabel, rejectionText } from './template-labels';
import styles from './Templates.module.css';

const c = t.templates;
const LANGUAGES = ['id', 'en_US', 'en'];
const BUTTON_KINDS: readonly ButtonKind[] = ['QUICK_REPLY', 'URL', 'PHONE_NUMBER', 'COPY_CODE'];
const BUTTON_LIMITS: Record<ButtonKind, number> = {
  QUICK_REPLY: TEMPLATE_LIMITS.quickReplyMax,
  URL: TEMPLATE_LIMITS.urlButtonsMax,
  PHONE_NUMBER: TEMPLATE_LIMITS.phoneButtonsMax,
  COPY_CODE: TEMPLATE_LIMITS.copyCodeMax,
};

/** Pengaturan → Template → Template baru. */
export function TemplateNewPage() {
  const channels = useQuery(inboxChannelsQuery);
  const whatsapp = (channels.data?.channels ?? []).filter((channel) => channel.type === 'whatsapp');
  if (channels.isPending) return <EditorSkeleton />;
  if (channels.isError) {
    return (
      <Page>
        <EmptyState
          illustration={<LoadFailedIllustration />}
          title={c.loadFailedTitle}
          body={isApiError(channels.error) ? channels.error.message : t.api.network}
          actions={
            <Button variant="primary" onClick={() => void channels.refetch()}>
              {t.common.retry}
            </Button>
          }
        />
      </Page>
    );
  }
  if (whatsapp.length === 0) {
    return (
      <Page>
        <EmptyState title={c.noChannelTitle} body={c.noChannelBody} />
      </Page>
    );
  }
  return <TemplateEditor template={null} channels={whatsapp} />;
}

/** Pengaturan → Template → ubah satu template. */
export function TemplateEditPage() {
  const { templateId } = useParams({ from: '/_app/pengaturan/template/$templateId' });
  const detail = useQuery(templateQuery(templateId));
  const channels = useQuery(inboxChannelsQuery);
  if (detail.isPending) return <EditorSkeleton />;
  if (detail.isError) {
    const notFound = isApiError(detail.error) && detail.error.status === 404;
    return (
      <Page>
        <EmptyState
          illustration={notFound ? <NotFoundIllustration /> : <LoadFailedIllustration />}
          title={notFound ? c.notFoundTitle : c.loadFailedTitle}
          body={
            notFound
              ? c.notFoundBody
              : isApiError(detail.error)
                ? detail.error.message
                : t.api.network
          }
          actions={
            notFound ? (
              <Button variant="primary" asChild>
                <Link to="/pengaturan/template">{c.backToList}</Link>
              </Button>
            ) : (
              <Button variant="primary" onClick={() => void detail.refetch()}>
                {t.common.retry}
              </Button>
            )
          }
        />
      </Page>
    );
  }
  return (
    <TemplateEditor
      // Template lain = formulir baru. Versi baru template yang sama (setelah disimpan/diajukan)
      // tidak membuat ulang formulir: galat & isian pengguna tetap.
      key={detail.data.template.id}
      template={detail.data.template}
      channels={(channels.data?.channels ?? []).filter((channel) => channel.type === 'whatsapp')}
    />
  );
}

function EditorSkeleton() {
  return (
    <Page>
      <SkeletonRegion className={styles.editor}>
        <div className={styles.editorMain}>
          <Skeleton className={styles.skeletonCard} />
          <Skeleton className={styles.skeletonCard} />
        </div>
        <Skeleton className={styles.skeletonPreview} />
      </SkeletonRegion>
    </Page>
  );
}

const sameDraft = (a: TemplateDraft, b: TemplateDraft) =>
  JSON.stringify({ ...a, buttons: a.buttons.map(({ key: _, ...rest }) => rest) }) ===
  JSON.stringify({ ...b, buttons: b.buttons.map(({ key: _, ...rest }) => rest) });

function TemplateEditor({
  template,
  channels,
}: {
  template: MessageTemplate | null;
  channels: readonly { id: string; name: string }[];
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const initial = useMemo(
    () => (template ? draftFrom(template) : emptyDraft(channels[0]?.id ?? '')),
    [template, channels],
  );
  const [draft, setDraft] = useState<TemplateDraft>(initial);
  const [touched, setTouched] = useState<ReadonlySet<string>>(new Set());
  const [showAll, setShowAll] = useState(false);
  const [serverErrors, setServerErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<'save' | 'submit' | null>(null);
  const [notice, setNotice] = useState<TemplateFlash | null>(() => takeTemplateFlash());
  const [failure, setFailure] = useState<unknown>(null);
  const [removing, setRemoving] = useState(false);
  const [removeBusy, setRemoveBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const createdRef = useRef<MessageTemplate | null>(null);

  const edit = editability(template);
  const otp = draft.category === 'AUTHENTICATION';
  const issues = useMemo(() => draftIssues(draft), [draft]);
  const localErrors = useMemo(() => issueMap(issues), [issues]);
  const dirty = !sameDraft(draft, initial);
  const variables = bodyVariables(draft);
  const headerVar = headerVariable(draft);
  const content = useMemo(() => contentFrom(draft), [draft]);

  const errorFor = (field: string): string | undefined =>
    serverErrors[field] ?? (showAll || touched.has(field) ? localErrors[field] : undefined);

  const change = (next: Partial<TemplateDraft>) => {
    setDraft((current) => ({ ...current, ...next }));
    setNotice(null);
  };
  const changeButton = (index: number, next: Partial<ButtonDraft>) =>
    change({
      buttons: draft.buttons.map((button, position) =>
        position === index ? { ...button, ...next } : button,
      ),
    });

  const onBlur = (event: FocusEvent<HTMLFormElement>) => {
    const name = (event.target as EventTarget as Element).getAttribute('name');
    if (name && !touched.has(name)) setTouched(new Set(touched).add(name));
  };

  const insertVariable = () => {
    const element = bodyRef.current;
    const token = `{{${nextVariable(draft)}}}`;
    const start = element?.selectionStart ?? draft.body.length;
    const end = element?.selectionEnd ?? draft.body.length;
    // Variabel tidak boleh di awal/akhir atau berdampingan: beri spasi di kedua sisinya.
    const before = draft.body.slice(0, start);
    const after = draft.body.slice(end);
    const pad = (text: string) => (text && !/\s$/.test(text) ? `${text} ` : text);
    const next = `${pad(before)}${token}${after && !/^\s/.test(after) ? ` ${after}` : after}`;
    change({ body: next });
    const caret = pad(before).length + token.length;
    requestAnimationFrame(() => {
      element?.focus();
      element?.setSelectionRange(caret, caret);
    });
  };

  /** Simpan perubahan (atau buat draf baru). Mengembalikan template tersimpan terbaru. */
  const persist = async (): Promise<MessageTemplate> => {
    if (!template) {
      const { template: created } = await endpoints.templates.create({
        channelId: draft.channelId,
        name: draft.name.trim(),
        language: draft.language,
        category: draft.category,
        content,
      });
      storeTemplate(queryClient, created);
      createdRef.current = created;
      return created;
    }
    if (!dirty) return template;
    const { template: updated } = await endpoints.templates.update(template.id, {
      ...(edit.identity && draft.name !== initial.name ? { name: draft.name.trim() } : {}),
      ...(edit.identity && draft.language !== initial.language ? { language: draft.language } : {}),
      ...(edit.category && draft.category !== initial.category ? { category: draft.category } : {}),
      content,
    });
    storeTemplate(queryClient, updated);
    return updated;
  };

  const handleFailure = (caught: unknown) => {
    if (isApiError(caught) && caught.details.length > 0) {
      setServerErrors(issueMap(caught.details));
      setShowAll(true);
    }
    setFailure(caught);
  };

  const goTo = (saved: MessageTemplate, message: string) => {
    if (template?.id === saved.id) {
      // Template yang sama: formulir tetap, data barunya datang lewat cache.
      setNotice({ message, tone: 'success' });
      return;
    }
    setTemplateFlash(message);
    void navigate({
      to: '/pengaturan/template/$templateId',
      params: { templateId: saved.id },
      replace: true,
    });
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    setFailure(null);
    setServerErrors({});
    if (localErrors.name || localErrors.language) {
      setShowAll(true);
      return;
    }
    setBusy('save');
    try {
      const saved = await persist();
      goTo(saved, template ? c.saved : c.created);
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  const submit = async () => {
    setFailure(null);
    setServerErrors({});
    if (issues.length > 0) {
      setShowAll(true);
      setFailure(new Error(c.fixFirst));
      return;
    }
    setBusy('submit');
    try {
      const saved = await persist();
      const { template: submitted } = await endpoints.templates.submit(saved.id);
      storeTemplate(queryClient, submitted);
      goTo(submitted, c.submitted);
    } catch (caught) {
      const created = createdRef.current;
      if (!template && created) {
        // Draf baru sudah tersimpan walau pengajuan gagal: buka alamatnya (tidak dibuat dua kali).
        setTemplateFlash(isApiError(caught) ? caught.message : t.api.network, 'danger');
        void navigate({
          to: '/pengaturan/template/$templateId',
          params: { templateId: created.id },
          replace: true,
        });
        return;
      }
      handleFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  const removeTemplate = async () => {
    if (!template) return;
    setRemoveBusy(true);
    try {
      await endpoints.templates.remove(template.id);
      queryClient.removeQueries({ queryKey: templateKeys.detail(template.id) });
      void queryClient.invalidateQueries({ queryKey: templateKeys.all });
      setTemplateFlash(c.removed(template.name));
      void navigate({ to: '/pengaturan/template', replace: true });
    } catch (caught) {
      setRemoving(false);
      setFailure(caught);
    } finally {
      setRemoveBusy(false);
    }
  };

  const submittable = template === null || dirty || canSubmit(template);
  const submitLabel = template?.metaTemplateId ? c.submitChanges : c.submit;
  const failureText =
    failure instanceof Error && !isApiError(failure)
      ? failure.message
      : isApiError(failure)
        ? failure.message
        : failure
          ? t.api.network
          : null;
  const channelName = channels.find((channel) => channel.id === draft.channelId)?.name ?? '';

  return (
    <Page>
      <form className={styles.editor} onSubmit={save} onBlur={onBlur} noValidate>
        <div className={styles.editorMain}>
          {notice ? (
            <Notice tone={notice.tone} role={notice.tone === 'danger' ? 'alert' : 'status'}>
              {notice.message}
            </Notice>
          ) : null}
          {template ? <StatusPanel template={template} /> : null}
          {edit.lockedReason ? (
            <Notice tone="info" role="status">
              {c.locked[edit.lockedReason]}
            </Notice>
          ) : null}

          <fieldset className={styles.card} disabled={!edit.content}>
            <legend className={styles.cardTitle}>{c.identityTitle}</legend>
            {template ? (
              <p className={styles.fact}>
                <span className={styles.factLabel}>{c.channelPick}</span>
                <span>{channelName}</span>
              </p>
            ) : (
              <SelectField
                label={c.channelPick}
                hint={c.channelPickHint}
                value={draft.channelId}
                onChange={(event) => change({ channelId: event.target.value })}
                options={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
              />
            )}
            <div className={styles.twoCols}>
              <TextField
                label={c.nameLabel}
                name="name"
                hint={edit.identity ? c.nameHint : c.identityLocked}
                value={draft.name}
                onChange={(event) =>
                  change({ name: event.target.value.toLowerCase().replace(/[\s-]+/g, '_') })
                }
                error={errorFor('name')}
                disabled={!edit.identity}
                inputClassName={styles.mono}
                autoComplete="off"
                spellCheck={false}
                maxLength={TEMPLATE_LIMITS.name}
              />
              <SelectField
                label={c.languageLabel}
                name="language"
                value={draft.language}
                onChange={(event) => change({ language: event.target.value })}
                error={errorFor('language')}
                disabled={!edit.identity}
                options={[...new Set([...LANGUAGES, draft.language])].map((code) => ({
                  value: code,
                  label: languageLabel(code),
                }))}
              />
            </div>
            <div className={styles.group}>
              <span className={styles.groupLabel} id="kategori-template">
                {c.categoryLabel}
              </span>
              <div
                className={styles.segments}
                role="radiogroup"
                aria-labelledby="kategori-template"
              >
                {TEMPLATE_CATEGORIES.map((category: TemplateCategory) => (
                  <button
                    key={category}
                    type="button"
                    role="radio"
                    aria-checked={draft.category === category}
                    className={styles.segment}
                    disabled={!edit.category}
                    onClick={() => change({ category })}
                  >
                    {c.categoryShort[category]}
                  </button>
                ))}
              </div>
              <p className={styles.hint}>
                {edit.category ? c.categoryHints[draft.category] : c.categoryLocked}
              </p>
              {errorFor('category') ? (
                <p className={styles.fieldError}>{errorFor('category')}</p>
              ) : null}
            </div>
          </fieldset>

          {otp ? (
            <fieldset className={styles.card} disabled={!edit.content}>
              <legend className={styles.cardTitle}>{c.otpTitle}</legend>
              <p className={styles.hint}>{c.otpBody}</p>
              <Checkbox
                checked={draft.otpSecurity}
                onChange={(event) => change({ otpSecurity: event.target.checked })}
              >
                {c.otpSecurity}
              </Checkbox>
              <TextField
                label={c.otpExpiry}
                name="authentication.codeExpirationMinutes"
                optional
                hint={c.otpExpiryHint}
                value={draft.otpExpiry}
                onChange={(event) => change({ otpExpiry: event.target.value })}
                error={errorFor('authentication.codeExpirationMinutes')}
                inputMode="numeric"
                maxLength={2}
                className={styles.short}
              />
            </fieldset>
          ) : (
            <>
              <fieldset className={styles.card} disabled={!edit.content}>
                <legend className={styles.cardTitle}>{c.contentTitle}</legend>
                <div className={styles.group}>
                  <span className={styles.groupLabel} id="bentuk-variabel">
                    {c.variableFormatLabel}
                  </span>
                  <div
                    className={styles.segments}
                    role="radiogroup"
                    aria-labelledby="bentuk-variabel"
                  >
                    {(['positional', 'named'] as const).map((format) => (
                      <button
                        key={format}
                        type="button"
                        role="radio"
                        aria-checked={draft.parameterFormat === format}
                        className={styles.segment}
                        onClick={() => change({ parameterFormat: format })}
                      >
                        {c.variableFormats[format]}
                      </button>
                    ))}
                  </div>
                </div>

                <div className={styles.group}>
                  <span className={styles.groupLabel} id="judul-template">
                    {c.headerLabel}
                  </span>
                  {draft.headerKind === 'none' || draft.headerKind === 'TEXT' ? (
                    <div
                      className={styles.segments}
                      role="radiogroup"
                      aria-labelledby="judul-template"
                    >
                      {(['none', 'TEXT'] as const).map((kind) => (
                        <button
                          key={kind}
                          type="button"
                          role="radio"
                          aria-checked={draft.headerKind === kind}
                          className={styles.segment}
                          onClick={() => change({ headerKind: kind })}
                        >
                          {c.headerKinds[kind]}
                        </button>
                      ))}
                    </div>
                  ) : (
                    <p className={styles.fact}>{c.mediaHeader[draft.headerKind]}</p>
                  )}
                  <p className={styles.hint}>{c.headerMediaHint}</p>
                </div>
                {draft.headerKind === 'TEXT' ? (
                  <>
                    <TextField
                      label={c.headerTextLabel}
                      name="header.text"
                      hint={c.count(draft.headerText.length, TEMPLATE_LIMITS.headerText)}
                      value={draft.headerText}
                      onChange={(event) => change({ headerText: event.target.value })}
                      error={errorFor('header.text')}
                      maxLength={TEMPLATE_LIMITS.headerText}
                    />
                    {headerVar ? (
                      <TextField
                        label={c.headerExampleLabel(headerVar)}
                        name="header.example"
                        value={draft.headerExample}
                        onChange={(event) => change({ headerExample: event.target.value })}
                        error={errorFor('header.example')}
                        maxLength={TEMPLATE_LIMITS.example}
                      />
                    ) : null}
                  </>
                ) : null}

                <div className={styles.bodyField}>
                  <TextAreaField
                    ref={bodyRef}
                    label={c.bodyLabel}
                    name="body.text"
                    hint={c.bodyHint}
                    value={draft.body}
                    onChange={(event) => change({ body: event.target.value })}
                    error={errorFor('body.text')}
                    rows={6}
                    maxLength={TEMPLATE_LIMITS.body}
                  />
                  <div className={styles.bodyFooter}>
                    <Button variant="ghost" onClick={insertVariable}>
                      <Icon icon={Variable} size={16} />
                      {c.addVariable}
                    </Button>
                    <span className={styles.count}>
                      {c.count(draft.body.length, TEMPLATE_LIMITS.body)}
                    </span>
                  </div>
                </div>

                {variables.length > 0 ? (
                  <div className={styles.group}>
                    <span className={styles.groupLabel}>{c.examplesTitle}</span>
                    <p className={styles.hint}>{c.examplesHint}</p>
                    <div className={styles.examples}>
                      {variables.map((name) => (
                        <TextField
                          key={name}
                          label={c.exampleLabel(name)}
                          name={`body.examples.${name}`}
                          value={draft.examples[name] ?? ''}
                          onChange={(event) =>
                            change({ examples: { ...draft.examples, [name]: event.target.value } })
                          }
                          error={errorFor(`body.examples.${name}`)}
                          maxLength={TEMPLATE_LIMITS.example}
                        />
                      ))}
                    </div>
                  </div>
                ) : null}

                <TextField
                  label={c.footerLabel}
                  name="footer.text"
                  optional
                  hint={c.count(draft.footer.length, TEMPLATE_LIMITS.footer)}
                  value={draft.footer}
                  onChange={(event) => change({ footer: event.target.value })}
                  error={errorFor('footer.text')}
                  maxLength={TEMPLATE_LIMITS.footer}
                />
              </fieldset>

              <fieldset className={styles.card} disabled={!edit.content}>
                <legend className={styles.cardTitle}>{c.buttonsTitle}</legend>
                <p className={styles.hint}>{c.buttonsHint}</p>
                {draft.buttons.map((button, index) => (
                  <ButtonEditor
                    key={button.key}
                    button={button}
                    index={index}
                    errorFor={errorFor}
                    onChange={(next) => changeButton(index, next)}
                    onRemove={() =>
                      change({ buttons: draft.buttons.filter((_, position) => position !== index) })
                    }
                  />
                ))}
                {errorFor('buttons') ? (
                  <p className={styles.fieldError} role="alert">
                    {errorFor('buttons')}
                  </p>
                ) : null}
                <p className={styles.count}>{c.buttonsCount(draft.buttons.length)}</p>
                {draft.buttons.length < TEMPLATE_LIMITS.buttonsMax ? (
                  <div className={styles.addButtons} role="group" aria-label={c.addButton}>
                    {BUTTON_KINDS.map((kind) => {
                      const used = draft.buttons.filter((button) => button.type === kind).length;
                      return (
                        <Button
                          key={kind}
                          variant="secondary"
                          disabled={used >= BUTTON_LIMITS[kind]}
                          aria-label={`${c.addButton}: ${c.buttonKinds[kind]}`}
                          onClick={() => change({ buttons: [...draft.buttons, newButton(kind)] })}
                        >
                          <Icon icon={Plus} size={16} />
                          {c.buttonKinds[kind]}
                        </Button>
                      );
                    })}
                  </div>
                ) : null}
              </fieldset>
            </>
          )}
        </div>

        <aside className={styles.editorAside} aria-label={c.previewTitle}>
          <section className={styles.previewCard}>
            <h2 className={styles.cardTitle}>{c.previewTitle}</h2>
            <p className={styles.hint}>{c.previewHint}</p>
            <div className={styles.previewStage}>
              <TemplateBubble
                content={content}
                category={draft.category}
                values={draft.examples}
                headerValue={draft.headerExample}
              />
            </div>
          </section>
          {edit.content ? (
            <section
              className={cx(styles.previewCard, issues.length === 0 && styles.checkReady)}
              aria-live="polite"
            >
              <h2 className={styles.checkTitle}>
                <Icon icon={issues.length === 0 ? CircleCheck : CircleAlert} size={20} />
                {c.issuesTitle(issues.length)}
              </h2>
              {issues.length === 0 ? (
                <p className={styles.hint}>{c.readyBody}</p>
              ) : (
                <ul className={styles.issues}>
                  {issues.slice(0, 8).map((issue, index) => (
                    <li key={`${issue.field}-${String(index)}`}>{issue.message}</li>
                  ))}
                </ul>
              )}
            </section>
          ) : null}
        </aside>

        <div className={styles.editorActions}>
          {failureText ? (
            <Notice tone="danger" role="alert">
              {failureText}
            </Notice>
          ) : null}
          <div className={styles.actionRow}>
            {template ? (
              <Button
                variant="ghost"
                className={styles.deleteButton}
                onClick={() => setRemoving(true)}
              >
                <Icon icon={Trash2} size={16} />
                {c.removeConfirm}
              </Button>
            ) : null}
            {edit.content ? (
              <>
                <Button
                  type="submit"
                  loading={busy === 'save'}
                  disabled={busy !== null || (template !== null && !dirty)}
                >
                  {busy === 'save' ? c.saving : template ? c.save : c.saveDraft}
                </Button>
                <Button
                  variant="primary"
                  loading={busy === 'submit'}
                  disabled={busy !== null || !submittable}
                  onClick={() => void submit()}
                >
                  {busy === 'submit' ? c.submitting : submitLabel}
                </Button>
              </>
            ) : null}
          </div>
        </div>
      </form>
      <ConfirmDialog
        open={removing}
        title={c.removeTitle(template?.name ?? '')}
        body={template?.metaTemplateId ? c.removeBodyMeta : c.removeBodyDraft}
        cancelLabel={c.cancel}
        confirmLabel={removeBusy ? c.removing : c.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setRemoving(false)}
        onConfirm={() => {
          if (!removeBusy) void removeTemplate();
        }}
      />
    </Page>
  );
}

function StatusPanel({ template }: { template: MessageTemplate }) {
  const facts = [
    template.qualityScore ? c.quality[template.qualityScore] : null,
    template.submittedAt ? c.submittedAt(formatDateTimeInline(template.submittedAt)) : null,
    template.lastSyncedAt ? c.lastSynced(formatDateTimeInline(template.lastSyncedAt)) : null,
  ].filter(Boolean);
  return (
    <div className={styles.statusPanel}>
      <div className={styles.statusRow}>
        <StatusBadge
          tone={statusTone(template.status)}
          label={TEMPLATE_STATUS_LABELS[template.status]}
        />
        {template.localChanges ? <span className={styles.chip}>{c.localChanges}</span> : null}
        {template.source === 'meta' ? <span className={styles.chip}>{c.fromMeta}</span> : null}
      </div>
      {template.status === 'REJECTED' && template.rejectedReason ? (
        <p className={styles.itemDanger}>{rejectionText(template.rejectedReason)}</p>
      ) : null}
      {facts.length > 0 ? <p className={styles.itemMeta}>{facts.join(' · ')}</p> : null}
    </div>
  );
}

function ButtonEditor({
  button,
  index,
  errorFor,
  onChange,
  onRemove,
}: {
  button: ButtonDraft;
  index: number;
  errorFor: (field: string) => string | undefined;
  onChange: (next: Partial<ButtonDraft>) => void;
  onRemove: () => void;
}) {
  const field = (name: string) => `buttons.${String(index)}.${name}`;
  const urlVariable = /\{\{\s*1\s*\}\}\s*$/.test(button.url);
  return (
    <div className={styles.buttonEditor}>
      <div className={styles.buttonHead}>
        <span className={styles.buttonTitle}>
          {c.buttonTitle(index + 1, c.buttonKinds[button.type])}
        </span>
        <IconButton label={c.removeButton(index + 1)} icon={Trash2} onClick={onRemove} />
      </div>
      {button.type !== 'COPY_CODE' ? (
        <TextField
          label={c.buttonText}
          name={field('text')}
          value={button.text}
          onChange={(event) => onChange({ text: event.target.value })}
          error={errorFor(field('text'))}
          hint={c.count(button.text.length, TEMPLATE_LIMITS.buttonText)}
          maxLength={TEMPLATE_LIMITS.buttonText}
        />
      ) : null}
      {button.type === 'URL' ? (
        <>
          <TextField
            label={c.buttonUrl}
            name={field('url')}
            hint={c.buttonUrlHint}
            value={button.url}
            onChange={(event) => onChange({ url: event.target.value })}
            error={errorFor(field('url'))}
            inputMode="url"
            inputClassName={styles.mono}
            maxLength={TEMPLATE_LIMITS.url}
          />
          {urlVariable ? (
            <TextField
              label={c.buttonUrlExample}
              name={field('example')}
              value={button.example}
              onChange={(event) => onChange({ example: event.target.value })}
              error={errorFor(field('example'))}
              inputMode="url"
              inputClassName={styles.mono}
              maxLength={TEMPLATE_LIMITS.example}
            />
          ) : null}
        </>
      ) : null}
      {button.type === 'PHONE_NUMBER' ? (
        <TextField
          label={c.buttonPhone}
          name={field('phoneNumber')}
          hint={c.buttonPhoneHint}
          value={button.phoneNumber}
          onChange={(event) => onChange({ phoneNumber: event.target.value })}
          error={errorFor(field('phoneNumber'))}
          inputMode="tel"
          maxLength={20}
        />
      ) : null}
      {button.type === 'COPY_CODE' ? (
        <TextField
          label={c.copyCodeExample}
          name={field('example')}
          hint={c.copyCodeHint}
          value={button.example}
          onChange={(event) => onChange({ example: event.target.value })}
          error={errorFor(field('example'))}
          maxLength={15}
          className={styles.short}
        />
      ) : null}
    </div>
  );
}
