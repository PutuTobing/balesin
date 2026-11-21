import { CHANNEL_TYPE_LABELS, type ChannelType } from '@balesin/shared';
import { Camera, Mail, MessageCircle, MessagesSquare, Send, type LucideIcon } from 'lucide-react';

/**
 * Ikon per jenis channel (Lucide, tanpa logo merek — merek dagang pihak ketiga tidak dipakai sebagai
 * ikon). Label selalu menyertai ikon (teks atau `aria-label`), tidak pernah ikon saja.
 */
export const CHANNEL_TYPE_ICONS: Readonly<Record<ChannelType, LucideIcon>> = {
  whatsapp: MessageCircle,
  telegram: Send,
  email: Mail,
  messenger: MessagesSquare,
  instagram: Camera,
};

export function channelTypeLabel(type: ChannelType): string {
  return CHANNEL_TYPE_LABELS[type];
}
