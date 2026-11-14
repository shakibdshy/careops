import { useRef, useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { Calendar } from '#/components/ui/calendar';
import { Input } from '#/components/ui/input';
import { PopoverPanel, usePopover } from '#/components/ui/popover';
import {
  isOutOfRange,
  parseDateInput,
  startOfMonthIso,
  toDateInputValue,
  todayIso,
} from '#/lib/dates';
import { cn } from '#/lib/utils';

/**
 * Date field with a calendar popover. The trigger is a real text input that
 * always shows the canonical `YYYY-MM-DD` value (a raw draft only while the
 * user is typing), so keyboard entry, autofill and Playwright's fill() never
 * fight a focus-time reformat of the field.
 */
export function DatePicker({
  value,
  onChange,
  onBlur,
  id,
  name,
  testId,
  placeholder = 'YYYY-MM-DD',
  disabled,
  invalid,
  errorId,
  min,
  max,
  allowClear = false,
  className,
}: {
  value: string;
  onChange: (next: string) => void;
  onBlur?: (() => void) | undefined;
  id?: string | undefined;
  name?: string | undefined;
  testId?: string | undefined;
  placeholder?: string | undefined;
  disabled?: boolean | undefined;
  invalid?: boolean | undefined;
  errorId?: string | undefined;
  min?: string | undefined;
  max?: string | undefined;
  allowClear?: boolean | undefined;
  className?: string | undefined;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState<string | null>(null);
  const [month, setMonth] = useState<Date>(() => startOfMonthIso(value || todayIso()));
  const [gridAutoFocus, setGridAutoFocus] = useState(false);
  const { open, setOpen, anchorRef, popoverRef, position } = usePopover(() => {
    if (document.activeElement?.closest('[data-popover-panel]')) inputRef.current?.focus();
  });

  // A non-null draft is the in-progress typed text; otherwise the field mirrors
  // the bound value, so external updates and calendar picks need no effect.
  const display = draft ?? (value ? toDateInputValue(value) : '');

  function openCalendar(focusGrid: boolean) {
    const base = value || (max && max < todayIso() ? max : todayIso());
    setMonth(startOfMonthIso(base));
    setGridAutoFocus(focusGrid);
    setOpen(true);
  }

  function selectDay(iso: string) {
    setDraft(null);
    onChange(iso);
    setOpen(false);
    inputRef.current?.focus();
  }

  const today = todayIso();

  return (
    <div ref={anchorRef} className={cn('relative', className)}>
      <Input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        spellCheck={false}
        data-testid={testId}
        placeholder={placeholder}
        disabled={disabled}
        value={display}
        aria-invalid={invalid || undefined}
        aria-describedby={invalid ? errorId : undefined}
        aria-haspopup="dialog"
        aria-expanded={open}
        className="pr-10 tabular-nums"
        onClick={() => {
          if (!open) openCalendar(false);
        }}
        onChange={(event) => {
          const next = event.target.value;
          setDraft(next);
          if (next === '') {
            onChange('');
            return;
          }
          const parsed = parseDateInput(next);
          if (parsed) onChange(parsed);
        }}
        onBlur={() => {
          setDraft(null);
          onBlur?.();
        }}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' && !open) {
            event.preventDefault();
            openCalendar(true);
          }
        }}
      />
      <button
        type="button"
        tabIndex={-1}
        aria-label="Open calendar"
        disabled={disabled}
        onClick={() => (open ? setOpen(false) : openCalendar(true))}
        className="absolute right-1 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground disabled:opacity-50"
      >
        <CalendarDays className="size-4" />
      </button>

      {open && (
        <PopoverPanel
          popoverRef={popoverRef}
          position={position}
          testId={testId ? `${testId}-calendar` : undefined}
        >
          <Calendar
            month={month}
            onMonthChange={setMonth}
            selected={value ? value.slice(0, 10) : undefined}
            onSelect={selectDay}
            min={min}
            max={max}
            autoFocus={gridAutoFocus}
          />
          <div className="mt-2 flex items-center justify-between border-t border-border/70 pt-2">
            <button
              type="button"
              disabled={isOutOfRange(today, min, max)}
              onClick={() => selectDay(today)}
              className="rounded-md px-2 py-1 text-xs font-medium text-primary transition-colors hover:bg-accent disabled:opacity-40"
            >
              Today
            </button>
            {allowClear && (
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  setDraft(null);
                  setOpen(false);
                }}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Clear
              </button>
            )}
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
