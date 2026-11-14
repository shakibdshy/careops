import { useId, useState } from 'react';
import { useDebouncedValue } from '@tanstack/react-pacer';
import { Check, ChevronDown } from 'lucide-react';
import { Avatar } from '#/components/ui/avatar';
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
  const [activeIndex, setActiveIndex] = useState(0);
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
    setActiveIndex(0);
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
        className="pr-9"
        onFocus={() => {
          setOpen(true);
          setSearch('');
          setActiveIndex(0);
        }}
        onChange={(e) => {
          setSearch(e.target.value);
          setOpen(true);
          setActiveIndex(0);
        }}
        onBlur={() => {
          setOpen(false);
          control.onBlur();
        }}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false);
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setOpen(true);
            setActiveIndex((index) => Math.min(index + 1, filtered.length - 1));
          }
          if (e.key === 'ArrowUp') {
            e.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          }
          if (e.key === 'Enter' && open && filtered[activeIndex]) {
            e.preventDefault();
            choose(filtered[activeIndex]);
          }
        }}
      />
      <ChevronDown
        className={cn(
          'pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground transition-transform duration-200',
          open && 'rotate-180',
        )}
      />
      {open && (
        <div
          id={listboxId}
          role="listbox"
          data-testid={`${testId ?? control.testId ?? control.name}-listbox`}
          className="absolute z-30 mt-1.5 max-h-64 w-full overflow-auto rounded-xl border border-border/80 bg-popover p-1 text-popover-foreground shadow-pop animate-in fade-in zoom-in-95 slide-in-from-top-1 duration-150"
        >
          {filtered.length === 0 ? (
            <p className="px-3 py-4 text-center text-sm text-muted-foreground">{emptyMessage}</p>
          ) : (
            filtered.map((option, index) => (
              <button
                key={option.id}
                type="button"
                role="option"
                aria-selected={option.id === control.value}
                data-testid={`picker-option-${option.id}`}
                // Keep focus on the input so blur does not close the list before click.
                onMouseDown={(e) => e.preventDefault()}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => choose(option)}
                className={cn(
                  'flex w-full items-center gap-2.5 rounded-lg px-2 py-2 text-left text-sm transition-colors',
                  index === activeIndex && 'bg-accent text-accent-foreground',
                  option.id === control.value && index !== activeIndex && 'bg-accent/50',
                )}
              >
                <Avatar name={option.label} size="sm" />
                <span className="min-w-0 flex-1 truncate">
                  <span className="block truncate font-medium">{option.label}</span>
                  {option.sublabel && (
                    <span className="block truncate text-xs text-muted-foreground">
                      {option.sublabel}
                    </span>
                  )}
                </span>
                {option.id === control.value && <Check className="size-4 shrink-0 text-primary" />}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
}
