import {
  INTERACTIVE_LIMITS,
  interactiveMessageSchema,
  type Conversation,
  type InteractiveMessage,
} from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { zodFieldErrors, type FieldErrors } from '../../lib/form';
import styles from './Composer.module.css';
import { inboxKeys, scheduleListRefresh } from './inbox-queries';

const k = t.inbox.compose;
const L = INTERACTIVE_LIMITS;

interface Row {
  key: number;
  title: string;
  description: string;
}
interface Section {
  key: number;
  title: string;
  rows: Row[];
}

let keySeq = 0;
const nextKey = () => (keySeq += 1);
const emptyRow = (): Row => ({ key: nextKey(), title: '', description: '' });

/** Penghitung karakter sebagai petunjuk isian ("12/20"). */
const count = (value: string, max: number) => k.ivCount(value.length, max);
const optional = (value: string) => (value.trim() ? value : undefined);

/**
 * Susun pesan interaktif (tombol balasan ≤ 3 atau daftar ≤ 10 pilihan) dengan batas Meta dari
 * `INTERACTIVE_LIMITS`; divalidasi `interactiveMessageSchema` sebelum dikirim. ID pilihan dibuat
 * otomatis (`pilihan-1`, …) — yang dibaca bot/n8n saat pelanggan memilih.
 */
