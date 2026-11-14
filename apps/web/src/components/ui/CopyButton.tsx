import { Check, Copy } from 'lucide-react';
import { useEffect, useState, type Ref } from 'react';
import { Button, type ButtonVariant } from './Button';
import { Icon } from './Icon';

const COPIED_MS = 2000;

interface CopyButtonProps {
  /** Teks yang disalin ke clipboard. */
  text: string;
  label: string;
  /** Label sesaat setelah berhasil (mis. "Tersalin"). */
  copiedLabel: string;
  /** Diumumkan pembaca layar sekali setelah berhasil. */
  announcement: string;
  size?: 'md' | 'lg';
  variant?: ButtonVariant;
  className?: string;
  /** Dipanggil setelah teks benar-benar masuk clipboard. */
  onCopied?: () => void;
  ref?: Ref<HTMLButtonElement>;
}

/**
 * Tombol salin: label berganti "Tersalin" selama 2 detik, pembaca layar diberi tahu lewat wilayah
 * status. Clipboard yang ditolak browser (mis. bukan https) diabaikan: teksnya tetap tampil dan
 * bisa dipilih lalu disalin manual.
 */
export function CopyButton({
  text,
  label,
  copiedLabel,
  announcement,
  size,
  variant,
  className,
  onCopied,
  ref,
}: CopyButtonProps) {
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
      onCopied?.();
    } catch {
      // Clipboard ditolak: teks tetap bisa dipilih dan disalin manual.
    }
  };

  return (
    <>
      <Button
        ref={ref}
        size={size}
        variant={variant}
        className={className}
        onClick={() => void copy()}
      >
        <Icon icon={copied ? Check : Copy} size={16} />
        {copied ? copiedLabel : label}
      </Button>
      <span role="status" className="sr-only">
        {copied ? announcement : ''}
      </span>
    </>
  );
}
