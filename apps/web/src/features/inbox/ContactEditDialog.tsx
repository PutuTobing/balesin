import { updateContactRequestSchema, type Contact } from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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
import { apiFieldErrors, zodFieldErrors, type FieldErrors } from '../../lib/form';
import { AttributeFields } from '../contacts/AttributeFields';
import {
  collectAttributes,
  splitAttributes,
  type AttributeValues,
} from '../contacts/attribute-values';
import { contactAttributesQuery, refreshContactLists } from '../contacts/contact-queries';
import styles from './ContactPanel.module.css';
import { storeContact } from './inbox-queries';

const p = t.inbox.panel;
const d = t.inbox.detail;

interface AttributeRow {
  /** Kunci render stabil (bukan dari data). */
  key: number;
  name: string;
  value: string;
}

/**
 * Ubah kontak (`contacts.manage`): nama dari tim (kosong = kembali ke nama profil WhatsApp), email,
 * catatan kontak, atribut BERDEFINISI (Pengaturan → Atribut kontak: jenis + wajib, divalidasi
 * `validateAttributeValues` seperti server), dan atribut bebas kunci/nilai. Atribut dikirim sebagai
 * daftar LENGKAP (mengganti).
 */
export function ContactEditDialog({
  contact,
  open,
  onClose,
  onSaved,
}: {
  contact: Contact;
  open: boolean;
  onClose: () => void;
  onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const definitionsQuery = useQuery(contactAttributesQuery);
  const definitions = definitionsQuery.data ?? [];
  const [name, setName] = useState(contact.name ?? '');
  const [email, setEmail] = useState(contact.email ?? '');
  const [notes, setNotes] = useState(contact.notes ?? '');
  const split = splitAttributes(definitions, contact.attributes ?? []);
  const [defined, setDefined] = useState<AttributeValues | null>(null);
  const [rows, setRows] = useState<AttributeRow[] | null>(null);
  // Definisi dimuat setelah dialog terbuka: isian awal dibagi begitu definisinya ada.
  const definedValues = defined ?? split.defined;
  const freeRows =
    rows ?? split.free.map((item, index) => ({ key: index, name: item.key, value: item.value }));
  const setFreeRows = (update: (current: AttributeRow[]) => AttributeRow[]) =>
    setRows(update(freeRows));
  const [nextKey, setNextKey] = useState((contact.attributes ?? []).length);
  const [errors, setErrors] = useState<FieldErrors>({});

  const save = useMutation({
    mutationFn: (body: Parameters<typeof endpoints.inbox.updateContact>[1]) =>
      endpoints.inbox.updateContact(contact.id, body),
    onSuccess: ({ contact: updated }) => {
      storeContact(queryClient, updated);
      refreshContactLists(queryClient);
      onSaved();
    },
    onError: (error) => {
      if (isApiError(error) && error.details.length > 0) setErrors(apiFieldErrors(error.details));
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const free = freeRows
      .filter((row) => row.name.trim() || row.value.trim())
      .map((row) => ({ key: row.name, value: row.value }));
    const attributes = collectAttributes(definitions, definedValues, free);
    if (!attributes.ok) {
      setErrors(attributes.errors);
      return;
    }
    const parsed = updateContactRequestSchema.safeParse({
      name: name.trim() ? name : null,
      email: email.trim() ? email : null,
      notes: notes.trim() ? notes : null,
      attributes: attributes.values,
    });
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    save.mutate(parsed.data);
  };

  const general =
    save.isError && !(isApiError(save.error) && save.error.details.length > 0) ? save.error : null;

  return (
    <Dialog open={open} title={p.contactEditTitle} onRequestClose={onClose}>
      <form className={styles.form} onSubmit={submit} noValidate>
        <div className={styles.nameField}>
          <TextField
            label={d.teamName}
            hint={p.teamNameHint}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={errors.name}
            maxLength={256}
            dir="auto"
          />
          {contact.profileName && name ? (
            <Button variant="ghost" onClick={() => setName('')}>
              {p.useWhatsAppName}
            </Button>
          ) : null}
        </div>
        <TextField
          label={p.email}
          type="email"
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          error={errors.email}
          autoComplete="off"
          maxLength={254}
        />
        <TextAreaField
          label={p.notes}
          hint={p.notesHint}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          error={errors.notes}
          rows={3}
          maxLength={2000}
          dir="auto"
        />
        {definitions.length > 0 ? (
          <fieldset className={styles.attributes}>
            <legend className={styles.legend}>{p.attributes}</legend>
            <AttributeFields
              definitions={definitions}
              values={definedValues}
              onChange={(key, value) => setDefined({ ...definedValues, [key]: value })}
              errors={errors}
            />
          </fieldset>
        ) : null}
        <fieldset className={styles.attributes}>
          <legend className={styles.legend}>
            {definitions.length > 0 ? t.attributes.otherAttributes : p.attributes}
          </legend>
          {freeRows.map((row, index) => (
            <div key={row.key} className={styles.attributeRow}>
              <TextField
                label={p.attributeKey}
                value={row.name}
                onChange={(event) =>
                  setFreeRows((current) =>
                    current.map((item) =>
                      item.key === row.key ? { ...item, name: event.target.value } : item,
                    ),
                  )
                }
                error={errors[`attributes.${String(index)}.key`]}
                maxLength={40}
              />
              <TextField
                label={p.attributeValue}
                value={row.value}
                onChange={(event) =>
                  setFreeRows((current) =>
                    current.map((item) =>
                      item.key === row.key ? { ...item, value: event.target.value } : item,
                    ),
                  )
                }
                error={errors[`attributes.${String(index)}.value`]}
                maxLength={500}
              />
              <IconButton
                label={p.removeAttribute(row.name)}
                icon={Trash2}
                onClick={() =>
                  setFreeRows((current) => current.filter((item) => item.key !== row.key))
                }
                className={styles.attributeRemove}
              />
            </div>
          ))}
          {errors.attributes ? <p className={styles.fieldError}>{errors.attributes}</p> : null}
          {freeRows.length + definitions.length < 30 ? (
            <Button
              variant="ghost"
              onClick={() => {
                setFreeRows((current) => [...current, { key: nextKey, name: '', value: '' }]);
                setNextKey((value) => value + 1);
              }}
            >
              <Icon icon={Plus} size={16} />
              {p.addAttribute}
            </Button>
          ) : null}
        </fieldset>
        {general ? (
          <Notice tone="danger" role="alert">
            {isApiError(general) ? general.message : t.api.network}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{p.cancel}</Button>
          <Button type="submit" variant="primary" loading={save.isPending}>
            {save.isPending ? p.saving : p.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}
