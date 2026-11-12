import { useId, useState } from 'react';
import { useDebouncedValue } from '@tanstack/react-pacer';
import { Check } from 'lucide-react';
import { Input } from '#/components/ui/input';
import type { ZodFormControl } from '#/components/zod-form';
import { cn } from '#/lib/utils';

export interface PickerOption {
  id: string;
  label: string;
  sublabel?: string | undefined;
}

/**
 * A searchable single-select combobox. Typing is debounced with Pacer
 * (useDebouncedValue) so the option list only re-filters after the user pauses;
 * the bound form field holds the selected option's id, not the display text.
 */
export function EntityPicker({
  control,
  options,
  placeholder,
  emptyMessage = 'No matches',
  testId,
  disabled,
}: {
  control: ZodFormControl;
  options: PickerOption[];
  placeholder?: string;
  emptyMessage?: string;
  testId?: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState('');
  const [debouncedSearch] = useDebouncedValue(search, { wait: 200 });
  const listboxId = useId();
  const selected = options.find((option) => option.id === control.value);

  const query = debouncedSearch.trim().toLowerCase();
  const filtered = query
    ? options.filter(
        (option) =>
          option.label.toLowerCase().includes(query) ||
          (option.sublabel?.toLowerCase().includes(query) ?? false),
      )
    : options;

  function choose(option: PickerOption) {
    control.onChange(option.id);
    control.onBlur();
    setOpen(false);
    setSearch('');
  }

  return (
    <div className="relative">
      <Input
        id={control.name}
        name={control.name}
        role="combobox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-invalid={control.invalid || undefined}
        aria-describedby={control.invalid ? control.errorId : undefined}
        autoComplete="off"
        data-testid={testId ?? control.testId}
        placeholder={placeholder}
        disabled={disabled}
        value={open ? search : (selected?.label ?? '')}
        onFocus={() => {
          setOpen(true);
          setSearch('');
        }}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
        }}
        onBlur={() => {
          setOpen(false);
          control.onBlur();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
        }}
      />
      {open && (
        <div
          id={listboxId}
          role="listbox"
          data-testid={`${testId ?? control.testId ?? control.name}-listbox`}
          className="absolute z-20 mt-1 max-h-60 w-full overflow-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md"
        >
          {filtered.length === 0 ? (
            <p className="px-2 py-3 text-sm text-muted-foreground">{emptyMessage}</p>
          ) : (
            filtered.map((option) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === control.value}
                data-testid={`picker-option-${option.id}`}
                // Keep focus on the input so blur does not close the list before click.
                onMouseDown={(e) => e.preventDefault()}
                onClick={() => choose(option)}
                className={cn(
                  'flex w-full items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-left text-sm transition-colors hover:bg-accent hover:text-accent-foreground',
                  option.id === control.value && 'bg-accent/60',
                )}
              >
                <span className="truncate">
                  <span className="font-medium">{option.label}</span>
                  {option.sublabel && (
                    <span className="ml-2 text-muted-foreground">{option.sublabel}</span>
                  )}
                </span>
                {option.id === control.value && <Check className="size-3.5 shrink-0" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
