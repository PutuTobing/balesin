import {
  TWO_FACTOR_CHALLENGE_MINUTES,
  totpCodeSchema,
  twoFactorCodeSchema,
  type TwoFactorChallengeResponse,
  type TwoFactorMethod,
  type VerifyTwoFactorResponse,
} from '@balesin/shared';
import { useMutation } from '@tanstack/react-query';
import { ArrowLeft, KeyRound, Smartphone } from 'lucide-react';
import { useEffect, useEffectEvent, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { FormErrorNotice } from '../../components/ui/FormErrorNotice';
import { Notice } from '../../components/ui/Notice';
import { SubmitButton } from '../../components/ui/SubmitButton';
import { t } from '../../i18n/id';
import { cx } from '../../lib/cx';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { useLock } from '../../lib/use-lock';
import { CodeField } from '../two-factor/CodeField';
import { BACKUP_CODES_LOW } from '../two-factor/constants';
import styles from './Login.module.css';
import type { ReturnMessage } from './LoginPage';

const copy = t.twoFactor.login;

interface TwoFactorLoginFormProps {
  challenge: TwoFactorChallengeResponse;
  method: TwoFactorMethod;
  onMethodChange: (method: TwoFactorMethod) => void;
  /** Waktu tantangan diterima (jam perangkat), dasar batas 5 menit. */
  receivedAt: number;
  onVerified: (response: VerifyTwoFactorResponse) => Promise<void>;
  /** Kembali ke langkah email + password, dengan pesan (atau tanpa, bila dipilih sendiri). */
  onRestart: (message: ReturnMessage | null) => void;
}

/**
 * Langkah kedua saat masuk: kode 6 digit dari aplikasi autentikator, atau kode cadangan.
 * `challengeToken` hanya ada di memori komponen ini (tidak di URL atau penyimpanan browser).
 *
 * - Kode salah → pesan di isian (memuat sisa percobaan dari server), isian dipilih ulang.
 * - Tantangan habis (5 menit, 3 kode salah, atau ditolak server) → kembali ke password + pesan.
 * - 429 → tombol terkunci dengan hitung mundur; setelah lewat, kembali ke password (tantangan
 *   sudah kedaluwarsa selama kunci 15 menit).
 */
export function TwoFactorLoginForm({
  challenge,
  method,
  onMethodChange,
  receivedAt,
  onVerified,
  onRestart,
}: TwoFactorLoginFormProps) {
  const [code, setCode] = useState('');
  const [fieldError, setFieldError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const lock = useLock();
  // Naik setiap kali isian perlu difokus (+ dipilih bila `select`).
  const [focusTick, setFocusTick] = useState<{ tick: number; select: boolean }>({
    tick: 0,
    select: false,
  });
  const canUseBackup = challenge.methods.includes('backup_code');

  useEffect(() => {
    inputRef.current?.focus();
    if (focusTick.select) inputRef.current?.select();
  }, [focusTick]);

  const verify = useMutation({
    mutationFn: endpoints.twoFactor.verify,
    onSuccess: onVerified,
    onError: (error) => {
      if (!isApiError(error)) {
        setFocusTick((value) => ({ tick: value.tick + 1, select: false }));
        return;
      }
      if (error.code === 'TWO_FACTOR_CHALLENGE_INVALID') {
        onRestart({ tone: 'danger', message: error.message });
        return;
      }
      if (error.code === 'VALIDATION_ERROR') {
        const detail = error.details.find((item) => item.field === 'code');
        if (!detail) {
          // Token tantangan rusak/hilang: sama dengan tantangan tidak berlaku.
          onRestart({ tone: 'danger', message: error.details[0]?.message ?? error.message });
          return;
        }
        setFieldError(detail.message);
        setFocusTick((value) => ({ tick: value.tick + 1, select: true }));
        return;
      }
      if (error.status === 429 && error.retryAfterSeconds) lock.lockFor(error.retryAfterSeconds);
      setFocusTick((value) => ({ tick: value.tick + 1, select: false }));
    },
  });

  // Ganti jenis kode → isian dikosongkan, error lama dibuang, fokus ke isian baru.
  const switchMethod = (next: TwoFactorMethod) => {
    onMethodChange(next);
    setCode('');
    setFieldError(null);
    verify.reset();
    setFocusTick((value) => ({ tick: value.tick + 1, select: false }));
  };

  // Batas 5 menit dihitung dari saat tantangan diterima (tidak bergantung jam perangkat yang
  // mungkin selisih dengan server). Selama terkunci, kepulangan ditunda sampai kunci habis.
  const expire = useEffectEvent(() => {
    if (lock.locked || verify.isPending) return;
    onRestart({ tone: 'info', role: 'status', message: copy.expired });
  });
  useEffect(() => {
    const timer = window.setTimeout(
      expire,
      Math.max(0, receivedAt + TWO_FACTOR_CHALLENGE_MINUTES * 60_000 - Date.now()),
    );
    return () => window.clearTimeout(timer);
  }, [receivedAt]);

  const afterLock = useEffectEvent(() => {
    onRestart({ tone: 'success', role: 'status', message: copy.unlocked });
  });
  useEffect(() => {
    if (lock.unlocked) afterLock();
  }, [lock.unlocked]);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (lock.locked || verify.isPending) return;
    const schema = method === 'totp' ? totpCodeSchema : twoFactorCodeSchema;
    const parsed = schema.safeParse(code);
    if (!parsed.success) {
      setFieldError(parsed.error.issues[0]?.message ?? copy.totpLabel);
      setFocusTick((value) => ({ tick: value.tick + 1, select: false }));
      return;
    }
    setFieldError(null);
    verify.mutate({ challengeToken: challenge.challengeToken, code: parsed.data });
  };

  const error = verify.error;
  const serverError =
    error && !(isApiError(error) && error.code === 'VALIDATION_ERROR') ? error : null;

  return (
    <>
      <form className={styles.form} onSubmit={submit} noValidate>
        <CodeField
          ref={inputRef}
          kind={method}
          label={method === 'totp' ? copy.totpLabel : copy.backupLabel}
          hint={method === 'totp' ? copy.totpHint : copy.backupHint}
          name={method === 'totp' ? 'totp' : 'kode-cadangan'}
          value={code}
          onValueChange={(value) => {
            setCode(value);
            if (fieldError) setFieldError(null);
          }}
          error={fieldError}
          disabled={verify.isPending}
        />
        <SubmitButton
          className={styles.submit}
          pending={verify.isPending}
          pendingLabel={copy.submitting}
          lock={lock}
        >
          {copy.submit}
        </SubmitButton>
        {/* Pesan server di bawah tombol: isian dan tombol tidak bergeser (kritikus W1). */}
        <FormErrorNotice error={serverError} lock={lock} lockedTitle={copy.lockedTitle} />
      </form>
      <div className={cx(styles.footnote, styles.alternatives)}>
        <p>
          {method === 'backup_code'
            ? copy.useTotpPrompt
            : canUseBackup
              ? copy.useBackupPrompt
              : copy.noBackupCodes}
        </p>
        {method === 'backup_code' || canUseBackup ? (
          <Button
            variant="ghost"
            className={styles.flushButton}
            onClick={() => switchMethod(method === 'backup_code' ? 'totp' : 'backup_code')}
            // Selama terkunci kode apa pun ditolak server; jalan yang tersisa: kembali.
            disabled={verify.isPending || lock.locked}
          >
            <Icon icon={method === 'backup_code' ? Smartphone : KeyRound} size={16} />
            {method === 'backup_code' ? copy.useTotp : copy.useBackup}
          </Button>
        ) : null}
        <Button
          variant="ghost"
          className={cx(styles.flushButton, styles.backLink)}
          onClick={() => onRestart(null)}
          disabled={verify.isPending}
        >
          <Icon icon={ArrowLeft} size={16} />
          {copy.back}
        </Button>
      </div>
    </>
  );
}

/**
 * Berhasil masuk dengan kode cadangan: sisa kode diberitahukan (kontrak: tampilkan sisa dan
 * sarankan membuat ulang bila tinggal sedikit) sebelum masuk ke aplikasi.
 */
export function BackupCodeUsed({
  remaining,
  onContinue,
  onMakeNew,
}: {
  remaining: number;
  onContinue: () => void;
  onMakeNew: () => void;
}) {
  const low = remaining <= BACKUP_CODES_LOW;
  return (
    <div className={styles.form}>
      {low ? (
        <>
          <Notice tone="warning">{copy.backupUsed.low}</Notice>
          <Button variant="primary" size="lg" className={styles.submit} onClick={onMakeNew}>
            {copy.backupUsed.makeNew}
          </Button>
          <Button size="lg" onClick={onContinue}>
            {copy.backupUsed.later}
          </Button>
        </>
      ) : (
        <Button variant="primary" size="lg" className={styles.submit} onClick={onContinue}>
          {copy.backupUsed.continue}
        </Button>
      )}
    </div>
  );
}
