import { useEffect, useRef, useState } from 'react';
import { ChevronDown, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
import {
  addDays,
  addMonths,
  buildMonthGrid,
  isOutOfRange,
  monthLabel,
  todayIso,
  WEEKDAYS,
} from '#/lib/dates';
import { cn } from '#/lib/utils';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

/**
 * UTC month grid with roving keyboard focus: arrows move by day/week,
 * PageUp/PageDown by month, Home/End to the week edges, Enter/Space selects.
 */
export function Calendar({
  month,
  onMonthChange,
  selected,
  onSelect,
  min,
  max,
  autoFocus = false,
  className,
}: {
  month: Date;
  onMonthChange: (next: Date) => void;
  selected: string | undefined;
  onSelect: (iso: string) => void;
  min?: string | undefined;
  max?: string | undefined;
  autoFocus?: boolean | undefined;
  className?: string | undefined;
}) {
  const today = todayIso();
  const [focusedIso, setFocusedIso] = useState(selected ?? today);
  const [choosing, setChoosing] = useState(false);
  const gridRef = useRef<HTMLDivElement>(null);
  const wantsFocusRef = useRef(autoFocus);

  useEffect(() => {
    if (!wantsFocusRef.current) return;
    wantsFocusRef.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedIso}"]`)?.focus();
    // Only on mount: later focus moves are handled by moveFocus below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function moveFocus(nextIso: string) {
    setFocusedIso(nextIso);
    const nextMonth = new Date(`${nextIso}T00:00:00Z`);
    if (
      nextMonth.getUTCFullYear() !== month.getUTCFullYear() ||
      nextMonth.getUTCMonth() !== month.getUTCMonth()
    ) {
      onMonthChange(new Date(Date.UTC(nextMonth.getUTCFullYear(), nextMonth.getUTCMonth(), 1)));
      wantsFocusRef.current = true;
    } else {
      gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${nextIso}"]`)?.focus();
    }
  }

  // After a month change triggered by keyboard, land focus on the new grid.
  useEffect(() => {
    if (!wantsFocusRef.current) return;
    wantsFocusRef.current = false;
    gridRef.current?.querySelector<HTMLButtonElement>(`[data-date="${focusedIso}"]`)?.focus();
  }, [month, focusedIso]);

  function navigate(next: Date) {
    const day = Math.min(Number(focusedIso.slice(8, 10)), 28);
    const iso = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    setFocusedIso(iso);
    onMonthChange(next);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    const keyDeltas: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };
    const delta = keyDeltas[event.key];
    if (delta !== undefined) {
      event.preventDefault();
      moveFocus(addDays(focusedIso, delta));
      return;
    }
    if (event.key === 'PageUp' || event.key === 'PageDown') {
      event.preventDefault();
      const next = addMonths(month, event.key === 'PageUp' ? -1 : 1);
      const target = addDays(focusedIso, 0);
      const day = Math.min(Number(target.slice(8, 10)), 28);
      const iso = `${next.getUTCFullYear()}-${String(next.getUTCMonth() + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
      moveFocus(iso);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const weekday = (new Date(`${focusedIso}T00:00:00Z`).getUTCDay() + 6) % 7;
      moveFocus(addDays(focusedIso, event.key === 'Home' ? -weekday : 6 - weekday));
    }
  }

  const weeks = buildMonthGrid(month);
  const navButton =
    'flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50';

  return (
    <div className={cn('w-[280px] select-none', className)}>
      <div className="mb-2 flex items-center justify-between gap-1">
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Previous year"
            className={navButton}
            onClick={() => navigate(addMonths(month, -12))}
          >
            <ChevronsLeft className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Previous month"
            className={navButton}
            onClick={() => navigate(addMonths(month, -1))}
          >
            <ChevronLeft className="size-4" />
          </button>
        </div>
        <button
          type="button"
          aria-live="polite"
          aria-expanded={choosing}
          onClick={() => setChoosing((value) => !value)}
          className="flex items-center gap-1 rounded-md px-2 py-1 font-display text-sm font-semibold transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          {monthLabel(month)}
          <ChevronDown
            className={cn(
              'size-3.5 text-muted-foreground transition-transform',
              choosing && 'rotate-180',
            )}
          />
        </button>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            aria-label="Next month"
            className={navButton}
            onClick={() => navigate(addMonths(month, 1))}
          >
            <ChevronRight className="size-4" />
          </button>
          <button
            type="button"
            aria-label="Next year"
            className={navButton}
            onClick={() => navigate(addMonths(month, 12))}
          >
            <ChevronsRight className="size-4" />
          </button>
        </div>
      </div>

      {choosing ? (
        <div className="grid gap-2 py-1">
          <select
            aria-label="Month"
            value={month.getUTCMonth()}
            onChange={(event) => {
              navigate(new Date(Date.UTC(month.getUTCFullYear(), Number(event.target.value), 1)));
            }}
            className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
          >
            {MONTH_NAMES.map((name, index) => (
              <option key={name} value={index}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Year"
            value={month.getUTCFullYear()}
            onChange={(event) => {
              navigate(new Date(Date.UTC(Number(event.target.value), month.getUTCMonth(), 1)));
            }}
            className="h-9 w-full rounded-lg border border-input bg-card px-2 text-sm shadow-xs focus-visible:border-ring focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/25"
          >
            {Array.from(
              {
                length:
                  (max ? Number(max.slice(0, 4)) : new Date().getUTCFullYear() + 15) -
                  (min ? Number(min.slice(0, 4)) : new Date().getUTCFullYear() - 100) +
                  1,
              },
              (_, index) =>
                (min ? Number(min.slice(0, 4)) : new Date().getUTCFullYear() - 100) + index,
            ).map((year) => (
              <option key={year} value={year}>
                {year}
              </option>
            ))}
          </select>
        </div>
      ) : (
        <>
          <div className="mb-1 grid grid-cols-7">
            {WEEKDAYS.map((weekday) => (
              <span
                key={weekday}
                className="py-1 text-center text-[10px] font-semibold uppercase tracking-[0.1em] text-muted-foreground"
              >
                {weekday}
              </span>
            ))}
          </div>

          <div ref={gridRef} role="grid" aria-label="Calendar days" onKeyDown={onKeyDown}>
            {weeks.map((week) => (
              <div key={week[0]!.iso} role="row" className="grid grid-cols-7">
                {week.map((day) => {
                  const disabled = isOutOfRange(day.iso, min, max);
                  const isSelected = selected === day.iso;
                  const isToday = day.iso === today;
                  return (
                    <button
                      key={day.iso}
                      type="button"
                      role="gridcell"
                      aria-selected={isSelected}
                      aria-label={day.iso}
                      data-date={day.iso}
                      disabled={disabled}
                      tabIndex={day.iso === focusedIso ? 0 : -1}
                      onClick={() => {
                        setFocusedIso(day.iso);
                        onSelect(day.iso);
                      }}
                      className={cn(
                        'mx-auto flex size-9 items-center justify-center rounded-lg text-sm tabular-nums transition-all duration-100 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60',
                        day.inMonth ? 'text-foreground' : 'text-muted-foreground/45',
                        !isSelected && !disabled && 'hover:bg-accent hover:text-accent-foreground',
                        isToday &&
                          !isSelected &&
                          'font-bold text-primary ring-1 ring-inset ring-ring/40',
                        isSelected &&
                          'bg-primary font-semibold text-primary-foreground shadow-sm hover:bg-primary/90',
                        disabled && 'cursor-not-allowed opacity-30 hover:bg-transparent',
                      )}
                    >
                      {day.day}
                    </button>
                  );
                })}
              </div>
            ))}
          </div>
        </>
      )}
    </div>
  );
}
