import {
  EMAIL_TEMPLATE_FOOTER_MAX,
  updateEmailTemplateRequestSchema,
  type EmailTemplate,
  type EmailTemplateContent,
  type EmailTemplateVariable,
  type IdentityConfirmation,
  type UpdateEmailTemplateRequest,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useParams } from '@tanstack/react-router';
import { Archive, ArchiveRestore } from 'lucide-react';
import { Tabs } from 'radix-ui';
import { useMemo, useRef, useState, type FormEvent } from 'react';
import {
  LoadFailedIllustration,
  NotFoundIllustration,
} from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { CopyButton } from '../../components/ui/CopyButton';
import { EmptyState } from '../../components/ui/EmptyState';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { EmailPreview, Segments } from './EmailPreview';
import { EmailTemplateHistory } from './EmailTemplateHistory';
import { EmailTemplateTestCard } from './EmailTemplateTestCard';
import {
  SUBJECT_MAX,
  contentFromDraft,
  draftFromTemplate,
  fieldKey,
  hasUnpublishedChanges,
  publishIssues,
  sameContent,
  scanVariables,
  syncVariables,
  templateBadge,
  type EmailTemplateDraft,
} from './email-template-form';
import {
  emailTemplateQuery,
  emailTemplateVersionQuery,
  setEmailTemplateFlash,
  storeEmailTemplate,
  takeEmailTemplateFlash,
} from './email-template-queries';
import styles from './EmailTemplates.module.css';

const c = t.emailTemplates;

type Tab = 'content' | 'preview' | 'history';
type PreviewSource =
  { kind: 'draft' } | { kind: 'published' } | { kind: 'version'; version: number };
type Message = { tone: 'success' | 'danger' | 'info'; text: string };

/** Pengaturan → Template email → ubah satu template. */
export function EmailTemplateEditorPage() {
  const { templateId } = useParams({ from: '/_app/pengaturan/template-email/$templateId' });
  const detail = useQuery(emailTemplateQuery(templateId));
  // Naik setelah versi lama dipulihkan: formulir dibuat ulang dari draf baru di server.
  const [generation, setGeneration] = useState(0);
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
                <Link to="/pengaturan/template-email">{c.backToList}</Link>
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
  const template = detail.data.template;
  return (
    <TemplateEditor
      key={`${template.id}:${String(generation)}`}
      template={template}
      onReplaced={() => setGeneration((value) => value + 1)}
    />
  );
}

function EditorSkeleton() {
  return (
    <Page>
      <SkeletonRegion className={styles.content}>
        <Skeleton className={styles.skeletonStatus} />
        <Skeleton className={styles.skeletonTabs} />
        <Skeleton className={styles.skeletonCard} />
        <Skeleton className={styles.skeletonCard} />
      </SkeletonRegion>
    </Page>
  );
}

const sameDraft = (a: EmailTemplateDraft, b: EmailTemplateDraft) =>
  a.name === b.name &&
  a.slug === b.slug &&
  a.description === b.description &&
  sameContent(contentFromDraft(a), contentFromDraft(b));

