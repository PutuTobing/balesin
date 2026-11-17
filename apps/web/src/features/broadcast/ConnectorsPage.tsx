import {
  connectorUrlSecretParams,
  type BroadcastConnector,
  type BroadcastConnectorTestResponse,
  type CreateBroadcastConnectorRequest,
  type IdentityConfirmation,
  type UpdateBroadcastConnectorRequest,
} from '@balesin/shared';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Database, Pencil, Plus, Trash2 } from 'lucide-react';
import { useRef, useState, type FormEvent } from 'react';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Checkbox } from '../../components/ui/Checkbox';
import { ConfirmDialog } from '../../components/ui/ConfirmDialog';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { EmptyState } from '../../components/ui/EmptyState';
import { SecretField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { IconButton } from '../../components/ui/IconButton';
import { Notice } from '../../components/ui/Notice';
import { Page } from '../../components/ui/Page';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { formatDateTimeInline } from '../../lib/format';
import { isConfirmationError } from '../identity/confirmation-error';
import { IdentityDialog } from '../identity/IdentityDialog';
import { broadcastKeys, connectorsQuery } from './broadcast-queries';
import styles from './Broadcast.module.css';

const c = t.connectors;

/**
 * Pengaturan → Konektor data (`integrations.manage`): alamat REST JSON aplikasi lain sebagai sumber
 * penerima broadcast. Nilai header autentikasi = rahasia: isian TAK TERKENDALI (`SecretField` + ref),
 * hanya ekor 4 karakternya yang tampil lagi. Parameter query yang tampak rahasia diperingatkan
 * langsung (server menolaknya).
 */
export function ConnectorsPage() {
  const queryClient = useQueryClient();
  const list = useQuery(connectorsQuery);
  const [editing, setEditing] = useState<BroadcastConnector | 'new' | null>(null);
  const [removing, setRemoving] = useState<BroadcastConnector | null>(null);
  const [removeBusy, setRemoveBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [failure, setFailure] = useState<unknown>(null);
  const [testing, setTesting] = useState<string | null>(null);
  const [tests, setTests] = useState<Record<string, BroadcastConnectorTestResponse>>({});

  const refresh = () => {
    void queryClient.invalidateQueries({ queryKey: broadcastKeys.connectors });
    void queryClient.invalidateQueries({ queryKey: broadcastKeys.connectorOptions });
  };

  const test = async (connector: BroadcastConnector) => {
    setTesting(connector.id);
    setFailure(null);
    try {
      const result = await endpoints.connectors.test(connector.id);
      setTests((current) => ({ ...current, [connector.id]: result }));
      refresh();
    } catch (caught) {
      setFailure(caught);
    } finally {
      setTesting(null);
    }
  };

  const remove = async () => {
    if (!removing) return;
    setRemoveBusy(true);
    try {
      await endpoints.connectors.remove(removing.id);
      setDone(c.removed(removing.name));
      setRemoving(null);
      refresh();
    } catch (caught) {
      setRemoving(null);
      setFailure(caught);
    } finally {
      setRemoveBusy(false);
    }
  };

  const add = (
    <Button variant="primary" onClick={() => setEditing('new')}>
      <Icon icon={Plus} size={16} />
      {c.add}
    </Button>
  );

  return (
    <Page>
      <div className={styles.content}>
        <p className={styles.intro}>{c.intro}</p>
        {done ? (
          <Notice tone="success" role="status">
            {done}
          </Notice>
        ) : null}
        {failure ? (
          <Notice tone="danger" role="alert">
            {isApiError(failure) ? failure.message : t.api.network}
          </Notice>
        ) : null}
        {list.isPending ? (
          <SkeletonRegion className={styles.list}>
            {[0, 1].map((index) => (
              <Skeleton key={index} className={styles.skeletonCard} />
            ))}
          </SkeletonRegion>
        ) : list.isError ? (
          <EmptyState
            illustration={<LoadFailedIllustration />}
            title={c.loadFailedTitle}
            body={isApiError(list.error) ? list.error.message : t.api.network}
            actions={
              <Button variant="primary" onClick={() => void list.refetch()}>
                {t.common.retry}
              </Button>
            }
          />
        ) : list.data.connectors.length === 0 ? (
          <EmptyState title={c.emptyTitle} body={c.emptyBody} actions={add} />
        ) : (
          <>
            <div className={styles.toolbarEnd}>{add}</div>
            <ul className={styles.list} aria-label={c.listLabel}>
              {list.data.connectors.map((connector) => {
                const result = tests[connector.id];
                const last = connector.lastTest;
                return (
                  <li key={connector.id} className={styles.item}>
                    <div className={styles.itemHead}>
                      <Icon icon={Database} size={20} className={styles.itemIcon} />
                      <span className={styles.itemTitle}>{connector.name}</span>
                      <IconButton
                        label={c.edit(connector.name)}
                        icon={Pencil}
                        onClick={() => {
                          setDone(null);
                          setEditing(connector);
                        }}
                      />
                      <IconButton
                        label={c.remove(connector.name)}
                        icon={Trash2}
                        onClick={() => {
                          setDone(null);
                          setRemoving(connector);
                        }}
                      />
                    </div>
                    <p className={styles.mono}>{connector.url}</p>
                    <p className={styles.itemMeta}>
                      {[
                        connector.authHeaderName && connector.authHeaderTail
                          ? c.header(connector.authHeaderName, connector.authHeaderTail)
                          : c.noHeader,
                        c.itemsAt(connector.itemsPath),
                        c.phoneAt(connector.phoneField),
                      ].join(' · ')}
                    </p>
                    {result ? (
                      <Notice tone={result.ok ? 'success' : 'danger'} role="status">
                        {result.message}
                        {result.items !== null ? ` ${c.lastTestItems(result.items)}.` : null}
                      </Notice>
                    ) : last ? (
                      <p className={last.ok ? styles.itemMeta : styles.itemDanger}>
                        {c.lastTest(last.message, formatDateTimeInline(last.at))}
                      </p>
                    ) : null}
                    <Button
                      className={styles.alignStart}
                      loading={testing === connector.id}
                      onClick={() => void test(connector)}
                    >
                      {testing === connector.id ? c.testing : c.test}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </>
        )}
      </div>
      {editing ? (
        <ConnectorDialog
          connector={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={(saved, created) => {
            setEditing(null);
            setDone(created ? c.created(saved.name) : c.updated(saved.name));
            refresh();
          }}
        />
      ) : null}
      <ConfirmDialog
        open={removing !== null}
        title={c.removeTitle(removing?.name ?? '')}
        body={c.removeBody}
        cancelLabel={c.cancel}
        confirmLabel={removeBusy ? c.removing : c.removeConfirm}
        confirmVariant="danger"
        onCancel={() => setRemoving(null)}
        onConfirm={() => {
          if (!removeBusy) void remove();
        }}
      />
    </Page>
  );
}

type Pending =
  | { kind: 'create'; body: CreateBroadcastConnectorRequest }
  | { kind: 'update'; body: UpdateBroadcastConnectorRequest };

function ConnectorDialog({
  connector,
  onClose,
  onSaved,
}: {
  connector: BroadcastConnector | null;
  onClose: () => void;
  onSaved: (connector: BroadcastConnector, created: boolean) => void;
}) {
  const [name, setName] = useState(connector?.name ?? '');
  const [url, setUrl] = useState(connector?.url ?? 'https://');
  const [useAuth, setUseAuth] = useState(connector ? connector.authHeaderName !== null : true);
  const [headerName, setHeaderName] = useState(connector?.authHeaderName ?? 'Authorization');
  const valueRef = useRef<HTMLInputElement>(null);
  const [itemsPath, setItemsPath] = useState(connector?.itemsPath ?? '');
  const [phoneField, setPhoneField] = useState(connector?.phoneField ?? '');
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [failure, setFailure] = useState<unknown>(null);
  const [confirming, setConfirming] = useState<Pending | null>(null);
  const [saving, setSaving] = useState(false);
  const secretParams = connectorUrlSecretParams(url);

  const send = async (pending: Pending, confirmation?: IdentityConfirmation) => {
    const result =
      pending.kind === 'create'
        ? await endpoints.connectors.create({ ...pending.body, confirmation })
        : await endpoints.connectors.update(connector!.id, { ...pending.body, confirmation });
    if (valueRef.current) valueRef.current.value = '';
    onSaved(result.connector, pending.kind === 'create');
  };

  const handleError = (caught: unknown) => {
    if (isApiError(caught) && caught.details.length > 0) {
      setErrors(
        Object.fromEntries(
          caught.details.map((detail) => [
            detail.field.replace(/^auth\./, 'auth.'),
            detail.message,
          ]),
        ),
      );
    } else {
      setFailure(caught);
    }
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    setFailure(null);
    const value = valueRef.current?.value ?? '';
    const problems: Record<string, string> = {};
    if (!name.trim()) problems.name = 'Nama konektor wajib diisi.';
    if (!url.trim()) problems.url = 'URL wajib diisi.';
    if (secretParams.length > 0) problems.url = c.secretParams(secretParams.join(', '));
    if (!phoneField.trim()) problems.phoneField = 'Nama isian nomor wajib diisi.';
    const keepsHeader = connector?.authHeaderName !== null && connector !== null && value === '';
    if (useAuth && !headerName.trim()) problems['auth.headerName'] = 'Nama header wajib diisi.';
    if (useAuth && value === '' && !keepsHeader)
      problems['auth.headerValue'] = 'Nilai header wajib diisi.';
    setErrors(problems);
    if (Object.keys(problems).length > 0) return;

    let pending: Pending;
    let needsConfirmation: boolean;
    if (!connector) {
      pending = {
        kind: 'create',
        body: {
          name: name.trim(),
          url: url.trim(),
          auth: useAuth ? { headerName: headerName.trim(), headerValue: value } : null,
          itemsPath: itemsPath.trim(),
          phoneField: phoneField.trim(),
        },
      };
      needsConfirmation = useAuth;
    } else {
      const headerChanged = useAuth
        ? value !== '' || headerName.trim() !== connector.authHeaderName
        : connector.authHeaderName !== null;
      const urlChanged = url.trim() !== connector.url;
      pending = {
        kind: 'update',
        body: {
          ...(name.trim() !== connector.name ? { name: name.trim() } : {}),
          ...(urlChanged ? { url: url.trim() } : {}),
          ...(headerChanged
            ? { auth: useAuth ? { headerName: headerName.trim(), headerValue: value } : null }
            : {}),
          itemsPath: itemsPath.trim(),
          phoneField: phoneField.trim(),
        },
      };
      // Ganti header, atau ganti URL konektor berheader (header ikut terkirim ke alamat baru).
      needsConfirmation =
        (headerChanged && useAuth) || (urlChanged && connector.authHeaderName !== null);
      if (headerChanged && useAuth && value === '') {
        setErrors({ 'auth.headerValue': 'Isi nilai header untuk nama header yang baru.' });
        return;
      }
    }
    if (needsConfirmation) {
      setConfirming(pending);
      return;
    }
    setSaving(true);
    try {
      await send(pending);
    } catch (caught) {
      handleError(caught);
    } finally {
      setSaving(false);
    }
  };

  return (
    <>
      <Dialog
        open={confirming === null}
        title={connector ? c.formTitleEdit : c.formTitleCreate}
        onRequestClose={onClose}
      >
        <form className={styles.dialogForm} onSubmit={(event) => void submit(event)} noValidate>
          <TextField
            label={c.nameLabel}
            hint={c.nameHint}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={errors.name}
            maxLength={60}
          />
          <TextField
            label={c.urlLabel}
            hint={c.urlHint}
            value={url}
            onChange={(event) => setUrl(event.target.value)}
            error={errors.url}
            inputMode="url"
            inputClassName={styles.monoInput}
            spellCheck={false}
            maxLength={2000}
          />
          {secretParams.length > 0 && !errors.url ? (
            <Notice tone="warning" role="status">
              {c.secretParams(secretParams.join(', '))}
            </Notice>
          ) : null}
          <Checkbox checked={useAuth} onChange={(event) => setUseAuth(event.target.checked)}>
            {c.authToggle}
          </Checkbox>
          {useAuth ? (
            <>
              <TextField
                label={c.authHeaderName}
                hint={c.authHeaderNameHint}
                value={headerName}
                onChange={(event) => setHeaderName(event.target.value)}
                error={errors['auth.headerName']}
                maxLength={64}
                spellCheck={false}
              />
              <SecretField
                ref={valueRef}
                label={
                  connector?.authHeaderTail
                    ? c.authReplace(connector.authHeaderTail)
                    : c.authHeaderValue
                }
                hint={c.authHeaderValueHint}
                error={errors['auth.headerValue']}
                maxLength={2000}
              />
            </>
          ) : null}
          <TextField
            label={c.itemsPath}
            hint={c.itemsPathHint}
            value={itemsPath}
            onChange={(event) => setItemsPath(event.target.value)}
            error={errors.itemsPath}
            inputClassName={styles.monoInput}
            maxLength={120}
            spellCheck={false}
          />
          <TextField
            label={c.phoneField}
            hint={c.phoneFieldHint}
            value={phoneField}
            onChange={(event) => setPhoneField(event.target.value)}
            error={errors.phoneField}
            inputClassName={styles.monoInput}
            maxLength={64}
            spellCheck={false}
          />
          {failure ? (
            <Notice tone="danger" role="alert">
              {isApiError(failure) ? failure.message : t.api.network}
            </Notice>
          ) : null}
          <DialogActions sticky>
            <Button onClick={onClose}>{c.cancel}</Button>
            <Button type="submit" variant="primary" loading={saving}>
              {saving ? c.saving : c.save}
            </Button>
          </DialogActions>
        </form>
      </Dialog>
      <IdentityDialog
        open={confirming !== null}
        title={c.confirmTitle}
        body={c.confirmBody}
        confirmLabel={c.save}
        pendingLabel={c.saving}
        requireCode
        onCancel={() => setConfirming(null)}
        onConfirm={async (confirmation) => {
          if (!confirming) return;
          try {
            await send(confirming, confirmation);
            setConfirming(null);
          } catch (caught) {
            if (isConfirmationError(caught)) throw caught;
            setConfirming(null);
            handleError(caught);
          }
        }}
      />
    </>
  );
}
