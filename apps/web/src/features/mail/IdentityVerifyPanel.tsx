import { MAIL_VERIFICATION_UNAVAILABLE_MESSAGES, type MailIdentity } from '@balesin/shared';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Button } from '../../components/ui/Button';
import { Notice, type NoticeTone } from '../../components/ui/Notice';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { CodeField } from '../two-factor/CodeField';
import { useLatest } from './compose/use-latest';
import { mailKeys, refreshIdentities } from './mail-queries';
import own from './MailComposeSettings.module.css';

const i = t.mail.identities;
const clockFormat = new Intl.DateTimeFormat('id-ID', { hour: '2-digit', minute: '2-digit' });

export interface IdentityFlash {
  tone: NoticeTone;
  text: string;
}

/** Mulai verifikasi otomatis hanya bila alamat belum pernah diverifikasi dan verifikasi tersedia. */
function shouldAutoStartVerification(identity: MailIdentity): boolean {
  return identity.verification.state === 'unverified' && identity.verification.available;
}

/**
 * Kotak verifikasi satu alamat pengirim (KONTRAK-API-EMAIL-TULIS §3.2/§3.4): tidak tersedia (alasan),
 * menunggu (otomatis lewat kotak surat; kode 6 angka sebagai cadangan + kirim ulang), atau belum
 * dimulai (tombol Verifikasi). Dipakai di kartu Alamat pengirim dan langkah akhir wizard Tambah akun
 * (`autoStart`: email verifikasi langsung dikirim sekali saat kotak tampil). Terverifikasi = kosong.
 */
export function IdentityVerifyPanel({
  identity,
  onFlash,
  autoStart = false,
  nested = false,
}: {
  identity: MailIdentity;
  onFlash: (flash: IdentityFlash) => void;
  autoStart?: boolean;
  /**
   * Di dalam `<form>` lain (wizard): tanpa `<form>` sendiri (form bersarang tidak sah dan submit-nya
   * merambat ke form luar). Enter di kolom kode tetap memeriksa kode, bukan mengirim form luar.
   */
  nested?: boolean;
}) {
  const queryClient = useQueryClient();
  const { verification } = identity;
  const [code, setCode] = useState('');
  const [codeError, setCodeError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'send' | 'confirm' | null>(null);
  const started = useRef(false);

  const start = async (quiet = false) => {
    setBusy('send');
    try {
      const response = await endpoints.mail.startVerification(identity.id);
      queryClient.setQueryData<{ identities: MailIdentity[] }>(
        mailKeys.identities(identity.accountId),
        (data) =>
          data && {
            identities: data.identities.map((item) =>
              item.id === identity.id ? { ...item, verification: response.verification } : item,
            ),
          },
      );
      if (!quiet) onFlash({ tone: 'success', text: i.verificationSent(identity.address) });
    } catch (caught) {
      onFlash({ tone: 'danger', text: isApiError(caught) ? caught.message : t.api.network });
    } finally {
      setBusy(null);
    }
  };

  // Langkah akhir wizard: kirim email verifikasi sekali tanpa menunggu klik (kontrak §3.4).
  const startRef = useLatest(start);
  useEffect(() => {
    if (!autoStart || started.current || !shouldAutoStartVerification(identity)) return;
    started.current = true;
    void startRef.current(true);
  }, [autoStart, identity, startRef]);

  const confirm = async (event?: FormEvent) => {
    event?.preventDefault();
    if (!/^\d{6}$/.test(code.trim())) {
      setCodeError(i.codeShort);
      return;
    }
    setBusy('confirm');
    setCodeError(null);
    try {
      await endpoints.mail.confirmVerification(identity.id, code.trim());
      setCode('');
      refreshIdentities(queryClient, identity.accountId);
      onFlash({ tone: 'success', text: i.verifiedNow(identity.address) });
    } catch (caught) {
      setCodeError(isApiError(caught) ? caught.message : t.api.network);
    } finally {
      setBusy(null);
    }
  };

  const fields = (
    <>
      <CodeField
        kind="totp"
        label={i.codeLabel(identity.address)}
        value={code}
        onValueChange={(value) => {
          setCode(value);
          setCodeError(null);
        }}
        error={codeError}
        hint={verification.pending ? i.attemptsLeft(verification.pending.attemptsLeft) : undefined}
        className={own.codeField}
      />
      <div className={own.codeActions}>
        <Button
          type={nested ? 'button' : 'submit'}
          variant="primary"
          loading={busy === 'confirm'}
          onClick={nested ? () => void confirm() : undefined}
        >
          {busy === 'confirm' ? i.confirming : i.confirmCode}
        </Button>
        <Button loading={busy === 'send'} disabled={busy !== null} onClick={() => void start()}>
          {busy === 'send' ? i.sending : i.resend}
        </Button>
      </div>
    </>
  );

  if (verification.state === 'verified') return null;
  const unavailable =
    !verification.available && verification.unavailableReason
      ? MAIL_VERIFICATION_UNAVAILABLE_MESSAGES[verification.unavailableReason]
      : null;

  return (
    <div className={own.verify}>
      {unavailable ? (
        <Notice tone="warning">{unavailable}</Notice>
      ) : verification.state === 'pending' ? (
        <>
          <p className={own.verifyText}>
            {verification.pending?.expiresAt
              ? i.pendingBody(
                  identity.address,
                  clockFormat.format(new Date(verification.pending.expiresAt)),
                )
              : i.pendingNoTime(identity.address)}
          </p>
          {nested ? (
            <div
              className={own.codeForm}
              onKeyDown={(event) => {
                if (event.key !== 'Enter' || !(event.target instanceof HTMLInputElement)) return;
                event.preventDefault();
                event.stopPropagation();
                void confirm();
              }}
            >
              {fields}
            </div>
          ) : (
            <form className={own.codeForm} onSubmit={(event) => void confirm(event)} noValidate>
              {fields}
            </form>
          )}
        </>
      ) : verification.state === 'unverified' ? (
        <div className={own.verifyRow}>
          <p className={own.verifyText}>{i.unverifiedBody}</p>
          <Button variant="primary" loading={busy === 'send'} onClick={() => void start()}>
            {busy === 'send' ? i.sending : i.verify}
          </Button>
        </div>
      ) : null}
    </div>
  );
}
