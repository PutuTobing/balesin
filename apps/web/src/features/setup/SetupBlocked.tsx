import { Link, useRouter, type ErrorComponentProps } from '@tanstack/react-router';
import { Check, Copy, LogIn, RotateCw } from 'lucide-react';
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { BrandLogo } from '../../brand/BrandLogo';
import { LoadFailedIllustration } from '../../components/illustrations/illustrations';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Notice } from '../../components/ui/Notice';
import { RichText } from '../../components/ui/RichText';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { usePageTitle } from '../../lib/use-page-title';
import styles from './Setup.module.css';

const TOKEN_COMMAND = `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"`;

/**
 * Perintah dengan titik patah (`<wbr />`) setelah setiap `.` dan `(`: baris patah di
 * `.toString(`, bukan di tengah kata (`randomByte|s`). Teks yang disalin tetap utuh.
 */
function BreakableCommand({ text }: { text: string }) {
  const parts = text.match(/[^.(]*[.(]?/g)?.filter(Boolean) ?? [text];
  return (
    <>
      {parts.map((part, index) => (
        // Potongan statis dari konstanta: urutannya tidak pernah berubah, indeks aman jadi key.
        <Fragment key={index}>
          {part}
          {index < parts.length - 1 ? <wbr /> : null}
        </Fragment>
      ))}
    </>
  );
}

function BlockedFrame({
  title,
  children,
  actions,
  illustration,
}: {
  title: string;
  children: ReactNode;
  actions: ReactNode;
  illustration?: ReactNode;
}) {
  return (
    <div className={styles.blockedScreen}>
      <BrandLogo className={styles.blockedLogo} />
      <main className={styles.blockedCard}>
        {illustration ? <div className={styles.blockedIllustration}>{illustration}</div> : null}
        <h1 className={styles.blockedTitle}>{title}</h1>
        <div className={styles.blockedBody}>{children}</div>
        <div className={styles.blockedActions}>{actions}</div>
      </main>
    </div>
  );
}

/**
 * Wizard tidak bisa dijalankan: token setup belum diatur di server (`no-token`), atau setup
 * ternyata sudah selesai (409 di tengah wizard, `done`).
 */
export function SetupBlocked({ kind }: { kind: 'no-token' | 'done' }) {
  usePageTitle(kind === 'done' ? t.setup.blocked.doneTitle : t.setup.blocked.noTokenTitle);
  if (kind === 'done') {
    return (
      <BlockedFrame
        title={t.setup.blocked.doneTitle}
        actions={
          <Button asChild variant="primary" size="lg">
            <Link to="/masuk" replace>
              <Icon icon={LogIn} size={16} />
              {t.setup.blocked.goToLogin}
            </Link>
          </Button>
        }
      >
        <p>{t.setup.blocked.doneBody}</p>
      </BlockedFrame>
    );
  }
  return (
    <BlockedFrame
      title={t.setup.blocked.noTokenTitle}
      actions={
        <Button variant="primary" size="lg" onClick={() => window.location.reload()}>
          <Icon icon={RotateCw} size={16} />
          {t.setup.blocked.reload}
        </Button>
      }
    >
      <p>
        <RichText text={t.setup.blocked.noTokenBody} />
      </p>
      <div className={styles.commandHead}>
        <p className={styles.blockedHint}>{t.setup.blocked.noTokenCommand}</p>
        <CopyButton text={TOKEN_COMMAND} />
      </div>
      <pre className={styles.command}>
        <code>
          <BreakableCommand text={TOKEN_COMMAND} />
        </code>
      </pre>
    </BlockedFrame>
  );
}

/** `GET /setup/status` gagal: server mati, jaringan putus. */
export function SetupStatusError({ error, reset }: ErrorComponentProps) {
  const router = useRouter();
  usePageTitle(t.setup.blocked.failedTitle);
  const retry = () => {
    void router.invalidate().finally(reset);
  };
  return (
    <BlockedFrame
      title={t.setup.blocked.failedTitle}
      illustration={<LoadFailedIllustration />}
      actions={
        <Button variant="primary" size="lg" onClick={retry}>
          <Icon icon={RotateCw} size={16} />
          {t.common.retry}
        </Button>
      }
    >
      <p>{t.setup.blocked.failedBody}</p>
      {isApiError(error) ? (
        <Notice tone="danger" className={styles.blockedNotice}>
          {error.message}
        </Notice>
      ) : null}
    </BlockedFrame>
  );
}

const COPIED_MS = 2000;

/** "Salin perintah" → "Tersalin" selama 2 detik; pembaca layar diberi tahu lewat wilayah status. */
function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), COPIED_MS);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // Clipboard ditolak (mis. bukan https): perintah tetap bisa dipilih dan disalin manual.
    }
  };

  return (
    <>
      <Button onClick={() => void copy()}>
        <Icon icon={copied ? Check : Copy} size={16} />
        {copied ? t.setup.blocked.copied : t.setup.blocked.copy}
      </Button>
      <span role="status" className="sr-only">
        {copied ? t.setup.blocked.copiedAnnouncement : ''}
      </span>
    </>
  );
}
