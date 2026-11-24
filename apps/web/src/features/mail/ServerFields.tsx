import { Inbox, Send } from 'lucide-react';
import type { Ref } from 'react';
import { Checkbox } from '../../components/ui/Checkbox';
import { SecretField, TextField } from '../../components/ui/Field';
import { Icon } from '../../components/ui/Icon';
import { t } from '../../i18n/id';
import type { FieldErrors } from '../../lib/form';
import { SecurityChoice } from './MailControls';
import { portForSecurity, type ServerValues } from './wizard-state';
import styles from './Wizard.module.css';

const w = t.mail.wizard;

export interface ServerFieldsProps {
  values: ServerValues;
  set: <K extends keyof ServerValues>(key: K, value: ServerValues[K]) => void;
  errors: FieldErrors;
  /** Isian password tak terkendali (dibaca lewat ref saat dikirim, tidak pernah di state). */
  imapPasswordRef: Ref<HTMLInputElement>;
  smtpPasswordRef: Ref<HTMLInputElement>;
  /** Petunjuk password (mis. "Kosongkan bila tidak berubah" saat mengubah akun tersimpan). */
  passwordHint: string;
  disabled?: boolean;
  /** Isian password berubah: hasil tes lama tidak berlaku lagi. */
  onSecretChange?: () => void;
}

/** Username + password akun (password = isian rahasia tak terkendali). */
export function CredentialFields({
  values,
  set,
  errors,
  imapPasswordRef,
  passwordHint,
  disabled,
  onSecretChange,
}: Omit<ServerFieldsProps, 'smtpPasswordRef'>) {
  return (
    <div className={styles.row}>
      <TextField
        label={w.username}
        hint={w.usernameHint}
        value={values.username}
        onChange={(event) => set('username', event.target.value)}
        error={errors['imap.username']}
        autoComplete="off"
        autoCapitalize="none"
        spellCheck={false}
        maxLength={255}
        disabled={disabled}
      />
      <SecretField
        ref={imapPasswordRef}
        label={w.password}
        hint={passwordHint}
        error={errors['imap.password']}
        disabled={disabled}
        onChange={onSecretChange}
      />
    </div>
  );
}

/** Kartu Server masuk (IMAP) dan Server keluar (SMTP): host, port, keamanan (TLS wajib). */
export function ServerCards({
  values,
  set,
  errors,
  smtpPasswordRef,
  passwordHint,
  disabled,
  onSecretChange,
}: Omit<ServerFieldsProps, 'imapPasswordRef'>) {
  return (
    <>
      <fieldset className={styles.serverCard} disabled={disabled}>
        <legend className={styles.serverLegend}>
          <Icon icon={Inbox} size={16} className={styles.serverIcon} />
          {w.incomingTitle}
        </legend>
        <div className={styles.serverGrid}>
          <TextField
            label={w.host}
            value={values.imapHost}
            onChange={(event) => set('imapHost', event.target.value)}
            error={errors['imap.host']}
            placeholder="mail.perusahaan.co.id"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={253}
            inputClassName={styles.mono}
            className={styles.hostField}
          />
          <TextField
            label={w.port}
            value={values.imapPort}
            onChange={(event) => set('imapPort', event.target.value)}
            error={errors['imap.port']}
            inputMode="numeric"
            maxLength={5}
            className={styles.portField}
          />
          <SecurityChoice
            value={values.imapSecurity}
            onChange={(security) => {
              set(
                'imapPort',
                portForSecurity('imap', values.imapPort, values.imapSecurity, security),
              );
              set('imapSecurity', security);
            }}
            className={styles.securityField}
          />
        </div>
      </fieldset>
      <fieldset className={styles.serverCard} disabled={disabled}>
        <legend className={styles.serverLegend}>
          <Icon icon={Send} size={16} className={styles.serverIcon} />
          {w.outgoingTitle}
        </legend>
        <div className={styles.serverGrid}>
          <TextField
            label={w.host}
            value={values.smtpHost}
            onChange={(event) => set('smtpHost', event.target.value)}
            error={errors['smtp.host']}
            placeholder="mail.perusahaan.co.id"
            autoCapitalize="none"
            autoComplete="off"
            spellCheck={false}
            maxLength={253}
            inputClassName={styles.mono}
            className={styles.hostField}
          />
          <TextField
            label={w.port}
            value={values.smtpPort}
            onChange={(event) => set('smtpPort', event.target.value)}
            error={errors['smtp.port']}
            inputMode="numeric"
            maxLength={5}
            className={styles.portField}
          />
          <SecurityChoice
            value={values.smtpSecurity}
            onChange={(security) => {
              set(
                'smtpPort',
                portForSecurity('smtp', values.smtpPort, values.smtpSecurity, security),
              );
              set('smtpSecurity', security);
            }}
            className={styles.securityField}
          />
        </div>
        <Checkbox
          checked={values.sameCredentials}
          onChange={(event) => set('sameCredentials', event.target.checked)}
        >
          {w.sameCredentials}
        </Checkbox>
        {values.sameCredentials ? null : (
          <div className={styles.row}>
            <TextField
              label={w.smtpUsername}
              value={values.smtpUsername}
              onChange={(event) => set('smtpUsername', event.target.value)}
              error={errors['smtp.username']}
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={255}
            />
            <SecretField
              ref={smtpPasswordRef}
              label={w.smtpPassword}
              hint={passwordHint}
              error={errors['smtp.password']}
              onChange={onSecretChange}
            />
          </div>
        )}
      </fieldset>
    </>
  );
}
