import type { MessageTemplate } from '@balesin/shared';
import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ChevronRight, FileText, Image as ImageIcon, LayoutTemplate, Video } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import { Button } from '../../components/ui/Button';
import { TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { SearchField } from '../../components/ui/SearchField';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { useCan } from '../auth/session';
import { TemplateBubble } from './TemplateBubble';
import { MEDIA_ACCEPT, fillSpec, type FillValues } from './template-fill';
import { approvedTemplatesQuery } from './template-queries';
import styles from './TemplatePicker.module.css';

const s = t.inbox.templateSend;
const c = t.templates;

/**
 * Daftar template DISETUJUI untuk satu nomor, dengan cari. `allowMedia = false` (percakapan baru):
 * template berjudul berkas ditampilkan nonaktif dengan alasannya (unggahan butuh percakapan).
 */
export function ApprovedTemplateList({
  channelId,
  allowMedia,
  onPick,
}: {
  channelId: string;
  allowMedia: boolean;
  onPick: (template: MessageTemplate) => void;
}) {
  const list = useQuery(approvedTemplatesQuery(channelId));
  const canManage = useCan('templates.manage');
  const [search, setSearch] = useState('');
  const items = useMemo(() => {
    const needle = search.trim().toLowerCase();
    return (list.data?.templates ?? []).filter(
      (template) =>
        !needle ||
        template.name.toLowerCase().includes(needle) ||
        template.content.body.text.toLowerCase().includes(needle),
    );
  }, [list.data, search]);

  if (list.isPending) {
    return (
      <SkeletonRegion className={styles.list}>
        {[0, 1, 2].map((index) => (
          <Skeleton key={index} className={styles.skeleton} />
        ))}
      </SkeletonRegion>
    );
  }
  if (list.isError) {
    return (
      <Notice
        tone="danger"
        role="alert"
        actions={
          <Button variant="ghost" onClick={() => void list.refetch()}>
            {s.retry}
          </Button>
        }
      >
        {s.loadFailed}
      </Notice>
    );
  }
  if (list.data.templates.length === 0) {
    return (
      <div className={styles.empty}>
        <Icon icon={LayoutTemplate} size={20} className={styles.emptyIcon} />
        <p>{s.empty}</p>
        {canManage ? (
          <Link to="/pengaturan/template" className={styles.link}>
            {s.manage}
          </Link>
        ) : null}
      </div>
    );
  }
  return (
    <div className={styles.picker}>
      {list.data.templates.length > 4 ? (
        <SearchField
          value={search}
          onChange={setSearch}
          label={s.searchLabel}
          placeholder={s.searchPlaceholder}
          clearLabel={s.clearSearch}
          maxLength={100}
        />
      ) : null}
      {items.length === 0 ? (
        <p className={styles.note}>{s.notFound(search.trim())}</p>
      ) : (
        <ul className={styles.list} aria-label={s.listLabel}>
          {items.map((template) => {
            const media =
              template.content.header && template.content.header.format !== 'TEXT'
                ? template.content.header.format
                : null;
            const blocked = media !== null && !allowMedia;
            const otp = template.category === 'AUTHENTICATION';
            return (
              <li key={template.id}>
                <button
                  type="button"
                  className={styles.option}
                  disabled={blocked}
                  onClick={() => onPick(template)}
                >
                  <span className={styles.optionText}>
                    <span className={styles.optionName}>{template.name}</span>
                    <span className={styles.optionMeta}>
                      {media ? (
                        <Icon
                          icon={
                            media === 'IMAGE' ? ImageIcon : media === 'VIDEO' ? Video : FileText
                          }
                          size={16}
                        />
                      ) : null}
                      {c.categoryShort[template.category]}
                    </span>
                    <span className={styles.optionBody} dir="auto">
                      {blocked
                        ? s.mediaOnlyInChat
                        : otp
                          ? c.otpPreview('{{1}}')
                          : template.content.body.text}
                    </span>
                  </span>
                  <Icon icon={ChevronRight} size={16} className={styles.chevron} />
                </button>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Isian variabel + berkas judul + pratinjau langsung untuk satu template. */
export function TemplateFillFields({
  template,
  values,
  onChange,
  errors,
  file,
  onFile,
}: {
  template: MessageTemplate;
  values: FillValues;
  onChange: (values: FillValues) => void;
  errors: Readonly<Record<string, string>>;
  file: File | null;
  onFile: (file: File | null) => void;
}) {
  const spec = fillSpec(template);
  const fileRef = useRef<HTMLInputElement>(null);
  const hasFields =
    spec.otp ||
    spec.headerVariable !== null ||
    spec.headerMedia !== null ||
    spec.body.length > 0 ||
    spec.buttons.length > 0;
  return (
    <div className={styles.fill}>
      {hasFields ? (
        <div className={styles.fields}>
          {spec.otp ? (
            <TextField
              label={s.otpCode}
              hint={s.otpHint}
              value={values.body['1'] ?? ''}
              onChange={(event) =>
                onChange({ ...values, body: { ...values.body, '1': event.target.value } })
              }
              error={errors['parameters.body.1']}
              autoComplete="off"
              inputMode="numeric"
              maxLength={15}
              className={styles.short}
            />
          ) : null}
          {spec.headerMedia ? (
            <div className={styles.mediaField}>
              <span className={styles.label}>{s.headerMedia(c.mediaHeader[spec.headerMedia])}</span>
              <input
                ref={fileRef}
                type="file"
                accept={MEDIA_ACCEPT[spec.headerMedia]}
                className="sr-only"
                tabIndex={-1}
                aria-hidden="true"
                onChange={(event) => onFile(event.target.files?.[0] ?? null)}
                data-testid="template-media"
              />
              <div className={styles.mediaRow}>
                <Button onClick={() => fileRef.current?.click()}>
                  {file ? s.headerMediaChange : s.headerMediaPick}
                </Button>
                {file ? (
                  <span className={styles.fileName} dir="auto">
                    {file.name}
                  </span>
                ) : null}
              </div>
              {errors['parameters.header.mediaId'] ? (
                <p className={styles.error} role="alert">
                  {errors['parameters.header.mediaId']}
                </p>
              ) : (
                <p className={styles.hint}>{s.headerMediaHint}</p>
              )}
            </div>
          ) : null}
          {spec.headerVariable ? (
            <TextField
              label={s.headerValue(spec.headerVariable)}
              value={values.header}
              onChange={(event) => onChange({ ...values, header: event.target.value })}
              error={errors['parameters.header.text']}
              maxLength={1024}
            />
          ) : null}
          {spec.otp
            ? null
            : spec.body.map((name) => (
                <TextField
                  key={name}
                  label={s.bodyValue(name)}
                  value={values.body[name] ?? ''}
                  hint={
                    template.content.body.examples[name]
                      ? s.exampleHint(template.content.body.examples[name])
                      : undefined
                  }
                  onChange={(event) =>
                    onChange({ ...values, body: { ...values.body, [name]: event.target.value } })
                  }
                  error={errors[`parameters.body.${name}`]}
                  maxLength={1024}
                />
              ))}
          {spec.buttons.map((button) => (
            <TextField
              key={button.index}
              label={button.kind === 'URL' ? s.buttonValue(button.text) : s.copyCodeValue}
              value={values.buttons[String(button.index)] ?? ''}
              onChange={(event) =>
                onChange({
                  ...values,
                  buttons: { ...values.buttons, [String(button.index)]: event.target.value },
                })
              }
              error={errors[`parameters.buttons.${String(button.index)}`]}
              maxLength={button.kind === 'COPY_CODE' ? 15 : 1024}
            />
          ))}
        </div>
      ) : null}
      <div className={styles.stage}>
        <TemplateBubble
          content={template.content}
          category={template.category}
          values={values.body}
          headerValue={values.header}
          mediaName={file?.name ?? null}
          otpCode={values.body['1'] ?? ''}
        />
      </div>
    </div>
  );
}