function TemplateEditor({
  template,
  onReplaced,
}: {
  template: EmailTemplate;
  onReplaced: () => void;
}) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const session = useSession();
  const [baseline, setBaseline] = useState<EmailTemplateDraft>(() => draftFromTemplate(template));
  const [draft, setDraft] = useState<EmailTemplateDraft>(baseline);
  const [tab, setTab] = useState<Tab>('content');
  const [source, setSource] = useState<PreviewSource>({ kind: 'draft' });
  const [errors, setErrors] = useState<FieldErrors>({});
  const [busy, setBusy] = useState<'save' | 'publish' | 'archive' | null>(null);
  const [message, setMessage] = useState<Message | null>(() => {
    const flash = takeEmailTemplateFlash();
    return flash ? { tone: 'success', text: flash } : null;
  });
  const [publishing, setPublishing] = useState(false);
  const [archiving, setArchiving] = useState(false);
  const memory = useRef(new Map<string, EmailTemplateVariable>());
  const publishRef = useRef<HTMLButtonElement>(null);

  const scan = useMemo(
    () => scanVariables({ subject: draft.subject, html: draft.html, text: draft.text }),
    [draft.subject, draft.html, draft.text],
  );
  const dirty = !sameDraft(draft, baseline);
  const slugLocked = template.publishedVersion !== null;
  const archived = template.archived;
  const canPublish = !archived && (dirty || hasUnpublishedChanges(template));
  const content = useMemo(() => contentFromDraft(draft), [draft]);

  const change = (patch: Partial<EmailTemplateDraft>) => {
    setMessage(null);
    setErrors((current) => {
      const next = { ...current };
      for (const key of Object.keys(patch)) delete next[key];
      return next;
    });
    setDraft((current) => {
      const next = { ...current, ...patch };
      if ('subject' in patch || 'html' in patch || 'text' in patch) {
        for (const variable of current.variables) memory.current.set(variable.name, variable);
        next.variables = syncVariables(scanVariables(next).used, current.variables, memory.current);
      }
      return next;
    });
  };
  const changeVariable = (name: string, patch: Partial<EmailTemplateVariable>) =>
    setDraft((current) => ({
      ...current,
      variables: current.variables.map((variable) =>
        variable.name === name ? { ...variable, ...patch } : variable,
      ),
    }));

  const showFailure = (caught: unknown) => {
    if (isApiError(caught) && caught.details.length > 0) {
      const mapped: FieldErrors = {};
      for (const detail of caught.details) mapped[fieldKey(detail.field)] ??= detail.message;
      setErrors(mapped);
      setTab('content');
    }
    setMessage({
      tone: 'danger',
      text: isApiError(caught) ? caught.message : t.api.network,
    });
  };

  /** Simpan yang berubah saja. Mengembalikan `false` bila gagal (pesan sudah tampil). */
  const persist = async (): Promise<boolean> => {
    const body: UpdateEmailTemplateRequest = {};
    if (draft.name !== baseline.name) body.name = draft.name;
    if (!slugLocked && draft.slug !== baseline.slug) body.slug = draft.slug;
    if (draft.description !== baseline.description) {
      body.description = draft.description.trim() ? draft.description : null;
    }
    if (!sameContent(content, contentFromDraft(baseline))) body.draft = content;
    if (Object.keys(body).length === 0) return true;
    const parsed = updateEmailTemplateRequestSchema.safeParse(body);
    if (!parsed.success) {
      const mapped: FieldErrors = {};
      for (const [key, value] of Object.entries(zodFieldErrors(parsed.error))) {
        mapped[fieldKey(key)] ??= value;
      }
      setErrors(mapped);
      setTab('content');
      setMessage({ tone: 'danger', text: c.fixFirst });
      return false;
    }
    try {
      const { template: saved } = await endpoints.emailTemplates.update(template.id, parsed.data);
      storeEmailTemplate(queryClient, saved);
      setBaseline(draft);
      return true;
    } catch (caught) {
      showFailure(caught);
      return false;
    }
  };

  const save = async (event?: FormEvent) => {
    event?.preventDefault();
    if (busy) return;
    if (!dirty) {
      setMessage({ tone: 'info', text: c.noChanges });
      return;
    }
    setBusy('save');
    setMessage(null);
    const ok = await persist();
    setBusy(null);
    if (ok) setMessage({ tone: 'success', text: c.saved });
  };

  const startPublish = async () => {
    if (busy) return;
    setMessage(null);
    const issues = publishIssues(draft, scan);
    if (Object.keys(issues).length > 0) {
      setErrors(issues);
      setTab('content');
      setMessage({ tone: 'danger', text: c.fixFirst });
      return;
    }
    if (dirty) {
      setBusy('save');
      const ok = await persist();
      setBusy(null);
      if (!ok) return;
    }
    setPublishing(true);
  };

  const publish = async (confirmation: IdentityConfirmation) => {
    try {
      const { template: published } = await endpoints.emailTemplates.publish(
        template.id,
        confirmation,
      );
      storeEmailTemplate(queryClient, published);
      // Server bisa merapikan HTML saat terbit: formulir mengikuti isi yang tersimpan.
      const next = draftFromTemplate(published);
      setBaseline(next);
      setDraft(next);
      setPublishing(false);
      setErrors({});
      setMessage({ tone: 'success', text: c.published(published.publishedVersion ?? 1) });
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setPublishing(false);
      showFailure(caught);
    }
  };

  const setArchivedState = async (next: boolean) => {
    setBusy('archive');
    setMessage(null);
    try {
      const { template: updated } = await endpoints.emailTemplates.setArchived(template.id, next);
      storeEmailTemplate(queryClient, updated);
      if (next) {
        setEmailTemplateFlash(c.archived(updated.name));
        void navigate({ to: '/pengaturan/template-email' });
        return;
      }
      setMessage({ tone: 'success', text: c.unarchived });
    } catch (caught) {
      showFailure(caught);
    } finally {
      setArchiving(false);
      setBusy(null);
    }
  };

  const badge = templateBadge(template);
  const pendingChanges = template.publishedVersion !== null && hasUnpublishedChanges(template);
  const facts = [
    template.published
      ? template.published.publishedBy
        ? c.publishedBy(
            template.published.version,
            template.published.publishedBy.name,
            formatDateTimeInline(template.published.publishedAt),
          )
        : c.publishedAt(
            template.published.version,
            formatDateTimeInline(template.published.publishedAt),
          )
      : null,
    template.publishedVersion === null
      ? null
      : template.lastUsedAt
        ? c.lastUsed(formatDateTimeInline(template.lastUsedAt))
        : c.neverUsed,
  ].filter(Boolean);

  return (
    <Page title={template.name}>
      <div className={styles.content}>
        {message ? (
          <Notice tone={message.tone} role={message.tone === 'danger' ? 'alert' : 'status'}>
            {message.text}
          </Notice>
        ) : null}
        <section className={styles.statusPanel} aria-label={c.slugFact}>
          <div className={styles.statusRow}>
            <StatusBadge tone={badge.tone} label={badge.label} />
            {pendingChanges ? <span className={styles.chip}>{c.unpublishedChanges}</span> : null}
          </div>
          {facts.length > 0 ? <p className={styles.itemMeta}>{facts.join(' · ')}</p> : null}
          <div className={styles.slugRow}>
            <span className={styles.factLabel}>{c.slugFact}</span>
            <code className={styles.slug}>{template.slug}</code>
            <CopyButton
              text={template.slug}
              label={c.copySlug}
              ariaLabel={c.copySlugLabel(template.slug)}
              copiedLabel={c.slugCopied}
              announcement={c.slugCopiedAnnouncement}
              variant="ghost"
            />
          </div>
        </section>
        {archived ? (
          <Notice
            tone="info"
            role="status"
            actions={
              <Button loading={busy === 'archive'} onClick={() => void setArchivedState(false)}>
                <Icon icon={ArchiveRestore} size={16} />
                {busy === 'archive' ? c.unarchiving : c.unarchive}
              </Button>
            }
          >
            {c.archivedNotice}
          </Notice>
        ) : null}

        <Tabs.Root value={tab} onValueChange={(value) => setTab(value as Tab)}>
          <Tabs.List className={styles.tabs} aria-label={c.tabsLabel}>
            <Tabs.Trigger value="content" className={styles.tab}>
              {c.tabs.content}
            </Tabs.Trigger>
            <Tabs.Trigger value="preview" className={styles.tab}>
              {c.tabs.preview}
            </Tabs.Trigger>
            <Tabs.Trigger value="history" className={styles.tab}>
              {c.tabs.history}
            </Tabs.Trigger>
          </Tabs.List>

          <Tabs.Content value="content" className={styles.tabContent}>
            <form className={styles.form} onSubmit={(event) => void save(event)} noValidate>
              <fieldset className={styles.card} disabled={archived}>
                <legend className={styles.cardTitle}>{c.identityTitle}</legend>
                <TextField
                  label={c.nameLabel}
                  value={draft.name}
                  onChange={(event) => change({ name: event.target.value })}
                  error={errors.name}
                  maxLength={80}
                  autoComplete="off"
                />
                <TextField
                  label={c.slugLabel}
                  hint={slugLocked ? c.slugLocked : c.slugHint}
                  value={draft.slug}
                  onChange={(event) =>
                    change({ slug: event.target.value.toLowerCase().replace(/[\s_]+/g, '-') })
                  }
                  error={errors.slug}
                  disabled={slugLocked}
                  maxLength={64}
                  autoComplete="off"
                  spellCheck={false}
                  inputClassName={styles.mono}
                />
                <TextField
                  label={c.descriptionLabel}
                  optional
                  hint={c.descriptionHint}
                  value={draft.description}
                  onChange={(event) => change({ description: event.target.value })}
                  error={errors.description}
                  maxLength={200}
                />
              </fieldset>

              <fieldset className={styles.card} disabled={archived}>
                <legend className={styles.cardTitle}>{c.contentTitle}</legend>
                <TextField
                  label={c.subjectLabel}
                  hint={c.subjectHint}
                  value={draft.subject}
                  onChange={(event) => change({ subject: event.target.value })}
                  error={errors.subject}
                  maxLength={SUBJECT_MAX + 50}
                  dir="auto"
                />
                <div className={styles.group}>
                  <span className={styles.groupLabel} id="tata-letak-email">
                    {c.layoutLabel}
                  </span>
                  <Segments
                    label={c.layoutLabel}
                    value={draft.layout}
                    options={(['brand', 'none'] as const).map((layout) => ({
                      value: layout,
                      label: c.layouts[layout],
                    }))}
                    onChange={(value) =>
                      change({
                        layout: value === 'none' ? 'none' : 'brand',
                      })
                    }
                  />
                  <p className={styles.hint}>{c.layoutHints[draft.layout]}</p>
                </div>
                <TextAreaField
                  label={c.htmlLabel}
                  hint={c.htmlHint}
                  value={draft.html}
                  onChange={(event) => change({ html: event.target.value })}
                  error={errors.html}
                  rows={16}
                  spellCheck={false}
                  className={styles.codeField}
                />
                <TextAreaField
                  label={c.textLabel}
                  optional
                  hint={c.textHint}
                  value={draft.text}
                  onChange={(event) => change({ text: event.target.value })}
                  error={errors.text}
                  rows={5}
                  className={styles.codeField}
                />
                {draft.layout === 'brand' ? (
                  <TextAreaField
                    label={c.footerLabel}
                    optional
                    hint={
                      errors.footerText
                        ? undefined
                        : `${c.footerHint} ${c.count(draft.footerText.length, EMAIL_TEMPLATE_FOOTER_MAX)}`
                    }
                    value={draft.footerText}
                    onChange={(event) => change({ footerText: event.target.value })}
                    error={errors.footerText}
                    rows={2}
                    maxLength={EMAIL_TEMPLATE_FOOTER_MAX}
                    dir="auto"
                  />
                ) : null}
              </fieldset>

              <VariablesCard
                variables={draft.variables}
                builtins={scan.builtins}
                errors={errors}
                disabled={archived}
                onChange={changeVariable}
              />

              {archived ? null : (
                <FormActions
                  meta={
                    dirty
                      ? c.unsaved
                      : canPublish
                        ? c.savedAt(formatDateTimeInline(template.updatedAt))
                        : c.nothingToPublish
                  }
                  danger={
                    <Button className={styles.dangerText} onClick={() => setArchiving(true)}>
                      <Icon icon={Archive} size={16} />
                      {c.archive}
                    </Button>
                  }
                >
                  <Button type="submit" loading={busy === 'save'} disabled={busy !== null}>
                    {busy === 'save' ? c.saving : c.saveDraft}
                  </Button>
                  <Button
                    ref={publishRef}
                    variant="primary"
                    disabled={busy !== null || !canPublish}
                    onClick={() => void startPublish()}
                  >
                    {c.publish}
                  </Button>
                </FormActions>
              )}
            </form>
          </Tabs.Content>

          <Tabs.Content value="preview" className={styles.tabContent}>
            <div className={styles.form}>
              <section className={styles.card} aria-labelledby="pratinjau-template-email">
                <div className={styles.cardHead}>
                  <h2 id="pratinjau-template-email" className={styles.cardTitle}>
                    {c.previewTitle}
                  </h2>
                  <p className={styles.hint}>{c.previewHint}</p>
                </div>
                <PreviewBySource
                  template={template}
                  draftContent={content}
                  name={draft.name}
                  source={source}
                  usesQris={scan.builtins.includes('qris')}
                  onSource={setSource}
                />
              </section>
              <EmailTemplateTestCard
                template={template}
                userEmail={session?.user.email ?? ''}
                dirty={dirty}
                values={Object.fromEntries(
                  draft.variables
                    .filter((variable) => variable.example.trim())
                    .map((variable) => [variable.name, variable.example]),
                )}
                onSaveDraft={persist}
              />
            </div>
          </Tabs.Content>

          <Tabs.Content value="history" className={styles.tabContent}>
            <EmailTemplateHistory
              template={template}
              dirty={dirty}
              onPreview={(version) => {
                setSource({ kind: 'version', version });
                setTab('preview');
              }}
              onRestored={(restored, version) => {
                storeEmailTemplate(queryClient, restored);
                setEmailTemplateFlash(c.restored(version));
                onReplaced();
              }}
            />
          </Tabs.Content>
        </Tabs.Root>
      </div>

      <IdentityDialog
        open={publishing}
        title={c.publishTitle(draft.name || template.name)}
        body={c.publishBody}
        confirmLabel={c.publish}
        pendingLabel={c.publishing}
        variant="primary"
        requireCode
        returnFocusRef={publishRef}
        onCancel={() => setPublishing(false)}
        onConfirm={publish}
      />
      <ConfirmDialog
        open={archiving}
        title={c.archiveTitle(template.name)}
        body={c.archiveBody}
        cancelLabel={c.cancel}
        confirmLabel={busy === 'archive' ? c.archiving : c.archiveConfirm}
        confirmVariant="danger"
        onCancel={() => setArchiving(false)}
        onConfirm={() => {
          if (busy !== 'archive') void setArchivedState(true);
        }}
      />
    </Page>
  );
}

