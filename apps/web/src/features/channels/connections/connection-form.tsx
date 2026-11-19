import { IMAP_DEFAULT_PORTS } from '@balesin/shared';
import { RadioGroup } from 'radix-ui';
import { Checkbox } from '../../../components/ui/Checkbox';
import { SecretField, SelectField, TextAreaField, TextField } from '../../../components/ui/Field';
import { t } from '../../../i18n/id';
import { SMTP_DEFAULT_PORTS, type ConnectionForm } from './use-connection-form';
import styles from './Connections.module.css';

const c = t.connections;

/** Isian form per jenis channel. */
export function ConnectionFields({ form, disabled }: { form: ConnectionForm; disabled?: boolean }) {
  const { type, values, set, errors, secretRef, editing } = form;
  const secretHint = editing ? c.newSecretHint : undefined;
  return (
    <div className={styles.fields}>
      <TextField
        label={c.name}
        hint={c.nameHint[type]}
        value={values.name}
        onChange={(event) => set('name', event.target.value)}
        error={errors.name}
        maxLength={100}
        disabled={disabled}
        autoComplete="off"
      />
      {type === 'telegram' ? (
        <SecretField
          ref={secretRef('botToken')}
          label={c.botToken}
          hint={secretHint ?? c.botTokenHint}
          error={errors.botToken}
          disabled={disabled}
          onChange={() => form.setErrors({})}
        />
      ) : null}
      {type === 'email' ? <EmailFields form={form} disabled={disabled} /> : null}
      {type === 'messenger' || type === 'instagram' ? (
        <>
          <TextField
            label={c.pageId}
            value={values.pageId}
            onChange={(event) => set('pageId', event.target.value)}
            error={errors.pageId}
            inputMode="numeric"
            maxLength={32}
            disabled={disabled}
            autoComplete="off"
          />
          {type === 'instagram' ? (
            <TextField
              label={c.instagramAccountId}
              value={values.instagramAccountId}
              onChange={(event) => set('instagramAccountId', event.target.value)}
              error={errors.instagramAccountId}
              inputMode="numeric"
              maxLength={32}
              disabled={disabled}
              autoComplete="off"
            />
          ) : null}
          <SecretField
            ref={secretRef('pageAccessToken')}
            label={c.pageAccessToken}
            hint={secretHint ?? c.pageAccessTokenHint}
            error={errors.pageAccessToken}
            disabled={disabled}
          />
          <SecretField
            ref={secretRef('appSecret')}
            label={c.appSecret}
            hint={secretHint ?? c.appSecretHint}
            error={errors.appSecret}
            disabled={disabled}
          />
        </>
      ) : null}
    </div>
  );
}

