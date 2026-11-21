import {
  TEMPLATE_INDUSTRIES,
  type ChannelSummary,
  type MessageTemplate,
  type TemplatePreset,
} from '@balesin/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { Button } from '../../components/ui/Button';
import { Dialog, DialogActions } from '../../components/ui/Dialog';
import { SelectField } from '../../components/ui/Field';
import { Notice } from '../../components/ui/Notice';
import { Skeleton, SkeletonRegion } from '../../components/ui/Skeleton';
import { t } from '../../i18n/id';
import { isApiError } from '../../lib/api/client';
import { endpoints } from '../../lib/api/endpoints';
import { setTemplateFlash, storeTemplate, templatePresetsQuery } from './template-queries';
import styles from './Templates.module.css';

const c = t.templates;

/**
 * Galeri preset industri: pilih nomor, lalu "Pakai" membuat DRAF (`source: preset`) yang dibuka di
 * editor untuk diperiksa dan diajukan. Preset tidak langsung diajukan ke Meta.
 */
export function PresetDialog({
  open,
  channels,
  onClose,
  onCreated,
}: {
  open: boolean;
  channels: readonly ChannelSummary[];
  onClose: () => void;
  onCreated: (template: MessageTemplate) => void;
}) {
  const queryClient = useQueryClient();
  const presets = useQuery({ ...templatePresetsQuery, enabled: open });
  const [channelId, setChannelId] = useState('');
  const chosenChannel = channelId || channels[0]?.id || '';

  const create = useMutation({
    mutationFn: (preset: TemplatePreset) =>
      endpoints.templates.fromPreset(preset.key, { channelId: chosenChannel }),
    onSuccess: ({ template }) => {
      storeTemplate(queryClient, template);
      setTemplateFlash(c.presetCreated(template.name));
      onCreated(template);
    },
  });

  const groups = new Map<string, TemplatePreset[]>();
  for (const preset of presets.data?.presets ?? []) {
    groups.set(preset.industry, [...(groups.get(preset.industry) ?? []), preset]);
  }

  return (
    <Dialog
      open={open}
      title={c.presetsTitle}
      description={c.presetsBody}
      onRequestClose={() => {
        create.reset();
        onClose();
      }}
    >
      <div className={styles.presets}>
        {channels.length > 1 ? (
          <SelectField
            label={c.presetChannel}
            value={chosenChannel}
            onChange={(event) => setChannelId(event.target.value)}
            options={channels.map((channel) => ({ value: channel.id, label: channel.name }))}
          />
        ) : null}
        {create.isError ? (
          <Notice tone="danger" role="alert">
            {isApiError(create.error) ? create.error.message : t.api.network}
          </Notice>
        ) : null}
        {presets.isPending ? (
          <SkeletonRegion className={styles.presetList}>
            {[0, 1, 2].map((index) => (
              <Skeleton key={index} className={styles.presetSkeleton} />
            ))}
          </SkeletonRegion>
        ) : presets.isError ? (
          <Notice
            tone="danger"
            role="alert"
            actions={
              <Button variant="ghost" onClick={() => void presets.refetch()}>
                {t.common.retry}
              </Button>
            }
          >
            {c.presetsFailed}
          </Notice>
        ) : (
          [...groups].map(([industry, items]) => (
            <section key={industry} className={styles.presetGroup}>
              <h3 className={styles.presetIndustry}>{TEMPLATE_INDUSTRIES[industry] ?? industry}</h3>
              <ul className={styles.presetList} aria-label={c.presetsLabel}>
                {items.map((preset) => {
                  const busy = create.isPending && create.variables.key === preset.key;
                  return (
                    <li key={preset.key} className={styles.preset}>
                      <div className={styles.presetText}>
                        <p className={styles.presetTitle}>{preset.title}</p>
                        <p className={styles.presetMeta}>
                          {c.categoryShort[preset.category]} · {preset.description}
                        </p>
                        {preset.category === 'AUTHENTICATION' ? (
                          // Isi OTP dibuat Meta: tampilkan contoh dengan sapaan aplikasi ("kamu").
                          <p className={styles.presetBody}>{c.otpPreview('123456')}</p>
                        ) : preset.content.body.text ? (
                          <p className={styles.presetBody}>{preset.content.body.text}</p>
                        ) : null}
                      </div>
                      <Button
                        aria-label={c.presetUse(preset.title)}
                        loading={busy}
                        disabled={create.isPending || !chosenChannel}
                        onClick={() => create.mutate(preset)}
                      >
                        {busy ? c.presetUsing : c.presetUseShort}
                      </Button>
                    </li>
                  );
                })}
              </ul>
            </section>
          ))
        )}
      </div>
      <DialogActions sticky>
        <Button onClick={onClose}>{c.cancel}</Button>
      </DialogActions>
    </Dialog>
  );
}