export function InteractiveDialog({
  conversation,
  onClose,
}: {
  conversation: Conversation;
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [kind, setKind] = useState<InteractiveMessage['kind']>('button');
  const [body, setBody] = useState('');
  const [header, setHeader] = useState('');
  const [footer, setFooter] = useState('');
  const [buttons, setButtons] = useState<Row[]>([emptyRow(), emptyRow()]);
  const [listButton, setListButton] = useState('');
  const [sections, setSections] = useState<Section[]>([
    { key: nextKey(), title: '', rows: [emptyRow(), emptyRow()] },
  ]);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [sending, setSending] = useState(false);
  const totalRows = sections.reduce((total, section) => total + section.rows.length, 0);

  const build = () => {
    let index = 0;
    return kind === 'button'
      ? {
          kind,
          body,
          header: optional(header),
          footer: optional(footer),
          buttons: buttons.map((button, position) => ({
            id: `tombol-${String(position + 1)}`,
            title: button.title,
          })),
        }
      : {
          kind,
          body,
          header: optional(header),
          footer: optional(footer),
          buttonText: listButton,
          sections: sections.map((section) => ({
            title: optional(section.title),
            rows: section.rows.map((row) => {
              index += 1;
              return {
                id: `pilihan-${String(index)}`,
                title: row.title,
                description: optional(row.description),
              };
            }),
          })),
        };
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const parsed = interactiveMessageSchema.safeParse(build());
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    setSending(true);
    try {
      await endpoints.inbox.send(conversation.id, {
        type: 'interactive',
        clientMessageId: crypto.randomUUID(),
        interactive: parsed.data,
      });
      void queryClient.invalidateQueries({ queryKey: inboxKeys.messages(conversation.id) });
      scheduleListRefresh(queryClient);
      onClose();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setSending(false);
    }
  };

  const updateSection = (key: number, change: (section: Section) => Section) =>
    setSections((current) =>
      current.map((section) => (section.key === key ? change(section) : section)),
    );

  return (
    <Dialog
      open
      title={k.interactiveTitle}
      description={k.interactiveHint}
      onRequestClose={onClose}
    >
      <form
        className={styles.ivForm}
        onSubmit={(event) => void submit(event)}
        // Galat isian hilang begitu pengguna mengetik lagi (penghitung karakter tampil kembali).
        onChange={() => {
          if (Object.keys(errors).length > 0) setErrors({});
        }}
        noValidate
      >
        <div className={styles.ivKinds} role="radiogroup" aria-label={k.interactiveKindLabel}>
          {(['button', 'list'] as const).map((item) => (
            <button
              key={item}
              type="button"
              role="radio"
              aria-checked={kind === item}
              className={styles.ivKind}
              onClick={() => {
                setKind(item);
                setErrors({});
              }}
            >
              {k.interactiveKinds[item]}
            </button>
          ))}
        </div>
        <TextField
          label={k.ivHeader}
          hint={count(header, L.header)}
          value={header}
          onChange={(event) => setHeader(event.target.value)}
          error={errors.header}
          maxLength={L.header}
          dir="auto"
        />
        <TextAreaField
          label={k.ivBody}
          hint={count(body, L.body)}
          value={body}
          onChange={(event) => setBody(event.target.value)}
          error={errors.body}
          maxLength={L.body}
          rows={3}
          dir="auto"
        />
        {kind === 'button' ? (
          <fieldset className={styles.ivGroup}>
            <legend className={styles.ivLegend}>
              {k.ivButtonsCount(buttons.length, L.buttonsMax)}
            </legend>
            {buttons.map((button, position) => (
              <div key={button.key} className={styles.ivRow}>
                <TextField
                  label={k.ivButton(position + 1)}
                  hint={count(button.title, L.buttonTitle)}
                  value={button.title}
                  onChange={(event) =>
                    setButtons((current) =>
                      current.map((item) =>
                        item.key === button.key ? { ...item, title: event.target.value } : item,
                      ),
                    )
                  }
                  error={errors[`buttons.${String(position)}.title`]}
                  maxLength={L.buttonTitle}
                  dir="auto"
                />
                {buttons.length > 1 ? (
                  <IconButton
                    label={k.ivRemoveButton(position + 1)}
                    icon={Trash2}
                    onClick={() =>
                      setButtons((current) => current.filter((item) => item.key !== button.key))
                    }
                  />
                ) : null}
              </div>
            ))}
            {errors.buttons ? <p className={styles.ivError}>{errors.buttons}</p> : null}
            {buttons.length < L.buttonsMax ? (
              <Button
                variant="ghost"
                onClick={() => setButtons((current) => [...current, emptyRow()])}
              >
                <Icon icon={Plus} size={16} />
                {k.ivAddButton}
              </Button>
            ) : null}
          </fieldset>
        ) : (
          <>
            <TextField
              label={k.ivListButton}
              hint={count(listButton, L.listButton)}
              placeholder={k.ivListButtonPlaceholder}
              value={listButton}
              onChange={(event) => setListButton(event.target.value)}
              error={errors.buttonText}
              maxLength={L.listButton}
              dir="auto"
            />
            <p className={styles.ivCount}>{k.ivRowsCount(totalRows, L.rowsMax)}</p>
            {sections.map((section, sectionIndex) => (
              <fieldset key={section.key} className={styles.ivGroup}>
                <legend className={styles.ivLegend}>{k.ivSection(sectionIndex + 1)}</legend>
                <div className={styles.ivRow}>
                  <TextField
                    label={k.ivSectionTitle}
                    hint={
                      sections.length > 1
                        ? `${k.ivSectionTitleHint} ${count(section.title, L.sectionTitle)}`
                        : count(section.title, L.sectionTitle)
                    }
                    value={section.title}
                    onChange={(event) =>
                      updateSection(section.key, (current) => ({
                        ...current,
                        title: event.target.value,
                      }))
                    }
                    error={errors[`sections.${String(sectionIndex)}.title`]}
                    maxLength={L.sectionTitle}
                    dir="auto"
                  />
                  {sections.length > 1 ? (
                    <IconButton
                      label={k.ivRemoveSection(sectionIndex + 1)}
                      icon={Trash2}
                      onClick={() =>
                        setSections((current) => current.filter((item) => item.key !== section.key))
                      }
                    />
                  ) : null}
                </div>
                {section.rows.map((row, rowIndex) => (
                  <div key={row.key} className={styles.ivListRow}>
                    <TextField
                      label={k.ivRow(rowIndex + 1)}
                      hint={count(row.title, L.rowTitle)}
                      value={row.title}
                      onChange={(event) =>
                        updateSection(section.key, (current) => ({
                          ...current,
                          rows: current.rows.map((item) =>
                            item.key === row.key ? { ...item, title: event.target.value } : item,
                          ),
                        }))
                      }
                      error={
                        errors[`sections.${String(sectionIndex)}.rows.${String(rowIndex)}.title`]
                      }
                      maxLength={L.rowTitle}
                      dir="auto"
                    />
                    <TextField
                      label={k.ivRowDescription}
                      hint={count(row.description, L.rowDescription)}
                      value={row.description}
                      onChange={(event) =>
                        updateSection(section.key, (current) => ({
                          ...current,
                          rows: current.rows.map((item) =>
                            item.key === row.key
                              ? { ...item, description: event.target.value }
                              : item,
                          ),
                        }))
                      }
                      maxLength={L.rowDescription}
                      dir="auto"
                    />
                    {section.rows.length > 1 ? (
                      <IconButton
                        label={k.ivRemoveRow(rowIndex + 1)}
                        icon={Trash2}
                        onClick={() =>
                          updateSection(section.key, (current) => ({
                            ...current,
                            rows: current.rows.filter((item) => item.key !== row.key),
                          }))
                        }
                      />
                    ) : null}
                  </div>
                ))}
                {totalRows < L.rowsMax ? (
                  <Button
                    variant="ghost"
                    onClick={() =>
                      updateSection(section.key, (current) => ({
                        ...current,
                        rows: [...current.rows, emptyRow()],
                      }))
                    }
                  >
                    <Icon icon={Plus} size={16} />
                    {k.ivAddRow}
                  </Button>
                ) : null}
              </fieldset>
            ))}
            {errors.sections ? <p className={styles.ivError}>{errors.sections}</p> : null}
            {totalRows < L.rowsMax && sections.length < L.sectionsMax ? (
              <Button
                variant="ghost"
                onClick={() =>
                  setSections((current) => [
                    ...current,
                    { key: nextKey(), title: '', rows: [emptyRow()] },
                  ])
                }
              >
                <Icon icon={Plus} size={16} />
                {k.ivAddSection}
              </Button>
            ) : null}
          </>
        )}
        <TextField
          label={k.ivFooter}
          hint={count(footer, L.footer)}
          value={footer}
          onChange={(event) => setFooter(event.target.value)}
          error={errors.footer}
          maxLength={L.footer}
          dir="auto"
        />
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        <DialogActions sticky>
          <Button onClick={onClose}>{k.ivCancel}</Button>
          <Button type="submit" variant="primary" loading={sending}>
            {sending ? k.ivSending : k.ivSend}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