/** Variabel yang dipakai (otomatis) + label, contoh nilai, dan tanda wajib per variabel. */
function VariablesCard({
  variables,
  builtins,
  errors,
  disabled,
  onChange,
}: {
  variables: EmailTemplateVariable[];
  builtins: string[];
  errors: FieldErrors;
  disabled: boolean;
  onChange: (name: string, patch: Partial<EmailTemplateVariable>) => void;
}) {
  const listError =
    errors.variables ??
    Object.entries(errors).find(([key]) => key.startsWith('variables.'))?.[1] ??
    null;
  return (
    <fieldset className={styles.card} disabled={disabled}>
      <legend className={styles.cardTitle}>{c.variablesTitle}</legend>
      <p className={styles.hint}>{c.variablesHint}</p>
      {variables.length === 0 ? (
        <p className={styles.emptyLine}>{c.variablesEmpty}</p>
      ) : (
        <ul className={styles.variables} aria-label={c.variablesListLabel}>
          {variables.map((variable) => (
            <li key={variable.name}>
              <fieldset className={styles.variable}>
                <legend className={styles.variableName}>
                  <code>{`{{${variable.name}}}`}</code>
                </legend>
                <div className={styles.variableFields}>
                  <TextField
                    label={c.variableLabel}
                    aria-label={c.variableLabelFor(variable.name)}
                    value={variable.label}
                    onChange={(event) => onChange(variable.name, { label: event.target.value })}
                    maxLength={60}
                    autoComplete="off"
                  />
                  <TextField
                    label={c.variableExample}
                    aria-label={c.variableExampleFor(variable.name)}
                    value={variable.example}
                    onChange={(event) => onChange(variable.name, { example: event.target.value })}
                    maxLength={200}
                    autoComplete="off"
                    dir="auto"
                  />
                  <Checkbox
                    className={styles.plainCheck}
                    checked={variable.required}
                    aria-label={c.variableRequiredFor(variable.name)}
                    onChange={(event) =>
                      onChange(variable.name, { required: event.target.checked })
                    }
                  >
                    {c.variableRequired}
                  </Checkbox>
                </div>
              </fieldset>
            </li>
          ))}
        </ul>
      )}
      {listError ? (
        <p className={styles.fieldError} role="alert">
          {listError}
        </p>
      ) : null}
      {builtins.length > 0 ? (
        <div className={styles.builtins}>
          <span className={styles.groupLabel}>{c.builtinTitle}</span>
          <ul className={styles.plainList}>
            {builtins.map((name) => (
              <li key={name} className={styles.builtin}>
                <code className={styles.slug}>{`{{${name}}}`}</code>
                <span>{c.builtin[name] ?? ''}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </fieldset>
  );
}

/** Pratinjau draf (belum disimpan), versi terbit, atau versi dari riwayat. */
function PreviewBySource({
  template,
  draftContent,
  name,
  source,
  usesQris,
  onSource,
}: {
  template: EmailTemplate;
  draftContent: EmailTemplateContent;
  name: string;
  source: PreviewSource;
  usesQris: boolean;
  onSource: (source: PreviewSource) => void;
}) {
  const versionNumber = source.kind === 'version' ? source.version : null;
  const version = useQuery({
    ...emailTemplateVersionQuery(template.id, versionNumber ?? 0),
    enabled: versionNumber !== null,
  });
  const published = template.published;
  const options = [
    { value: 'draft', label: c.previewSource.draft },
    ...(published
      ? [{ value: 'published', label: c.previewSource.published(published.version) }]
      : []),
    ...(versionNumber !== null && versionNumber !== published?.version
      ? [{ value: `v${String(versionNumber)}`, label: c.previewSource.version(versionNumber) }]
      : []),
  ];
  const value =
    source.kind === 'version'
      ? versionNumber === published?.version
        ? 'published'
        : `v${String(versionNumber)}`
      : source.kind;
  const picker =
    options.length > 1 ? (
      <SelectField
        label={c.previewSourceLabel}
        value={value}
        onChange={(event) => {
          const next = event.target.value;
          if (next === 'draft' || next === 'published') onSource({ kind: next });
          else if (versionNumber !== null) onSource({ kind: 'version', version: versionNumber });
        }}
        options={options}
        className={styles.sourcePicker}
      />
    ) : null;

  let shown: EmailTemplateContent | null = draftContent;
  if (value === 'published' && published) shown = published;
  else if (source.kind === 'version' && value !== 'published') {
    shown = version.data?.version.content ?? null;
  }

  if (!shown) {
    return version.isError ? (
      <Notice
        tone="danger"
        role="alert"
        title={c.previewFailed}
        actions={<Button onClick={() => void version.refetch()}>{t.common.retry}</Button>}
      >
        {isApiError(version.error) ? version.error.message : t.api.network}
      </Notice>
    ) : (
      <SkeletonRegion className={styles.form}>
        <Skeleton className={styles.previewIframeSkeleton} />
      </SkeletonRegion>
    );
  }
  return (
    <EmailPreview
      name={name || template.name}
      content={shown}
      usesQris={usesQris || /\{\{\s*qris\s*\}\}/.test(shown.html)}
      controls={picker}
    />
  );
}
