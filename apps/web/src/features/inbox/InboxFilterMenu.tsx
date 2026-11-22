import { CONVERSATION_WINDOW_FILTERS, conversationWindowFilterSchema } from '@balesin/shared';
import { Check, SlidersHorizontal, X } from 'lucide-react';
import { DropdownMenu } from 'radix-ui';
import { useRef, useState, type ReactNode } from 'react';
import { TagChip } from './TagPicker';
import { useEdgeFade } from './use-edge-fade';
import { Icon } from '../../components/ui/Icon';
import { Tooltip } from '../../components/ui/Tooltip';
import { t } from '../../i18n/id';
import {
  activeFilterCount,
  emailRecipientOptions,
  withChannel,
  type FilterChip,
  type FilterOptions,
  type InboxFilters,
} from './inbox-filters';
import styles from './InboxFilterMenu.module.css';

const ANY = '';
const f = t.inbox.filters;

/** Tombol "Saring chat" + menu pilihan. Pilihan langsung berlaku; menu tetap terbuka. */
export function InboxFilterMenu({
  filters,
  onChange,
  options,
}: {
  filters: InboxFilters;
  onChange: (filters: InboxFilters) => void;
  options: FilterOptions;
}) {
  const count = activeFilterCount(filters);
  const label = count > 0 ? f.openWithCount(count) : f.open;
  const keepOpen = (event: Event) => event.preventDefault();
  const showChannels = options.channels.length > 1 || filters.channelId !== undefined;
  const recipients = emailRecipientOptions(options.channels, filters.channelId);
  const showRecipients = recipients.length > 1 || filters.emailRecipient !== undefined;
  const [open, setOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  useEdgeFade(menuRef, 'y', [open, options.agents?.length, options.channels.length]);

  return (
    <DropdownMenu.Root modal={false} open={open} onOpenChange={setOpen}>
      <Tooltip label={f.open} side="bottom">
        <DropdownMenu.Trigger asChild>
          <button type="button" className={styles.trigger} aria-label={label}>
            <Icon icon={SlidersHorizontal} size={20} />
            {count > 0 ? (
              <span className={styles.triggerCount} aria-hidden="true">
                {count}
              </span>
            ) : null}
          </button>
        </DropdownMenu.Trigger>
      </Tooltip>
      <DropdownMenu.Portal>
        <DropdownMenu.Content
          ref={menuRef}
          align="end"
          sideOffset={4}
          collisionPadding={8}
          className={styles.menu}
        >
          <Section title={f.window}>
            <DropdownMenu.RadioGroup
              value={filters.window ?? ANY}
              onValueChange={(value) => {
                const parsed = conversationWindowFilterSchema.safeParse(value);
                onChange({ ...filters, window: parsed.success ? parsed.data : undefined });
              }}
            >
              <Radio value={ANY} onSelect={keepOpen}>
                {f.anyWindow}
              </Radio>
              {CONVERSATION_WINDOW_FILTERS.map((value) => (
                <Radio key={value} value={value} onSelect={keepOpen}>
                  {t.inbox.filters.windowLabels[value]}
                </Radio>
              ))}
            </DropdownMenu.RadioGroup>
          </Section>

          {options.agents ? (
            <Section title={f.assignee}>
              <DropdownMenu.RadioGroup
                value={filters.assignee ?? ANY}
                onValueChange={(value) => onChange({ ...filters, assignee: value || undefined })}
              >
                <Radio value={ANY} onSelect={keepOpen}>
                  {f.anyAssignee}
                </Radio>
                <Radio value="me" onSelect={keepOpen}>
                  {f.me}
                </Radio>
                <Radio value="unassigned" onSelect={keepOpen}>
                  {f.unassigned}
                </Radio>
                {options.agents.map((agent) => (
                  <Radio key={agent.id} value={agent.id} onSelect={keepOpen}>
                    {agent.name}
                  </Radio>
                ))}
              </DropdownMenu.RadioGroup>
            </Section>
          ) : null}

          {options.tags && options.tags.length > 0 ? (
            <Section title={f.tag}>
              <DropdownMenu.RadioGroup
                value={filters.tagId ?? ANY}
                onValueChange={(value) => onChange({ ...filters, tagId: value || undefined })}
              >
                <Radio value={ANY} onSelect={keepOpen}>
                  {f.anyTag}
                </Radio>
                {options.tags.map((tag) => (
                  <Radio key={tag.id} value={tag.id} onSelect={keepOpen}>
                    <TagChip tag={tag} />
                  </Radio>
                ))}
              </DropdownMenu.RadioGroup>
            </Section>
          ) : null}

          {options.departments && options.departments.length > 0 ? (
            <Section title={t.departments.filterLabel}>
              <DropdownMenu.RadioGroup
                value={filters.departmentId ?? ANY}
                onValueChange={(value) =>
                  onChange({ ...filters, departmentId: value || undefined })
                }
              >
                <Radio value={ANY} onSelect={keepOpen}>
                  {t.departments.filterAll}
                </Radio>
                {options.departments.map((department) => (
                  <Radio key={department.id} value={department.id} onSelect={keepOpen}>
                    {department.name}
                  </Radio>
                ))}
                <Radio value="none" onSelect={keepOpen}>
                  {t.departments.filterNone}
                </Radio>
              </DropdownMenu.RadioGroup>
            </Section>
          ) : null}

          {showChannels ? (
            <Section title={f.channel}>
              <DropdownMenu.RadioGroup
                value={filters.channelId ?? ANY}
                onValueChange={(value) =>
                  onChange(withChannel(filters, value || undefined, options.channels))
                }
              >
                <Radio value={ANY} onSelect={keepOpen}>
                  {f.allChannels}
                </Radio>
                {options.channels.map((channel) => (
                  <Radio key={channel.id} value={channel.id} onSelect={keepOpen}>
                    {channel.name}
                  </Radio>
                ))}
              </DropdownMenu.RadioGroup>
            </Section>
          ) : null}

          {showRecipients ? (
            <Section title={f.emailRecipient}>
              <DropdownMenu.RadioGroup
                value={filters.emailRecipient ?? ANY}
                onValueChange={(value) =>
                  onChange({ ...filters, emailRecipient: value || undefined })
                }
              >
                <Radio value={ANY} onSelect={keepOpen}>
                  {f.anyEmailRecipient}
                </Radio>
                {recipients.map((address) => (
                  <Radio key={address} value={address} onSelect={keepOpen}>
                    {address}
                  </Radio>
                ))}
              </DropdownMenu.RadioGroup>
            </Section>
          ) : null}

          <DropdownMenu.Separator className={styles.separator} />
          <DropdownMenu.CheckboxItem
            className={styles.option}
            checked={filters.unread === true}
            onCheckedChange={(checked) =>
              onChange({ ...filters, unread: checked === true ? true : undefined })
            }
            onSelect={keepOpen}
          >
            <span className={styles.optionLabel}>{f.unreadOnly}</span>
            <DropdownMenu.ItemIndicator className={styles.check}>
              <Icon icon={Check} size={16} />
            </DropdownMenu.ItemIndicator>
          </DropdownMenu.CheckboxItem>

          {count > 0 ? (
            <>
              <DropdownMenu.Separator className={styles.separator} />
              <DropdownMenu.Item className={styles.option} onSelect={() => onChange({})}>
                <span className={styles.optionLabel}>{f.clearAll}</span>
              </DropdownMenu.Item>
            </>
          ) : null}
        </DropdownMenu.Content>
      </DropdownMenu.Portal>
    </DropdownMenu.Root>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <DropdownMenu.Group className={styles.group}>
      <DropdownMenu.Label className={styles.heading}>{title}</DropdownMenu.Label>
      {children}
    </DropdownMenu.Group>
  );
}

function Radio({
  value,
  onSelect,
  children,
}: {
  value: string;
  onSelect: (event: Event) => void;
  children: ReactNode;
}) {
  return (
    <DropdownMenu.RadioItem value={value} className={styles.option} onSelect={onSelect}>
      <span className={styles.optionLabel}>{children}</span>
      <DropdownMenu.ItemIndicator className={styles.check}>
        <Icon icon={Check} size={16} />
      </DropdownMenu.ItemIndicator>
    </DropdownMenu.RadioItem>
  );
}

export function FilterChips({
  chips,
  onRemove,
}: {
  chips: FilterChip[];
  onRemove: (key: keyof InboxFilters) => void;
}) {
  if (chips.length === 0) return null;
  return (
    <ul className={styles.chips} aria-label={f.activeLabel}>
      {chips.map((chip) => (
        <li key={chip.key}>
          <button
            type="button"
            className={styles.chip}
            aria-label={f.remove(chip.label)}
            onClick={() => onRemove(chip.key)}
          >
            <span className={styles.chipLabel}>{chip.label}</span>
            <Icon icon={X} size={16} />
          </button>
        </li>
      ))}
    </ul>
  );
}
