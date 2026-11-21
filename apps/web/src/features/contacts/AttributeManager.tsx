import {
  ATTRIBUTE_DEFINITION_LIMITS,
  ATTRIBUTE_TYPES,
  ATTRIBUTE_TYPE_LABELS,
  createAttributeDefinitionRequestSchema,
  updateAttributeDefinitionRequestSchema,
  type AttributeDefinition,
  type AttributeType,
} from '@balesin/shared';
import { useMutation } from '@tanstack/react-query';
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2 } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { ZodError } from 'zod';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SelectField, TextAreaField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import type { AttributeScope } from '../../lib/api/endpoints-crm';
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import styles from './Attributes.module.css';

const a = t.attributes;

/**
 * Kelola definisi atribut (kontak organisasi atau tiket per board): daftar urut posisi, tambah,
 * ubah (kunci tetap), naik/turun, hapus (nilai tersimpan menjadi atribut bebas). Pemanggil memuat
 * datanya dan menyegarkan cache lewat `onChanged`.
 */
export function AttributeManager({
  scope,
  attributes,
  max,
  onChanged,
}: {
  scope: AttributeScope;
  attributes: readonly AttributeDefinition[];
  max: number;
  onChanged: () => void;
}) {
  const [editing, setEditing] = useState<AttributeDefinition | 'new' | null>(null);
  const [removing, setRemoving] = useState<AttributeDefinition | null>(null);
  const [error, setError] = useState<unknown>(null);

  const move = useMutation({
    // Server menyimpan posisi apa adanya (tanpa menggeser yang lain): urutan baru ditulis ulang
    // 0..n-1 untuk setiap definisi yang posisinya berubah.
    mutationFn: async ({ item, position }: { item: AttributeDefinition; position: number }) => {
      const order = attributes.filter((other) => other.id !== item.id);
      order.splice(position, 0, item);
      for (const [index, other] of order.entries()) {
        if (other.position !== index) {
          await endpoints.attributes.update(scope, other.id, { position: index });
        }
      }
    },
    onMutate: () => setError(null),
    onSuccess: onChanged,
    onError: setError,
  });
  const remove = useMutation({
    mutationFn: (item: AttributeDefinition) => endpoints.attributes.remove(scope, item.id),
    onMutate: () => setError(null),
    onSuccess: () => {
      setRemoving(null);
      onChanged();
    },
    onError: (caught) => {
      setRemoving(null);
      setError(caught);
    },
  });

  return (
    <div className={styles.manager}>
      {attributes.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>{a.emptyTitle}</p>
          <p className={styles.hint}>{a.emptyBody}</p>
        </div>
      ) : (
        <ul className={styles.list} aria-label={a.listLabel}>
          {attributes.map((item, index) => (
            <li key={item.id} className={styles.row}>
              <span className={styles.rowMain}>
                <span className={styles.rowLabel}>
                  {item.label}
                  {item.required ? <span className={styles.badge}>{a.requiredBadge}</span> : null}
                </span>
                <span className={styles.rowMeta}>
                  <code className={styles.key}>{item.key}</code>
                  <span aria-hidden="true">·</span>
                  {ATTRIBUTE_TYPE_LABELS[item.type]}
                  {item.type === 'select' ? (
                    <>
                      <span aria-hidden="true">·</span>
                      {a.optionsCount(item.options.length)}
                    </>
                  ) : null}
                </span>
              </span>
              <span className={styles.rowActions}>
                <IconButton
                  label={a.moveUp(item.label)}
                  icon={ArrowUp}
                  disabled={index === 0 || move.isPending}
                  onClick={() => move.mutate({ item, position: index - 1 })}
                />
                <IconButton
                  label={a.moveDown(item.label)}
                  icon={ArrowDown}
                  disabled={index === attributes.length - 1 || move.isPending}
                  onClick={() => move.mutate({ item, position: index + 1 })}
                />
                <IconButton
                  label={a.edit(item.label)}
                  icon={Pencil}
                  onClick={() => setEditing(item)}
                />
                <IconButton
                  label={a.remove(item.label)}
                  icon={Trash2}
                  onClick={() => setRemoving(item)}
                />
              </span>
            </li>
          ))}
        </ul>
      )}
      {error ? (
        <Notice tone="danger" role="alert">
          {isApiError(error) ? error.message : t.api.network}
        </Notice>
      ) : null}
      {attributes.length < max ? (
        <Button className={styles.add} onClick={() => setEditing('new')}>
          <Icon icon={Plus} size={16} />
          {a.add}
        </Button>
      ) : (
        <p className={styles.hint}>{a.limit(max)}</p>
      )}
      {editing ? (
        <AttributeDialog
          scope={scope}
          attribute={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            onChanged();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={removing ? a.removeTitle(removing.label) : ''}
        body={a.removeBody}
        cancelLabel={a.cancel}
        confirmLabel={a.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => removing && remove.mutate(removing)}
      />
    </div>
  );
}

function AttributeDialog({
  scope,
  attribute,
  onClose,
  onSaved,
}: {
  scope: AttributeScope;
  attribute: AttributeDefinition | null;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [key, setKey] = useState(attribute?.key ?? '');
  const [label, setLabel] = useState(attribute?.label ?? '');
  const [type, setType] = useState<AttributeType>(attribute?.type ?? 'text');
  const [required, setRequired] = useState(attribute?.required ?? false);
  const [options, setOptions] = useState((attribute?.options ?? []).join('\n'));
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: () => {
      const optionList =
        type === 'select'
          ? options
              .split('\n')
              .map((item) => item.trim())
              .filter(Boolean)
          : [];
      if (attribute) {
        const parsed = updateAttributeDefinitionRequestSchema.safeParse({
          label,
          type,
          required,
          options: optionList,
        });
        if (!parsed.success) return Promise.reject(parsed.error);
        return endpoints.attributes.update(scope, attribute.id, parsed.data);
      }
      const parsed = createAttributeDefinitionRequestSchema.safeParse({
        key,
        label,
        type,
        required,
        options: optionList,
      });
      if (!parsed.success) return Promise.reject(parsed.error);
      return endpoints.attributes.create(scope, parsed.data);
    },
    onSuccess: onSaved,
    onError: (caught) => {
      if (caught instanceof ZodError) {
        setErrors(zodFieldErrors(caught));
      } else if (isApiError(caught) && caught.details.length > 0) {
        setErrors(apiFieldErrors(caught.details));
      }
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setErrors({});
    save.mutate();
  };

  const general =
    save.isError &&
    isApiError(save.error) &&
    !(save.error.details.length > 0 && Object.keys(errors).length > 0)
      ? save.error
      : null;

  return (
    <Dialog
      open
      title={attribute ? a.editTitle(attribute.label) : a.createTitle}
      onRequestClose={onClose}
    >
      <form className={styles.form} onSubmit={submit} noValidate>
        {attribute ? null : (
          <TextField
            label={a.key}
            hint={a.keyHint}
            value={key}
            onChange={(event) => setKey(event.target.value)}
            error={errors.key}
            maxLength={40}
            autoComplete="off"
          />
        )}
        <TextField
          label={a.label}
          hint={a.labelHint}
          value={label}
          onChange={(event) => {
            setLabel(event.target.value);
            // Kunci mengikuti label selama belum diubah sendiri.
            if (!attribute && (key === '' || key === label.trim()))
              setKey(event.target.value.trim());
          }}
          error={errors.label}
          maxLength={ATTRIBUTE_DEFINITION_LIMITS.labelMax}
        />
        <SelectField
          label={a.type}
          hint={attribute && attribute.type !== type ? a.typeChangeHint : undefined}
          value={type}
          onChange={(event) => setType(event.target.value as AttributeType)}
          options={ATTRIBUTE_TYPES.map((value) => ({
            value,
            label: ATTRIBUTE_TYPE_LABELS[value],
          }))}
          error={errors.type}
        />
        {type === 'select' ? (
          <TextAreaField
            label={a.options}
            hint={a.optionsHint}
            value={options}
            onChange={(event) => setOptions(event.target.value)}
            error={
              errors.options ??
              Object.entries(errors).find(([field]) => field.startsWith('options.'))?.[1]
            }
            rows={4}
          />
        ) : null}
        <div>
          <Checkbox checked={required} onChange={(event) => setRequired(event.target.checked)}>
            {a.required}
          </Checkbox>
          <p className={styles.hint}>{a.requiredHint}</p>
        </div>
        {general ? (
          <Notice tone="danger" role="alert">
            {general.message}
          </Notice>
        ) : save.isError &&
          !isApiError(save.error) &&
          !(save.error instanceof Error && 'issues' in save.error) ? (
          <Notice tone="danger" role="alert">
            {t.api.network}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{a.cancel}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {save.isPending ? a.saving : a.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
