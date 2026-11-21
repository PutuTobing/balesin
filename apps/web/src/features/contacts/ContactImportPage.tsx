import {
  CONTACT_IMPORT_ISSUE_LABELS,
  type ContactImportMode,
  type ContactImportResult,
  type IdentityConfirmation,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { FileSpreadsheet, Plus, Trash2 } from 'lucide-react';
import { RadioGroup } from 'radix-ui';
import { useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { SelectField, TextField } from '../../components/ui/Field';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { cx } from '../../lib/cx';
import type { FieldErrors } from '../../lib/form';
import { useLock } from '../../lib/use-lock';
import { IdentityDialog } from '../identity/IdentityDialog';
import { isConfirmationError } from '../identity/confirmation-error';
import { inboxKeys } from '../inbox/inbox-queries';
import { contactAttributesQuery, refreshContactLists } from './contact-queries';
import {
  buildImportMapping,
  guessImportMapping,
  type ImportFields,
  type ImportAttributeRow,
  CUSTOM_KEY as CUSTOM,
} from './import-mapping';
import { ColumnReadFailure, readImportColumns } from './import-columns';
import styles from './Contacts.module.css';

const c = t.contacts;

type ReadState =
  | { kind: 'idle' }
  | { kind: 'reading' }
  | { kind: 'failed'; message: string }
  | { kind: 'ready'; columns: string[] };

/**
 * Impor kontak (`contacts.export`): 1) pilih CSV/XLSX → judul kolom dibaca di browser; 2) cocokkan
 * kolom (nomor wajib, nama, email, catatan, tag, atribut) + mode bila nomor sudah ada; 3) periksa
 * (`dryRun`) lalu impor. Mode "perbarui" wajib konfirmasi identitas (menimpa data massal).
 */
export function ContactImportPage() {
  const queryClient = useQueryClient();
  const definitions = useQuery(contactAttributesQuery).data ?? [];
  const [file, setFile] = useState<File | null>(null);
  const [read, setRead] = useState<ReadState>({ kind: 'idle' });
  const [fields, setFields] = useState<ImportFields | null>(null);
  const [mode, setMode] = useState<ContactImportMode>('upsert');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [checked, setChecked] = useState<ContactImportResult | null>(null);
  const [stale, setStale] = useState(false);
  const [done, setDone] = useState<ContactImportResult | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState<'check' | 'import' | null>(null);
  const [confirming, setConfirming] = useState(false);
  const lock = useLock();
  const fileRef = useRef<HTMLInputElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);

  const columns = read.kind === 'ready' ? read.columns : [];
  const step = done ? 3 : fields ? (checked ? 3 : 2) : 1;

  const pick = async (picked: File) => {
    setFile(picked);
    setFields(null);
    setChecked(null);
    setDone(null);
    setError(null);
    setErrors({});
    setRead({ kind: 'reading' });
    try {
      const found = await readImportColumns(picked);
      // Tebakan kolom atribut butuh daftar atribut. Bila berkas dipilih sebelum daftar itu termuat,
      // tunggu dulu (audit akhir QA S2: dulu kolom atribut terbuang diam-diam). Gagal memuat
      // atribut → tebak tanpa atribut; pengguna masih bisa memetakannya sendiri.
      const known = await queryClient
        .ensureQueryData(contactAttributesQuery)
        .then((data) => contactAttributesQuery.select?.(data) ?? definitions)
        .catch(() => definitions);
      setRead({ kind: 'ready', columns: found });
      setFields(guessImportMapping(found, known));
    } catch (caught) {
      const reason = caught instanceof ColumnReadFailure ? caught.reason : 'unreadable';
      setRead({
        kind: 'failed',
        message:
          reason === 'too_big'
            ? c.fileTooBig
            : reason === 'old_excel'
              ? c.fileOldExcel
              : c.fileUnreadable,
      });
    }
  };

  const change = (update: (current: ImportFields) => ImportFields) => {
    if (!fields) return;
    setFields(update(fields));
    setErrors({});
    if (checked) setStale(true);
  };

  const send = async (dryRun: boolean, confirmation?: IdentityConfirmation) => {
    if (!file || !fields) return null;
    const built = buildImportMapping(fields, columns);
    if (!built.ok) {
      setErrors(built.errors);
      return null;
    }
    setError(null);
    return endpoints.crm.importContacts(file, {
      ...built.mapping,
      mode,
      dryRun,
      ...(confirmation ? { confirmation } : {}),
    });
  };

  const handleFailure = (caught: unknown) => {
    if (isApiError(caught) && caught.status === 429 && caught.retryAfterSeconds) {
      lock.lockFor(caught.retryAfterSeconds);
    }
    if (
      isApiError(caught) &&
      caught.details.some((detail) => detail.field.startsWith('mapping.'))
    ) {
      const next: FieldErrors = {};
      for (const detail of caught.details)
        next[detail.field.replace(/^mapping\./, '')] = detail.message;
      setErrors(next);
    }
    setError(caught);
  };

  const check = async () => {
    setBusy('check');
    try {
      const result = await send(true);
      if (result) {
        setChecked(result);
        setStale(false);
      }
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  const finish = (result: ContactImportResult) => {
    setDone(result);
    refreshContactLists(queryClient);
    void queryClient.invalidateQueries({ queryKey: inboxKeys.tags });
    void queryClient.invalidateQueries({ queryKey: inboxKeys.conversationLists });
  };

  const runImport = async () => {
    if (mode === 'upsert') {
      setConfirming(true);
      return;
    }
    setBusy('import');
    try {
      const result = await send(false);
      if (result) finish(result);
    } catch (caught) {
      handleFailure(caught);
    } finally {
      setBusy(null);
    }
  };

  const confirmImport = async (confirmation: IdentityConfirmation) => {
    try {
      const result = await send(false, confirmation);
      setConfirming(false);
      if (result) finish(result);
    } catch (caught) {
      if (isConfirmationError(caught)) throw caught;
      setConfirming(false);
      handleFailure(caught);
    }
  };

  const restart = () => {
    setFile(null);
    setFields(null);
    setChecked(null);
    setDone(null);
    setRead({ kind: 'idle' });
    if (fileRef.current) fileRef.current.value = '';
  };

  const columnOptions = (optional: boolean) => [
    ...(optional
      ? [{ value: '', label: c.noColumn }]
      : [{ value: '', label: t.attributes.selectPlaceholder }]),
    ...columns.map((column) => ({ value: column, label: column })),
  ];

  return (
    <Page>
      <div className={styles.narrow}>
        <p className={styles.intro}>{c.importIntro}</p>
        <ol className={styles.steps}>
          {[c.importStepFile, c.importStepMapping, c.importStepCheck].map((label, index) => (
            <li
              key={label}
              className={styles.step}
              data-state={index + 1 === step ? 'current' : index + 1 < step ? 'done' : 'todo'}
              aria-current={index + 1 === step ? 'step' : undefined}
            >
              <span className={styles.stepNumber} aria-hidden="true">
                {index + 1}
              </span>
              {label}
            </li>
          ))}
        </ol>

        {done ? (
          <section className={styles.card} aria-labelledby="impor-hasil">
            <h2 id="impor-hasil" className={styles.cardTitle}>
              {c.resultTitle}
            </h2>
            <ResultSummary result={done} />
            <div className={styles.actions}>
              <Button variant="primary" asChild>
                <Link to="/kontak">{c.viewContacts}</Link>
              </Button>
              <Button onClick={restart}>{c.importAgain}</Button>
            </div>
          </section>
        ) : (
          <>
            <section className={styles.card} aria-labelledby="impor-berkas">
              <h2 id="impor-berkas" className={styles.cardTitle}>
                {c.importStepFile}
              </h2>
              <input
                ref={fileRef}
                type="file"
                accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
                className={styles.fileInput}
                data-testid="impor-kontak-berkas"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => {
                  const picked = event.target.files?.[0];
                  if (picked) void pick(picked);
                }}
              />
              <div className={styles.fileRow}>
                <Button loading={read.kind === 'reading'} onClick={() => fileRef.current?.click()}>
                  {read.kind === 'reading' ? null : <Icon icon={FileSpreadsheet} size={16} />}
                  {read.kind === 'reading' ? c.readingFile : file ? c.changeFile : c.pickFile}
                </Button>
                {file ? <span className={styles.fileName}>{file.name}</span> : null}
                {read.kind === 'ready' ? (
                  <span className={styles.hint}>{c.fileColumns(read.columns.length)}</span>
                ) : null}
              </div>
              {read.kind === 'failed' ? (
                <Notice tone="danger" role="alert">
                  {read.message}
                </Notice>
              ) : null}
            </section>

            {fields ? (
              <section className={styles.card} aria-labelledby="impor-kolom">
                <div>
                  <h2 id="impor-kolom" className={styles.cardTitle}>
                    {c.importStepMapping}
                  </h2>
                  <p className={styles.hint}>{c.mappingIntro}</p>
                </div>
                <div className={styles.mappingGrid}>
                  <SelectField
                    label={c.phoneColumn}
                    hint={c.phoneColumnHint}
                    value={fields.phone}
                    onChange={(event) =>
                      change((current) => ({ ...current, phone: event.target.value }))
                    }
                    options={columnOptions(false)}
                    error={errors.phoneColumn}
                  />
                  <SelectField
                    label={c.nameColumn}
                    value={fields.name}
                    onChange={(event) =>
                      change((current) => ({ ...current, name: event.target.value }))
                    }
                    options={columnOptions(true)}
                    error={errors.nameColumn}
                  />
                  <SelectField
                    label={c.emailColumn}
                    value={fields.email}
                    onChange={(event) =>
                      change((current) => ({ ...current, email: event.target.value }))
                    }
                    options={columnOptions(true)}
                    error={errors.emailColumn}
                  />
                  <SelectField
                    label={c.notesColumn}
                    value={fields.notes}
                    onChange={(event) =>
                      change((current) => ({ ...current, notes: event.target.value }))
                    }
                    options={columnOptions(true)}
                    error={errors.notesColumn}
                  />
                  <SelectField
                    label={c.tagsColumn}
                    hint={c.tagsColumnHint}
                    value={fields.tags}
                    onChange={(event) =>
                      change((current) => ({ ...current, tags: event.target.value }))
                    }
                    options={columnOptions(true)}
                    error={errors.tagsColumn}
                  />
                </div>

                <fieldset className={styles.attributeRows}>
                  <legend className={styles.cardTitle}>{c.attributesTitle}</legend>
                  <p className={styles.hint}>{c.attributesHint}</p>
                  {fields.attributes.map((row, index) => (
                    <AttributeMappingRow
                      key={row.id}
                      row={row}
                      columnOptions={columnOptions(false)}
                      keyOptions={[
                        { value: '', label: t.attributes.selectPlaceholder },
                        ...definitions.map((item) => ({ value: item.key, label: item.label })),
                        { value: CUSTOM, label: c.attributeKeyCustomOption },
                      ]}
                      errors={{
                        column: errors[`attributes.${String(index)}.column`],
                        key: errors[`attributes.${String(index)}.key`],
                      }}
                      onChange={(next) =>
                        change((current) => ({
                          ...current,
                          attributes: current.attributes.map((item) =>
                            item.id === row.id ? next : item,
                          ),
                        }))
                      }
                      onRemove={() =>
                        change((current) => ({
                          ...current,
                          attributes: current.attributes.filter((item) => item.id !== row.id),
                        }))
                      }
                    />
                  ))}
                  {fields.attributes.length < 30 ? (
                    <Button
                      variant="ghost"
                      className={styles.alignStart}
                      onClick={() =>
                        change((current) => ({
                          ...current,
                          attributes: [
                            ...current.attributes,
                            { id: current.nextId, column: '', key: '', customKey: '' },
                          ],
                          nextId: current.nextId + 1,
                        }))
                      }
                    >
                      <Icon icon={Plus} size={16} />
                      {c.addAttributeColumn}
                    </Button>
                  ) : null}
                </fieldset>

                <fieldset className={styles.modes}>
                  <legend className={styles.cardTitle}>{c.modeTitle}</legend>
                  <RadioGroup.Root
                    className={styles.modes}
                    value={mode}
                    onValueChange={(value) => {
                      setMode(value === 'create_only' ? 'create_only' : 'upsert');
                      if (checked) setStale(true);
                    }}
                    aria-label={c.modeTitle}
                  >
                    {(
                      [
                        ['upsert', c.modeUpsert, c.modeUpsertHint],
                        ['create_only', c.modeCreateOnly, c.modeCreateOnlyHint],
                      ] as const
                    ).map(([value, label, hint]) => (
                      <RadioGroup.Item key={value} value={value} className={styles.modeOption}>
                        <span className={styles.radio}>
                          <RadioGroup.Indicator className={styles.radioDot} />
                        </span>
                        <span className={styles.modeText}>
                          <span className={styles.modeLabel}>{label}</span>
                          <span className={styles.hint}>{hint}</span>
                        </span>
                      </RadioGroup.Item>
                    ))}
                  </RadioGroup.Root>
                </fieldset>
              </section>
            ) : null}

            {fields ? (
              <section className={styles.card} aria-labelledby="impor-periksa">
                <h2 id="impor-periksa" className={styles.cardTitle}>
                  {checked ? c.resultDryTitle : c.importStepCheck}
                </h2>
                {checked ? (
                  <ResultSummary result={checked} dryRun />
                ) : (
                  <p className={styles.hint}>{c.checkHint}</p>
                )}
                {checked && stale ? (
                  <Notice tone="warning" role="status">
                    {c.remapAfterChange}
                  </Notice>
                ) : null}
                <div className={styles.actions}>
                  <Button
                    variant={checked && !stale ? 'secondary' : 'primary'}
                    loading={busy === 'check'}
                    disabled={busy !== null || lock.locked}
                    onClick={() => void check()}
                  >
                    {busy === 'check' ? c.checking : c.check}
                  </Button>
                  {checked && !stale ? (
                    <Button
                      ref={importRef}
                      variant="primary"
                      loading={busy === 'import'}
                      disabled={busy !== null || lock.locked}
                      onClick={() => void runImport()}
                    >
                      {busy === 'import' ? c.importing : c.runImport}
                    </Button>
                  ) : null}
                </div>
                {error ? (
                  <FormErrorNotice error={error} lock={lock} lockedTitle={c.importLockedTitle} />
                ) : null}
              </section>
            ) : null}
          </>
        )}
      </div>
      <IdentityDialog
        open={confirming}
        title={c.importConfirmTitle}
        body={c.importConfirmBody}
        confirmLabel={c.importConfirm}
        pendingLabel={c.importing}
        requireCode
        onConfirm={confirmImport}
        onCancel={() => setConfirming(false)}
        returnFocusRef={importRef}
      />
    </Page>
  );
}

function AttributeMappingRow({
  row,
  columnOptions,
  keyOptions,
  errors,
  onChange,
  onRemove,
}: {
  row: ImportAttributeRow;
  columnOptions: { value: string; label: string }[];
  keyOptions: { value: string; label: string }[];
  errors: { column?: string; key?: string };
  onChange: (row: ImportAttributeRow) => void;
  onRemove: () => void;
}) {
  const custom = row.key === CUSTOM;
  return (
    <div className={styles.attributeRow} data-custom={custom ? 'true' : 'false'}>
      <SelectField
        label={c.attributeColumn}
        value={row.column}
        onChange={(event) => onChange({ ...row, column: event.target.value })}
        options={columnOptions}
        error={errors.column}
      />
      <SelectField
        label={c.attributeKey}
        value={row.key}
        onChange={(event) => onChange({ ...row, key: event.target.value })}
        options={keyOptions}
        error={custom ? undefined : errors.key}
      />
      {custom ? (
        <TextField
          label={c.attributeKeyCustom}
          value={row.customKey}
          onChange={(event) => onChange({ ...row, customKey: event.target.value })}
          maxLength={40}
          error={errors.key}
        />
      ) : null}
      <IconButton
        label={c.removeAttributeColumn(row.column)}
        icon={Trash2}
        onClick={onRemove}
        className={styles.removeButton}
      />
    </div>
  );
}

function ResultSummary({
  result,
  dryRun = false,
}: {
  result: ContactImportResult;
  dryRun?: boolean;
}) {
  const issueTotal = result.skipped;
  const stats = [
    [dryRun ? c.willCreate : c.resultCreated, result.created],
    [dryRun ? c.willUpdate : c.resultUpdated, result.updated],
    [c.resultUnchanged, result.unchanged],
    [c.resultSkipped, result.skipped],
  ] as const;
  return (
    <>
      <p className={styles.hint}>{c.resultRows(result.sourceRows)}</p>
      <dl className={styles.stats}>
        {stats.map(([label, value]) => (
          <div key={label} className={styles.stat}>
            <dt className={styles.statLabel}>{label}</dt>
            <dd className={cx(styles.statValue)}>{value.toLocaleString('id-ID')}</dd>
          </div>
        ))}
      </dl>
      {result.issues.length === 0 ? (
        issueTotal === 0 ? (
          <p className={styles.hint}>{c.noIssues}</p>
        ) : null
      ) : (
        <div>
          <h3 className={styles.subTitle}>{c.issuesTitle}</h3>
          <div className={styles.issuesScroll}>
            <table className={styles.issues}>
              <thead>
                <tr>
                  <th scope="col">{c.issueRow}</th>
                  <th scope="col">{c.issueReason}</th>
                </tr>
              </thead>
              <tbody>
                {result.issues.map((issue) => (
                  <tr key={`${String(issue.row)}-${issue.issue}-${issue.key ?? ''}`}>
                    <td>{issue.row}</td>
                    <td>
                      {issue.key
                        ? c.issueWithKey(CONTACT_IMPORT_ISSUE_LABELS[issue.issue], issue.key)
                        : CONTACT_IMPORT_ISSUE_LABELS[issue.issue]}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {issueTotal > result.issues.length ? (
            <p className={styles.hint}>{c.issuesMore(result.issues.length, issueTotal)}</p>
          ) : null}
        </div>
      )}
    </>
  );
}
