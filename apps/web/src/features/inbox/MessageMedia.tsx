import type { Message } from '@balesin/shared';
import { Download, FileText, Music, Play } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Icon } from '../../components/ui/Icon';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import styles from './Chat.module.css';
import { downloadMessageMedia, useMessageMedia } from './message-media';

const m = t.inbox.media;

function mediaError(error: unknown): string {
  if (isApiError(error) && error.status === 404) return m.gone;
  if (isApiError(error) && error.status === 429) return m.busy;
  return m.failed;
}

/**
 * Isi media sebuah pesan (`mediaAvailable`): gambar/stiker langsung dimuat di bingkai berukuran
 * tetap (tidak ada lompatan layout saat gambar tiba); video & audio dimuat saat diputar; dokumen
 * berupa kartu unduh dengan nama berkas sebagai teks.
 */
export function MessageMedia({ message }: { message: Message }) {
  const media = message.media;
  if (!media || !message.mediaAvailable) return null;
  switch (media.kind) {
    case 'image':
    case 'sticker':
      return <ImageMedia message={message} sticker={media.kind === 'sticker'} />;
    case 'video':
      return <PlayableMedia message={message} kind="video" />;
    case 'audio':
      return <PlayableMedia message={message} kind="audio" />;
    case 'document':
      return <DocumentMedia message={message} />;
  }
}

function ImageMedia({ message, sticker }: { message: Message; sticker: boolean }) {
  const { url, loading, error, load } = useMessageMedia(message.id, true);
  return (
    <div className={sticker ? styles.stickerFrame : styles.mediaFrame}>
      {url ? (
        <img
          src={url}
          alt={sticker ? m.stickerAlt : m.imageAlt(message.text)}
          className={styles.mediaImage}
          decoding="async"
        />
      ) : error ? (
        <MediaError error={error} onRetry={load} />
      ) : loading ? (
        <SkeletonRegion className={styles.mediaSkeleton}>
          <Skeleton className={styles.mediaSkeletonBlock} />
        </SkeletonRegion>
      ) : null}
    </div>
  );
}

function PlayableMedia({ message, kind }: { message: Message; kind: 'video' | 'audio' }) {
  const { url, loading, error, load } = useMessageMedia(message.id, false);
  if (url) {
    return kind === 'video' ? (
      <div className={styles.mediaFrame} data-kind="video">
        <video src={url} controls autoPlay className={styles.mediaImage} />
      </div>
    ) : (
      <audio src={url} controls autoPlay className={styles.audio} />
    );
  }
  return (
    <div
      className={kind === 'video' ? styles.mediaFrame : styles.audioPlaceholder}
      data-kind={kind}
    >
      {error ? (
        <MediaError error={error} onRetry={load} />
      ) : (
        <Button onClick={load} loading={loading}>
          {loading ? null : <Icon icon={kind === 'video' ? Play : Music} size={16} />}
          {loading ? m.loading : kind === 'video' ? m.loadVideo : m.loadAudio}
        </Button>
      )}
    </div>
  );
}

function DocumentMedia({ message }: { message: Message }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const filename = message.media?.filename ?? t.inbox.content.document;
  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      await downloadMessageMedia(message.id, filename);
    } catch (reason) {
      setError(reason);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className={styles.documentCard}>
      <Icon icon={FileText} size={20} className={styles.documentIcon} />
      <span className={styles.documentName} dir="auto">
        {filename}
      </span>
      <Button onClick={() => void download()} loading={busy}>
        {busy ? null : <Icon icon={Download} size={16} />}
        {busy ? m.downloading : m.download}
      </Button>
      {error ? <p className={styles.mediaErrorText}>{mediaError(error)}</p> : null}
    </div>
  );
}

function MediaError({ error, onRetry }: { error: unknown; onRetry: () => void }) {
  const gone = isApiError(error) && error.status === 404;
  return (
    <div className={styles.mediaError}>
      <p className={styles.mediaErrorText}>{mediaError(error)}</p>
      {gone ? null : <Button onClick={onRetry}>{m.retry}</Button>}
    </div>
  );
}
