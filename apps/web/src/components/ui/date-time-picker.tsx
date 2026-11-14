import { useRef, useState } from 'react';
import { CalendarClock, ChevronDown, Clock } from 'lucide-react';
import { Calendar } from '#/components/ui/calendar';
import { Input } from '#/components/ui/input';
import { PopoverPanel, usePopover } from '#/components/ui/popover';
import {
  parseDateTimeInput,
  startOfMonthIso,
  toDateInputValue,
  toDateTimeInputValue,
} from '#/lib/dates';
import { cn } from '#/lib/utils';

const QUICK_TIMES = ['09:00', '12:00', '15:00', '17:00'];
const HOURS = Array.from({ length: 24 }, (_, index) => String(index).padStart(2, '0'));
const MINUTES = Array.from({ length: 60 }, (_, index) => String(index).padStart(2, '0'));

function TimeSelect({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: string;
  options: string[];
  onChange: (next: string) => void;
}) {
  return (
    <span className="relative flex-1">
      <select
        aria-label={label}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="h-8 w-full appearance-none rounded-md border border-input bg-card pl-2 pr-6 text-xs tabular-nums shadow-xs transition-colors hover:border-ring/30 focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
      >
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      <ChevronDown className="pointer-events-none absolute right-1.5 top-1/2 size-3 -translate-y-1/2 text-muted-foreground" />
    </span>
  );
}

/**
 * UTC date + time field. The trigger always shows the canonical
 * `YYYY-MM-DDTHH:mm` value (a raw draft only while typing), so typed entry,
 * autofill and Playwright's fill() never fight a focus-time reformat. The
 * popover pairs the calendar with a time panel; the bound value is always a
 * full ISO UTC instant, matching the booking contract.
 */
export function DateTimePicker({
  value,
  onChange,
  onBlur,
  id,
  name,
  testId,
  placeholder = 'YYYY-MM-DDTHH:mm',
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
  const [draftTime, setDraftTime] = useState('09:00');
  const [month, setMonth] = useState<Date>(() =>
    startOfMonthIso(value || new Date().toISOString()),
  );
  const [gridAutoFocus, setGridAutoFocus] = useState(false);
  const { open, setOpen, anchorRef, popoverRef, position } = usePopover(() => {
    if (document.activeElement?.closest('[data-popover-panel]')) inputRef.current?.focus();
  });

  // A non-null draft is the in-progress typed text; otherwise the field mirrors
  // the bound value, so external updates and calendar picks need no effect.
  const display = draft ?? (value ? toDateTimeInputValue(value) : '');
  const time = value ? toDateTimeInputValue(value).slice(11, 16) : draftTime;

  function openCalendar(focusGrid: boolean) {
    setMonth(startOfMonthIso(value || new Date().toISOString()));
    setGridAutoFocus(focusGrid);
    setOpen(true);
  }

  function selectDay(iso: string) {
    setDraft(null);
    onChange(`${iso}T${time}:00.000Z`);
    setMonth(startOfMonthIso(iso));
  }

  function changeTime(next: string) {
    if (value) {
      setDraft(null);
      onChange(`${toDateInputValue(value)}T${next}:00.000Z`);
    } else {
      setDraftTime(next);
    }
  }

  function selectNow() {
    const stamp = new Date().toISOString();
    setDraft(null);
    onChange(`${stamp.slice(0, 10)}T${stamp.slice(11, 16)}:00.000Z`);
    setMonth(startOfMonthIso(stamp));
  }

  const hour = time.slice(0, 2);
  const minute = time.slice(3, 5);

  return (
    <div ref={anchorRef} className={cn('relative', className)}>
      <Input
        ref={inputRef}
        id={id}
        name={name}
        type="text"
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
          const parsed = parseDateTimeInput(next);
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
        <CalendarClock className="size-4" />
      </button>

      {open && (
        <PopoverPanel
          popoverRef={popoverRef}
          position={position}
          testId={testId ? `${testId}-calendar` : undefined}
          className="max-w-[calc(100vw-1rem)]"
        >
          <div className="flex flex-col gap-3 sm:flex-row">
            <Calendar
              month={month}
              onMonthChange={setMonth}
              selected={value ? toDateInputValue(value) : undefined}
              onSelect={selectDay}
              min={min}
              max={max}
              autoFocus={gridAutoFocus}
            />
            <div className="flex w-full flex-col gap-2.5 border-t border-border/70 pt-3 sm:w-36 sm:border-l sm:border-t-0 sm:pl-3 sm:pt-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">
                Time · UTC
              </p>
              <div className="flex items-center gap-1.5">
                <TimeSelect
                  label="Hour (UTC)"
                  value={hour}
                  options={HOURS}
                  onChange={(next) => changeTime(`${next}:${minute}`)}
                />
                <span className="text-xs text-muted-foreground">:</span>
                <TimeSelect
                  label="Minute (UTC)"
                  value={minute}
                  options={MINUTES}
                  onChange={(next) => changeTime(`${hour}:${next}`)}
                />
              </div>
              <div className="grid grid-cols-2 gap-1">
                {QUICK_TIMES.map((quick) => (
                  <button
                    key={quick}
                    type="button"
                    onClick={() => changeTime(quick)}
                    className={cn(
                      'rounded-md border border-input px-1.5 py-1 text-[11px] tabular-nums transition-colors hover:border-ring/40 hover:bg-accent',
                      time === quick &&
                        'border-ring/50 bg-accent font-semibold text-accent-foreground',
                    )}
                  >
                    {quick}
                  </button>
                ))}
              </div>
              <button
                type="button"
                onClick={selectNow}
                className="mt-auto flex items-center justify-center gap-1.5 rounded-md bg-secondary px-2 py-1.5 text-xs font-medium text-secondary-foreground transition-colors hover:bg-secondary/70"
              >
                <Clock className="size-3.5" /> Now
              </button>
            </div>
          </div>
          <div className="mt-2 flex items-center justify-between border-t border-border/70 pt-2">
            {allowClear ? (
              <button
                type="button"
                onClick={() => {
                  onChange('');
                  setDraft(null);
                  setDraftTime('09:00');
                  setOpen(false);
                }}
                className="rounded-md px-2 py-1 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
              >
                Clear
              </button>
            ) : (
              <span />
            )}
            <button
              type="button"
              onClick={() => {
                setOpen(false);
                inputRef.current?.focus();
              }}
              className="rounded-md bg-primary px-3 py-1 text-xs font-semibold text-primary-foreground shadow-sm transition-colors hover:bg-primary/90"
            >
              Done
            </button>
          </div>
        </PopoverPanel>
      )}
    </div>
  );
}