function EmailFields({ form, disabled }: { form: ConnectionForm; disabled?: boolean }) {
  const { values, set, errors, secretRef, editing } = form;
  const securityOptions = (modes: readonly string[]) =>
    modes.map((value) => ({ value, label: c.securityLabels[value] ?? value }));
  return (
    <>
      <div className={styles.row}>
        <TextField
          label={c.emailAddress}
          type="email"
          value={values.emailAddress}
          onChange={(event) => set('emailAddress', event.target.value)}
          error={errors.emailAddress}
          maxLength={254}
          disabled={disabled}
          autoComplete="off"
        />
        <TextField
          label={c.fromName}
          hint={c.fromNameHint}
          value={values.fromName}
          onChange={(event) => set('fromName', event.target.value)}
          error={errors.fromName}
          maxLength={100}
          disabled={disabled}
        />
      </div>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{c.imapTitle}</legend>
        <div className={styles.rowHost}>
          <TextField
            label={c.imapHost}
            value={values.imapHost}
            onChange={(event) => set('imapHost', event.target.value)}
            error={errors['imap.host']}
            placeholder="imap.gmail.com"
            autoCapitalize="none"
            spellCheck={false}
            disabled={disabled}
          />
          <SelectField
            label={c.security}
            value={values.imapSecurity}
            onChange={(event) => {
              const next = event.target.value === 'starttls' ? 'starttls' : 'ssl';
              set('imapSecurity', next);
              set('imapPort', String(IMAP_DEFAULT_PORTS[next]));
            }}
            options={securityOptions(['ssl', 'starttls'])}
            error={errors['imap.security']}
            disabled={disabled}
          />
          <TextField
            label={c.port}
            value={values.imapPort}
            onChange={(event) => set('imapPort', event.target.value)}
            error={errors['imap.port']}
            inputMode="numeric"
            maxLength={5}
            disabled={disabled}
          />
        </div>
        <div className={styles.row}>
          <TextField
            label={c.username}
            value={values.imapUsername}
            onChange={(event) => set('imapUsername', event.target.value)}
            error={errors['imap.username']}
            autoCapitalize="none"
            spellCheck={false}
            autoComplete="off"
            disabled={disabled}
          />
          <SecretField
            ref={secretRef('imapPassword')}
            label={c.password}
            hint={editing ? c.passwordKeep : undefined}
            error={errors['imap.password']}
            disabled={disabled}
          />
        </div>
        <div className={styles.row}>
          <TextField
            label={c.folder}
            value={values.folder}
            onChange={(event) => set('folder', event.target.value)}
            error={errors['imap.folder']}
            maxLength={200}
            disabled={disabled}
          />
          <TextField
            label={c.pollInterval}
            hint={c.pollHint}
            value={values.pollInterval}
            onChange={(event) => set('pollInterval', event.target.value)}
            error={errors.pollIntervalMinutes}
            inputMode="numeric"
            maxLength={2}
            disabled={disabled}
          />
        </div>
        <Checkbox
          checked={values.markAsRead}
          onChange={(event) => set('markAsRead', event.target.checked)}
          disabled={disabled}
        >
          {c.markAsRead}
        </Checkbox>
      </fieldset>
      <fieldset className={styles.fieldset}>
        <legend className={styles.legend}>{c.smtpTitle}</legend>
        <RadioGroup.Root
          className={styles.modes}
          value={values.smtpMode}
          onValueChange={(value) => set('smtpMode', value === 'custom' ? 'custom' : 'system')}
          aria-label={c.smtpTitle}
          disabled={disabled}
        >
          {(
            [
              ['system', c.smtpSystem, c.smtpSystemHint],
              ['custom', c.smtpCustom, c.smtpCustomHint],
            ] as const
          ).map(([value, label, hint]) => (
            <RadioGroup.Item key={value} value={value} className={styles.mode}>
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
        {values.smtpMode === 'custom' ? (
          <>
            <div className={styles.rowHost}>
              <TextField
                label={c.smtpHost}
                value={values.smtpHost}
                onChange={(event) => set('smtpHost', event.target.value)}
                error={errors['smtp.host']}
                placeholder="smtp.gmail.com"
                autoCapitalize="none"
                spellCheck={false}
                disabled={disabled}
              />
              <SelectField
                label={c.security}
                value={values.smtpSecurity}
                onChange={(event) => {
                  const next =
                    (['ssl', 'starttls', 'none'] as const).find(
                      (item) => item === event.target.value,
                    ) ?? 'starttls';
                  set('smtpSecurity', next);
                  set('smtpPort', String(SMTP_DEFAULT_PORTS[next]));
                }}
                options={securityOptions(['ssl', 'starttls'])}
                error={errors['smtp.security']}
                disabled={disabled}
              />
              <TextField
                label={c.port}
                value={values.smtpPort}
                onChange={(event) => set('smtpPort', event.target.value)}
                error={errors['smtp.port']}
                inputMode="numeric"
                maxLength={5}
                disabled={disabled}
              />
            </div>
            <div className={styles.row}>
              <TextField
                label={c.username}
                value={values.smtpUsername}
                onChange={(event) => set('smtpUsername', event.target.value)}
                error={errors['smtp.username']}
                autoCapitalize="none"
                spellCheck={false}
                autoComplete="off"
                disabled={disabled}
              />
              <SecretField
                ref={secretRef('smtpPassword')}
                label={c.password}
                hint={editing ? c.passwordKeep : undefined}
                error={errors['smtp.password']}
                disabled={disabled}
              />
            </div>
          </>
        ) : null}
      </fieldset>
      <TextAreaField
        label={c.trustedTitle}
        optional
        hint={c.trustedHint}
        value={values.trusted}
        onChange={(event) => set('trusted', event.target.value)}
        error={
          errors.trustedAuthServIds ??
          Object.entries(errors).find(([key]) => key.startsWith('trustedAuthServIds'))?.[1]
        }
        rows={2}
        spellCheck={false}
        autoCapitalize="none"
        disabled={disabled}
      />
    </>
  );
}
