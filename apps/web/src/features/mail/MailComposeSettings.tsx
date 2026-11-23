import {
  createMailSignatureRequestSchema,
  MAIL_UNDO_SEND_SECONDS,
  MAIL_VERIFICATION_UNAVAILABLE_MESSAGES,
  createMailIdentityRequestSchema,
  updateMailIdentityRequestSchema,
  type IdentityConfirmation,
  type MailAccount,
  type MailIdentity,
  type MailSignature,
  type MailSentCopyMode,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { DropdownMenu } from 'radix-ui';
import { ImagePlus, MoreHorizontal, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SelectField, TextField } from '../../components/ui/Field';
import { FormActions } from '../../components/ui/FormActions';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { StatusBadge } from '../../components/ui/StatusBadge';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { zodFieldErrors, type FieldErrors } from '../../lib/form';
import { useCan, useSession } from '../auth/session';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { readAvatarFile } from './avatar-file';
import { ComposeEditor, type EditorHandle } from './compose/ComposeEditor';
import { signatureIdOfLogoCid } from './compose/compose-html';
import {
  mailIdentitiesQuery,
  mailKeys,
  mailPreferencesQuery,
  mailSignaturesQuery,
  refreshIdentities,
  storeMailAccount,
  useRequireCode,
} from './mail-queries';
import { identityBadge } from './identity-badge';
import { IdentityVerifyPanel, type IdentityFlash } from './IdentityVerifyPanel';
import styles from './MailAccounts.module.css';
import own from './MailComposeSettings.module.css';

const i = t.mail.identities;
const sg = t.mail.signatures;
const sd = t.mail.sending;
const pf = t.mail.preferences;

type Flash = IdentityFlash;

// ── Alamat pengirim & alias ───────────────────────────────────────────────

/**
 * Pengaturan → Akun email → [akun] → "Alamat pengirim" (KONTRAK-API-EMAIL-TULIS §3): identitas utama
 * + alias, status verifikasi (kirim kode / masukkan kode 6 angka; otomatis bila email verifikasi
 * masuk ke kotak surat ini), nama pengirim, alamat balas-ke, tanda tangan bawaan. Alias akun bersama
 * = `mail.accounts.manage` + konfirmasi identitas; akun pribadi = pemiliknya.
 */
export function MailIdentitiesCard({ account }: { account: MailAccount }) {
  const session = useSession();
  const canManageShared = useCan('mail.accounts.manage');
  const identities = useQuery(mailIdentitiesQuery(account.id));
  const signatures = useQuery({
    ...mailSignaturesQuery(account.id),
    enabled: account.myLevel === 'manage',
  });
  const manage = account.myLevel === 'manage';
  const canAddAlias =
    account.kind === 'shared' ? canManageShared : account.owner?.id === session?.user.id;
  const [flash, setFlash] = useState<Flash | null>(null);
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MailIdentity | null>(null);
  const [removing, setRemoving] = useState<MailIdentity | null>(null);
  const addRef = useRef<HTMLButtonElement>(null);
  const queryClient = useQueryClient();
  const conflict = account.warnings.includes('system_sender_conflict');

  const remove = async (identity: MailIdentity) => {
    setRemoving(null);
    try {
      await endpoints.mail.deleteIdentity(identity.id);
      refreshIdentities(queryClient, account.id);
      setFlash({ tone: 'success', text: i.removed(identity.address) });
    } catch (caught) {
      setFlash({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    }
  };

  return (
    <section className={styles.card} aria-labelledby="alamat-pengirim-judul" id="alamat-pengirim">
      <div className={styles.cardHeadRow}>
        <div className={styles.cardHead}>
          <h2 id="alamat-pengirim-judul" className={styles.cardTitle}>
            {i.title}
          </h2>
          <p className={styles.cardHint}>{manage ? i.hint : i.readOnlyNote}</p>
        </div>
        {canAddAlias && identities.data ? (
          <Button ref={addRef} onClick={() => setAdding(true)}>
            <Icon icon={Plus} size={16} />
            {i.add}
          </Button>
        ) : null}
      </div>
      {conflict ? (
        <Notice
          tone="warning"
          title={i.systemSenderConflictTitle}
          actions={
            <Button asChild>
              <Link to="/pengaturan/email">{i.settingsEmailLink}</Link>
            </Button>
          }
        >
          {MAIL_VERIFICATION_UNAVAILABLE_MESSAGES.system_sender_conflict}
        </Notice>
      ) : null}
      {flash ? (
        <Notice tone={flash.tone} role={flash.tone === 'danger' ? 'alert' : 'status'}>
          {flash.text}
        </Notice>
      ) : null}
      {identities.data ? (
        <ul className={own.identityList}>
          {identities.data.identities.map((identity) => (
            <IdentityRow
              key={identity.id}
              identity={identity}
              manage={manage}
              canRemove={canAddAlias && !identity.isPrimary}
              onFlash={setFlash}
              onEdit={() => setEditing(identity)}
              onRemove={() => setRemoving(identity)}
            />
          ))}
        </ul>
      ) : identities.isPending ? (
        <SkeletonRegion className={styles.skeleton}>
          <Skeleton className={styles.skeletonField} />
          <Skeleton className={styles.skeletonField} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          title={i.loadFailed}
          actions={<Button onClick={() => void identities.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(identities.error) ? identities.error.message : t.api.network}
        </Notice>
      )}
      {adding ? (
        <AddAliasDialog
          account={account}
          onClose={() => {
            setAdding(false);
            requestAnimationFrame(() => addRef.current?.focus());
          }}
          onAdded={(identity) => {
            setAdding(false);
            refreshIdentities(queryClient, account.id);
            setFlash({ tone: 'success', text: i.added(identity.address) });
          }}
        />
      ) : null}
      {editing ? (
        <EditIdentityDialog
          identity={editing}
          signatures={signatures.data?.shared ?? []}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            refreshIdentities(queryClient, account.id);
            setFlash({ tone: 'success', text: i.saved });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={removing ? i.removeTitle(removing.address) : ''}
        body={i.removeBody}
        cancelLabel={i.cancel}
        confirmLabel={i.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
      />
    </section>
  );
}

function IdentityRow({
  identity,
  manage,
  canRemove,
  onFlash,
  onEdit,
  onRemove,
}: {
  identity: MailIdentity;
  manage: boolean;
  canRemove: boolean;
  onFlash: (flash: Flash) => void;
  onEdit: () => void;
  onRemove: () => void;
}) {
  const { verification } = identity;
  const verified = verification.state === 'verified';

  return (
    <li className={own.identity}>
      <div className={own.identityHead}>
        <div className={own.identityText}>
          <p className={own.identityName}>
            <span dir="auto">{identity.displayName}</span>
            <span className={own.kindTag}>{identity.isPrimary ? i.primary : i.alias}</span>
          </p>
          <p className={own.identityAddress}>{identity.address}</p>
          {identity.replyTo ? (
            <p className={own.identityMeta}>{i.replyToLine(identity.replyTo)}</p>
          ) : null}
          {verified && verification.method ? (
            <p className={own.identityMeta}>{i.verifiedBy[verification.method]}</p>
          ) : null}
        </div>
        <StatusBadge {...identityBadge(identity)} className={own.identityBadge} />
        {manage ? (
          <DropdownMenu.Root modal={false}>
            <DropdownMenu.Trigger asChild>
              <button
                type="button"
                className={styles.menuTrigger}
                aria-label={i.actionsFor(identity.address)}
              >
                <Icon icon={MoreHorizontal} size={20} />
              </button>
            </DropdownMenu.Trigger>
            <DropdownMenu.Portal>
              <DropdownMenu.Content align="end" sideOffset={4} className={styles.menu}>
                <DropdownMenu.Item className={styles.menuItem} onSelect={onEdit}>
                  {i.edit(identity.address)}
                </DropdownMenu.Item>
                {canRemove ? (
                  <DropdownMenu.Item
                    className={`${styles.menuItem} ${styles.menuItemDanger}`}
                    onSelect={onRemove}
                  >
                    <Icon icon={Trash2} size={16} />
                    {i.remove(identity.address)}
                  </DropdownMenu.Item>
                ) : null}
              </DropdownMenu.Content>
            </DropdownMenu.Portal>
          </DropdownMenu.Root>
        ) : null}
      </div>
      {!verified && manage ? <IdentityVerifyPanel identity={identity} onFlash={onFlash} /> : null}
    </li>
  );
}

function AddAliasDialog({
  account,
  onClose,
  onAdded,
}: {
  account: MailAccount;
  onClose: () => void;
  onAdded: (identity: MailIdentity) => void;
}) {
  const requireCode = useRequireCode();
  const [address, setAddress] = useState('');
  const [displayName, setDisplayName] = useState(account.fromName);
  const [replyTo, setReplyTo] = useState('');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const shared = account.kind === 'shared';
  const submitRef = useRef<HTMLButtonElement>(null);

  const body = () => ({
    address: address.trim(),
    displayName: displayName.trim(),
    replyTo: replyTo.trim() ? replyTo.trim() : null,
  });

  const send = async (confirmation?: IdentityConfirmation) => {
    const response = await endpoints.mail.createIdentity(account.id, {
      ...body(),
      ...(confirmation ? { confirmation } : {}),
    });
    onAdded(response.identity);
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setError(null);
    const parsed = createMailIdentityRequestSchema.safeParse(body());
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setErrors({});
    // Akun bersama: konfirmasi identitas dulu (dialog di luar `<form>`).
    if (shared) {
      setConfirming(true);
      return;
    }
    setPending(true);
    try {
      await send();
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setPending(false);
    }
  };

  return (
    <>
      <Dialog
        open={!confirming}
        title={i.addTitle}
        description={i.addBody}
        onRequestClose={onClose}
      >
        <form className={own.dialogForm} onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            label={i.addressLabel}
            type="email"
            inputMode="email"
            autoComplete="off"
            value={address}
            error={errors.address}
            maxLength={254}
            onChange={(event) => setAddress(event.target.value)}
          />
          <TextField
            label={i.displayNameLabel}
            hint={i.displayNameHint}
            value={displayName}
            error={errors.displayName}
            maxLength={80}
            onChange={(event) => setDisplayName(event.target.value)}
          />
          <TextField
            label={i.replyToLabel}
            hint={i.replyToHint}
            optional
            type="email"
            inputMode="email"
            value={replyTo}
            error={errors.replyTo}
            maxLength={254}
            onChange={(event) => setReplyTo(event.target.value)}
          />
          {error ? (
            <Notice tone="danger" role="alert">
              {error}
            </Notice>
          ) : null}
          <DialogActions>
            <Button onClick={onClose}>{i.cancel}</Button>
            <Button ref={submitRef} type="submit" variant="primary" loading={pending}>
              {pending ? i.adding : i.add}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <IdentityDialog
        open={confirming}
        title={i.confirmTitle}
        body={i.confirmBody}
        confirmLabel={i.add}
        pendingLabel={i.adding}
        requireCode={requireCode}
        returnFocusRef={submitRef}
        onCancel={() => setConfirming(false)}
        onConfirm={async (confirmation) => {
          try {
            await send(confirmation);
            setConfirming(false);
          } catch (caught) {
            if (isConfirmationError(caught)) throw caught;
            setConfirming(false);
            setError(isApiError(caught) ? caught.message : t.api.network);
          }
        }}
      />
    </>
  );
}

function EditIdentityDialog({
  identity,
  signatures,
  onClose,
  onSaved,
}: {
  identity: MailIdentity;
  signatures: readonly MailSignature[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [displayName, setDisplayName] = useState(identity.displayName);
  const [replyTo, setReplyTo] = useState(identity.replyTo ?? '');
  const [signatureNew, setSignatureNew] = useState(identity.defaultSignatures.new ?? '');
  const [signatureReply, setSignatureReply] = useState(identity.defaultSignatures.reply ?? '');
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const options = [
    { value: '', label: i.noSignature },
    ...signatures.map((item) => ({ value: item.id, label: item.name })),
  ];

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const changes = {
      ...(displayName.trim() !== identity.displayName ? { displayName: displayName.trim() } : {}),
      ...((replyTo.trim() || null) !== identity.replyTo ? { replyTo: replyTo.trim() || null } : {}),
      ...((signatureNew || null) !== identity.defaultSignatures.new
        ? { defaultSignatureNewId: signatureNew || null }
        : {}),
      ...((signatureReply || null) !== identity.defaultSignatures.reply
        ? { defaultSignatureReplyId: signatureReply || null }
        : {}),
    };
    if (Object.keys(changes).length === 0) {
      onClose();
      return;
    }
    const parsed = updateMailIdentityRequestSchema.safeParse(changes);
    if (!parsed.success) {
      setErrors(zodFieldErrors(parsed.error));
      return;
    }
    setPending(true);
    setError(null);
    try {
      await endpoints.mail.updateIdentity(identity.id, parsed.data);
      onSaved();
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog open title={i.editTitle} description={identity.address} onRequestClose={onClose}>
      <form className={own.dialogForm} onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label={i.displayNameLabel}
          hint={i.displayNameHint}
          value={displayName}
          error={errors.displayName}
          maxLength={80}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <TextField
          label={i.replyToLabel}
          hint={i.replyToHint}
          optional
          type="email"
          value={replyTo}
          error={errors.replyTo}
          maxLength={254}
          onChange={(event) => setReplyTo(event.target.value)}
        />
        <SelectField
          label={i.defaultNew}
          value={signatureNew}
          options={options}
          onChange={(event) => setSignatureNew(event.target.value)}
        />
        <SelectField
          label={i.defaultReply}
          value={signatureReply}
          options={options}
          onChange={(event) => setSignatureReply(event.target.value)}
        />
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{i.cancel}</Button>
          <Button type="submit" variant="primary" loading={pending}>
            {pending ? i.saving : i.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ── Tanda tangan ───────────────────────────────────────────────────────────

/**
 * Tanda tangan akun (§4): bersama (Kelola) dan pribadimu (Baca & kirim). Isi lewat editor yang sama
 * dengan jendela tulis (profil HTML editor), variabel `{{nama_agen}}` dkk., logo PNG/JPEG/WebP.
 */
export function MailSignaturesCard({ account }: { account: MailAccount }) {
  const queryClient = useQueryClient();
  const signatures = useQuery(mailSignaturesQuery(account.id));
  const manage = account.myLevel === 'manage';
  const canPersonal = account.myLevel !== 'read';
  const [editing, setEditing] = useState<{
    signature: MailSignature | null;
    scope: 'shared' | 'personal';
  } | null>(null);
  const [removing, setRemoving] = useState<MailSignature | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: mailKeys.signatures(account.id) });
    void queryClient.invalidateQueries({ queryKey: mailKeys.identities(account.id) });
  };

  const remove = async (signature: MailSignature) => {
    setRemoving(null);
    try {
      await endpoints.mail.deleteSignature(signature.id);
      refresh();
      setFlash({ tone: 'success', text: sg.removed(signature.name) });
    } catch (caught) {
      setFlash({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    }
  };

  const group = (
    label: string,
    items: readonly MailSignature[],
    empty: string,
    scope: 'shared' | 'personal',
    canCreate: boolean,
  ) => (
    <div className={own.signatureGroup}>
      <div className={own.groupHead}>
        <h3 className={own.groupTitle}>{label}</h3>
        {canCreate ? (
          <Button onClick={() => setEditing({ signature: null, scope })}>
            <Icon icon={Plus} size={16} />
            {scope === 'shared' ? sg.createShared : sg.createMine}
          </Button>
        ) : null}
      </div>
      {items.length === 0 ? (
        <p className={own.emptyText}>{empty}</p>
      ) : (
        <ul className={own.signatureList}>
          {items.map((item) => (
            <li key={item.id} className={own.signature}>
              <div className={own.signatureText}>
                <p className={own.signatureName} dir="auto">
                  {item.name}
                </p>
                <p className={own.signaturePreview} dir="auto">
                  {item.text || '—'}
                </p>
              </div>
              {item.editable ? (
                <div className={own.signatureActions}>
                  <Button onClick={() => setEditing({ signature: item, scope: item.scope })}>
                    {sg.editShort}
                    <span className="sr-only">{` ${item.name}`}</span>
                  </Button>
                  <Button
                    variant="ghost"
                    aria-label={sg.remove(item.name)}
                    onClick={() => setRemoving(item)}
                  >
                    <Icon icon={Trash2} size={16} />
                  </Button>
                </div>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );

  return (
    <section className={styles.card} aria-labelledby="tanda-tangan-judul" id="tanda-tangan">
      <div className={styles.cardHead}>
        <h2 id="tanda-tangan-judul" className={styles.cardTitle}>
          {sg.title}
        </h2>
        <p className={styles.cardHint}>{sg.hint}</p>
      </div>
      {flash ? (
        <Notice tone={flash.tone} role={flash.tone === 'danger' ? 'alert' : 'status'}>
          {flash.text}
        </Notice>
      ) : null}
      {signatures.data ? (
        <>
          {group(sg.shared, signatures.data.shared, sg.emptyShared, 'shared', manage)}
          {canPersonal
            ? group(sg.mine, signatures.data.mine, sg.emptyMine, 'personal', true)
            : null}
        </>
      ) : signatures.isPending ? (
        <SkeletonRegion className={styles.skeleton}>
          <Skeleton className={styles.skeletonField} />
          <Skeleton className={styles.skeletonField} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          title={sg.loadFailed}
          actions={<Button onClick={() => void signatures.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(signatures.error) ? signatures.error.message : t.api.network}
        </Notice>
      )}
      {editing ? (
        <SignatureDialog
          accountId={account.id}
          signature={editing.signature}
          scope={editing.scope}
          onClose={() => setEditing(null)}
          onSaved={(name) => {
            setEditing(null);
            refresh();
            setFlash({ tone: 'success', text: sg.saved(name) });
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={removing ? sg.removeTitle(removing.name) : ''}
        body={sg.removeBody}
        cancelLabel={sg.cancel}
        confirmLabel={sg.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (removing) void remove(removing);
        }}
      />
    </section>
  );
}

function SignatureDialog({
  accountId,
  signature,
  scope,
  onClose,
  onSaved,
}: {
  accountId: string;
  signature: MailSignature | null;
  scope: 'shared' | 'personal';
  onClose: () => void;
  onSaved: (name: string) => void;
}) {
  const editorRef = useRef<EditorHandle>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(signature?.name ?? '');
  const [logo, setLogo] = useState<{ base64: string; dataUrl: string } | 'remove' | null>(null);
  const [errors, setErrors] = useState<FieldErrors>({});
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const logoPreview = logo === 'remove' ? null : logo ? logo.dataUrl : (signature?.logoUrl ?? null);

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    const checked = createMailSignatureRequestSchema.shape.name.safeParse(name);
    if (!checked.success) {
      setErrors({ name: checked.error.issues[0]?.message ?? sg.nameLabel });
      return;
    }
    setErrors({});
    setError(null);
    setPending(true);
    const html = editorRef.current?.getHtml() ?? '';
    try {
      const saved = signature
        ? await endpoints.mail.updateSignature(signature.id, { name: name.trim(), html })
        : await endpoints.mail.createSignature(accountId, { scope, name: name.trim(), html });
      if (logo === 'remove') await endpoints.mail.removeSignatureLogo(saved.signature.id);
      else if (logo) await endpoints.mail.setSignatureLogo(saved.signature.id, logo.base64);
      onSaved(saved.signature.name);
    } catch (caught) {
      setError(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setPending(false);
    }
  };

  return (
    <Dialog
      open
      title={signature ? sg.editTitle : sg.createTitle}
      description={scope === 'shared' ? sg.shared : sg.mine}
      onRequestClose={onClose}
    >
      <form className={own.dialogForm} onSubmit={(event) => void submit(event)} noValidate>
        <TextField
          label={sg.nameLabel}
          hint={sg.nameHint}
          value={name}
          error={errors.name ?? null}
          maxLength={60}
          onChange={(event) => setName(event.target.value)}
        />
        <div className={own.editorField}>
          <span className={own.editorLabel} id="isi-tanda-tangan">
            {sg.contentLabel}
          </span>
          <div className={own.editorBox}>
            <ComposeEditor
              ref={editorRef}
              initialHtml={signature?.html ?? ''}
              resolveCid={(cid) => {
                const id = signatureIdOfLogoCid(cid);
                return id && signature?.logoUrl ? signature.logoUrl : null;
              }}
              label={sg.contentLabel}
              onChange={() => undefined}
            />
          </div>
          <p className={own.editorHint}>{sg.variablesHint}</p>
        </div>
        <div className={own.logoRow}>
          {logoPreview ? (
            <img src={logoPreview} alt={sg.logoAlt(name)} className={own.logoPreview} />
          ) : null}
          <div className={own.logoText}>
            <span className={own.editorLabel}>{sg.logoLabel}</span>
            <p className={own.editorHint}>{sg.logoHint}</p>
            <div className={own.logoActions}>
              <Button onClick={() => fileRef.current?.click()}>
                <Icon icon={ImagePlus} size={16} />
                {logoPreview ? sg.replaceLogo : sg.chooseLogo}
              </Button>
              {logoPreview ? (
                <Button variant="ghost" onClick={() => setLogo('remove')}>
                  {sg.removeLogo}
                </Button>
              ) : null}
            </div>
          </div>
          <input
            ref={fileRef}
            type="file"
            accept="image/png,image/jpeg,image/webp"
            hidden
            onChange={(event) => {
              const file = event.target.files?.[0];
              event.target.value = '';
              if (!file) return;
              readAvatarFile(file)
                .then((draft) => setLogo(draft))
                .catch((caught: unknown) =>
                  setError(caught instanceof Error ? caught.message : t.api.network),
                );
            }}
          />
        </div>
        {error ? (
          <Notice tone="danger" role="alert">
            {error}
          </Notice>
        ) : null}
        <DialogActions>
          <Button onClick={onClose}>{sg.cancel}</Button>
          <Button type="submit" variant="primary" loading={pending}>
            {pending ? sg.saving : sg.save}
          </Button>
        </DialogActions>
      </form>
    </Dialog>
  );
}

// ── Pengiriman (akun) ─────────────────────────────────────────────────────

/** Salinan Terkirim & peringatan penerima luar domain (PATCH akun, level Kelola). */
export function MailSendingCard({ account }: { account: MailAccount }) {
  const queryClient = useQueryClient();
  const [mode, setMode] = useState<MailSentCopyMode>(account.sentCopyMode);
  const [warn, setWarn] = useState(account.warnExternalRecipients);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Flash | null>(null);
  const dirty = mode !== account.sentCopyMode || warn !== account.warnExternalRecipients;

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setPending(true);
    setResult(null);
    try {
      const { account: saved } = await endpoints.mail.update(account.id, {
        ...(mode !== account.sentCopyMode ? { sentCopyMode: mode } : {}),
        ...(warn !== account.warnExternalRecipients ? { warnExternalRecipients: warn } : {}),
      });
      storeMailAccount(queryClient, saved);
      setResult({ tone: 'success', text: sd.saved });
    } catch (caught) {
      setResult({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    } finally {
      setPending(false);
    }
  };

  return (
    <section className={styles.card} aria-labelledby="pengiriman-judul" id="pengiriman">
      <div className={styles.cardHead}>
        <h2 id="pengiriman-judul" className={styles.cardTitle}>
          {sd.title}
        </h2>
        <p className={styles.cardHint}>{sd.hint}</p>
      </div>
      <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
        <fieldset className={styles.fieldset} disabled={pending}>
          <SelectField
            label={sd.sentCopyLabel}
            hint={sd.sentCopyHint}
            value={mode}
            options={(['auto', 'append', 'none'] as const).map((value) => ({
              value,
              label: sd.sentCopyOptions[value] ?? value,
            }))}
            onChange={(event) => {
              setMode(event.target.value as MailSentCopyMode);
              setResult(null);
            }}
          />
          <Checkbox
            checked={warn}
            onChange={(event) => {
              setWarn(event.target.checked);
              setResult(null);
            }}
          >
            {sd.warnExternal}
            <span className={own.checkboxHint}>{sd.warnExternalHint}</span>
          </Checkbox>
        </fieldset>
        {result ? (
          <Notice tone={result.tone} role={result.tone === 'danger' ? 'alert' : 'status'}>
            {result.text}
          </Notice>
        ) : null}
        <FormActions>
          <Button type="submit" variant="primary" loading={pending} disabled={!dirty}>
            {pending ? sd.saving : sd.save}
          </Button>
        </FormActions>
      </form>
    </section>
  );
}

// ── Preferensi menulis (pribadi) ──────────────────────────────────────────

const UNDO_OPTIONS = [5, 10, 15, 20, 30].filter(
  (value) => value >= MAIL_UNDO_SEND_SECONDS.min && value <= MAIL_UNDO_SEND_SECONDS.max,
);

/** Pengaturan → Akun email: lama batalkan kirim & format bawaan (pribadi, semua akun). */
export function MailPreferencesCard() {
  const preferences = useQuery(mailPreferencesQuery);
  return (
    <section
      className={styles.card}
      aria-labelledby="preferensi-menulis-judul"
      id="preferensi-menulis"
    >
      <div className={styles.cardHead}>
        <h2 id="preferensi-menulis-judul" className={styles.cardTitle}>
          {pf.title}
        </h2>
        <p className={styles.cardHint}>{pf.hint}</p>
      </div>
      {preferences.data ? (
        <PreferencesForm
          undo={preferences.data.undoSendSeconds}
          format={preferences.data.composeFormat}
        />
      ) : preferences.isPending ? (
        <SkeletonRegion className={styles.skeleton}>
          <Skeleton className={styles.skeletonField} />
        </SkeletonRegion>
      ) : (
        <Notice
          tone="danger"
          title={pf.loadFailed}
          actions={<Button onClick={() => void preferences.refetch()}>{t.common.retry}</Button>}
        >
          {isApiError(preferences.error) ? preferences.error.message : t.api.network}
        </Notice>
      )}
    </section>
  );
}

function PreferencesForm({ undo, format }: { undo: number; format: 'html' | 'text' }) {
  const queryClient = useQueryClient();
  const [seconds, setSeconds] = useState(String(undo));
  const [compose, setCompose] = useState(format);
  const [pending, setPending] = useState(false);
  const [result, setResult] = useState<Flash | null>(null);
  const dirty = Number(seconds) !== undo || compose !== format;
  const options = (
    UNDO_OPTIONS.includes(undo) ? UNDO_OPTIONS : [...UNDO_OPTIONS, undo].sort((a, b) => a - b)
  ).map((value) => ({ value: String(value), label: pf.seconds(value) }));

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!dirty) return;
    setPending(true);
    setResult(null);
    try {
      const saved = await endpoints.mail.updatePreferences({
        undoSendSeconds: Number(seconds),
        composeFormat: compose,
      });
      queryClient.setQueryData(mailKeys.preferences, saved);
      setResult({ tone: 'success', text: pf.saved });
    } catch (caught) {
      setResult({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    } finally {
      setPending(false);
    }
  };

  return (
    <form className={styles.form} onSubmit={(event) => void submit(event)} noValidate>
      <fieldset className={styles.fieldset} disabled={pending}>
        <div className={styles.formRow}>
          <SelectField
            label={pf.undoLabel}
            hint={pf.undoHint}
            value={seconds}
            options={options}
            onChange={(event) => {
              setSeconds(event.target.value);
              setResult(null);
            }}
          />
          <SelectField
            label={pf.formatLabel}
            value={compose}
            options={[
              { value: 'html', label: pf.formatHtml },
              { value: 'text', label: pf.formatText },
            ]}
            onChange={(event) => {
              setCompose(event.target.value === 'text' ? 'text' : 'html');
              setResult(null);
            }}
          />
        </div>
      </fieldset>
      {result ? (
        <Notice tone={result.tone} role={result.tone === 'danger' ? 'alert' : 'status'}>
          {result.text}
        </Notice>
      ) : null}
      <FormActions>
        <Button type="submit" variant="primary" loading={pending} disabled={!dirty}>
          {pending ? pf.saving : pf.save}
        </Button>
      </FormActions>
    </form>
  );
}

// ── Persetujuan alamat akun pribadi (Owner/Admin) ─────────────────────────

const ap = t.mail.identities.approvals;

/**
 * Review 9B S3: identitas akun PRIBADI yang memakai domain organisasi menunggu persetujuan Owner/Admin
 * sebelum bisa diverifikasi. Kartu hanya tampil bila ada antrean. Setujui/tolak = konfirmasi identitas.
 */
export function MailIdentityApprovalsCard() {
  const queryClient = useQueryClient();
  const requireCode = useRequireCode();
  const approvals = useQuery({
    queryKey: ['mail', 'identity-approvals'],
    queryFn: ({ signal }) => endpoints.mail.identityApprovals(signal),
    retry: false,
  });
  const [deciding, setDeciding] = useState<{
    identityId: string;
    address: string;
    decision: 'approve' | 'reject';
  } | null>(null);
  const [flash, setFlash] = useState<Flash | null>(null);
  const list = approvals.data?.approvals ?? [];
  if (list.length === 0 && !flash) return null;

  return (
    <section className={styles.card} aria-labelledby="persetujuan-alamat-judul">
      <div className={styles.cardHead}>
        <h2 id="persetujuan-alamat-judul" className={styles.cardTitle}>
          {ap.title}
        </h2>
        <p className={styles.cardHint}>{ap.hint}</p>
      </div>
      {flash ? (
        <Notice tone={flash.tone} role={flash.tone === 'danger' ? 'alert' : 'status'}>
          {flash.text}
        </Notice>
      ) : null}
      {list.length > 0 ? (
        <ul className={own.identityList}>
          {list.map((item) => (
            <li key={item.identityId} className={own.identity}>
              <div className={own.identityHead}>
                <div className={own.identityText}>
                  <p className={own.identityName}>
                    <span dir="auto">{item.displayName}</span>
                    <span className={own.kindTag}>{item.isPrimary ? i.primary : i.alias}</span>
                  </p>
                  <p className={own.identityAddress}>{item.address}</p>
                  {item.owner ? (
                    <p className={own.identityMeta}>{ap.owner(item.owner.name)}</p>
                  ) : null}
                </div>
                <div className={own.signatureActions}>
                  <Button
                    aria-label={ap.rejectFor(item.address)}
                    onClick={() =>
                      setDeciding({
                        identityId: item.identityId,
                        address: item.address,
                        decision: 'reject',
                      })
                    }
                  >
                    {ap.reject}
                  </Button>
                  <Button
                    variant="primary"
                    aria-label={ap.approveFor(item.address)}
                    onClick={() =>
                      setDeciding({
                        identityId: item.identityId,
                        address: item.address,
                        decision: 'approve',
                      })
                    }
                  >
                    {ap.approve}
                  </Button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      ) : null}
      <IdentityDialog
        open={deciding !== null}
        title={
          deciding
            ? deciding.decision === 'approve'
              ? ap.confirmApproveTitle(deciding.address)
              : ap.confirmRejectTitle(deciding.address)
            : ''
        }
        body={deciding?.decision === 'reject' ? ap.confirmRejectBody : ap.confirmApproveBody}
        confirmLabel={deciding?.decision === 'reject' ? ap.reject : ap.approve}
        pendingLabel={ap.working}
        variant={deciding?.decision === 'reject' ? 'danger' : 'primary'}
        requireCode={requireCode}
        onCancel={() => setDeciding(null)}
        onConfirm={async (confirmation) => {
          if (!deciding) return;
          try {
            await endpoints.mail.decideIdentityApproval(deciding.identityId, {
              decision: deciding.decision,
              confirmation,
            });
            setFlash({
              tone: 'success',
              text:
                deciding.decision === 'approve'
                  ? ap.approved(deciding.address)
                  : ap.rejected(deciding.address),
            });
            setDeciding(null);
            void queryClient.invalidateQueries({ queryKey: ['mail', 'identity-approvals'] });
            refreshIdentities(queryClient);
          } catch (caught) {
            if (isConfirmationError(caught)) throw caught;
            setDeciding(null);
            setFlash({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
          }
        }}
      />
    </section>
  );
}
