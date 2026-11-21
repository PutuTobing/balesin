import type { AttributeDefinition } from '@balesin/shared';
import { SelectField, TextField } from '../../components/ui/Field';
import { t } from '../../i18n/id';
import type { FieldErrors } from '../../lib/form';
import { attributeError, type AttributeValues } from './attribute-values';

const a = t.attributes;

/**
 * Isian atribut berdefinisi: Teks, Angka (`inputmode=decimal`), Tanggal (`type=date`), Pilihan
 * (`<select>`). Wajib ditandai lewat label (bukan bintang saja); yang tidak wajib "opsional".
 */
export function AttributeFields({
  definitions,
  values,
  onChange,
  errors,
  disabled,
}: {
  definitions: readonly AttributeDefinition[];
  values: AttributeValues;
  onChange: (key: string, value: string) => void;
  errors: FieldErrors;
  disabled?: boolean;
}) {
  return (
    <>
      {definitions.map((definition) => {
        const value = values[definition.key] ?? '';
        const common = {
          label: definition.label,
          optional: !definition.required,
          error: attributeError(errors, definition.key),
          disabled,
        };
        if (definition.type === 'select') {
          const options =
            definition.options.some((option) => option === value) || !value
              ? definition.options
              : [value, ...definition.options];
          return (
            <SelectField
              key={definition.id}
              {...common}
              value={value}
              onChange={(event) => onChange(definition.key, event.target.value)}
              options={[
                { value: '', label: a.selectPlaceholder },
                ...options.map((option) => ({ value: option, label: option })),
              ]}
            />
          );
        }
        return (
          <TextField
            key={definition.id}
            {...common}
            value={value}
            onChange={(event) => onChange(definition.key, event.target.value)}
            type={definition.type === 'date' ? 'date' : 'text'}
            inputMode={definition.type === 'number' ? 'decimal' : undefined}
            hint={definition.type === 'number' ? a.numberHint : undefined}
            maxLength={500}
            dir={definition.type === 'text' ? 'auto' : undefined}
          />
        );
      })}
    </>
  );
}
