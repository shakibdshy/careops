/**
 * Calendar math and parsing for the date pickers. Everything is UTC: the API
 * contract books UTC starts and stores birth dates as plain YYYY-MM-DD, so the
 * pickers must never drift with the browser's local timezone.
 */

const MONTHS_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];
const MONTHS_LONG = [
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

export const WEEKDAYS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'] as const;

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

/** Strict YYYY-MM-DD → normalized date string, or undefined while incomplete. */
export function parseDateInput(text: string): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(text.trim());
  if (!match) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return undefined;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return undefined;
  }
  return `${match[1]}-${match[2]}-${match[3]}`;
}

/**
 * Accepts `YYYY-MM-DDTHH:mm`, `YYYY-MM-DD HH:mm`, optional seconds and a
 * trailing Z — the wall clock is always interpreted as UTC.
 */
export function parseDateTimeInput(text: string): string | undefined {
  const match = /^(\d{4}-\d{2}-\d{2})[T ](\d{2}):(\d{2})(?::(\d{2}))?\s*Z?$/i.exec(text.trim());
  if (!match) return undefined;
  const date = parseDateInput(match[1]!);
  if (!date) return undefined;
  const hour = Number(match[2]);
  const minute = Number(match[3]);
  const second = match[4] ? Number(match[4]) : 0;
  if (hour > 23 || minute > 59 || second > 59) return undefined;
  return `${date}T${pad(hour)}:${pad(minute)}:${pad(second)}.000Z`;
}

export function todayIso(): string {
  return new Date().toISOString().slice(0, 10);
}

export function toDateInputValue(iso: string): string {
  return iso.slice(0, 10);
}

export function toDateTimeInputValue(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString().slice(0, 16);
}

/** "Feb 2, 1991" */
export function formatDateDisplay(iso: string): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(date.getTime())) return iso;
  return `${MONTHS_SHORT[date.getUTCMonth()]} ${date.getUTCDate()}, ${date.getUTCFullYear()}`;
}

/** "Jan 1, 2030 · 10:00 UTC" */
export function formatDateTimeDisplay(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const stamp = date.toISOString();
  return `${formatDateDisplay(stamp)} · ${stamp.slice(11, 16)} UTC`;
}

/** "November 2026" */
export function monthLabel(month: Date): string {
  return `${MONTHS_LONG[month.getUTCMonth()]} ${month.getUTCFullYear()}`;
}

export function startOfMonthIso(iso: string): Date {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

export function addMonths(month: Date, count: number): Date {
  return new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + count, 1));
}

export function addDays(iso: string, count: number): string {
  const date = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + count);
  return date.toISOString().slice(0, 10);
}

export interface CalendarDay {
  iso: string;
  day: number;
  inMonth: boolean;
}

/** Six Monday-first weeks covering the month, including spill-over days. */
export function buildMonthGrid(month: Date): CalendarDay[][] {
  const first = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth(), 1));
  const mondayOffset = (first.getUTCDay() + 6) % 7;
  const start = new Date(first.getTime() - mondayOffset * 86_400_000);
  const weeks: CalendarDay[][] = [];
  for (let week = 0; week < 6; week += 1) {
    const days: CalendarDay[] = [];
    for (let day = 0; day < 7; day += 1) {
      const date = new Date(start.getTime() + (week * 7 + day) * 86_400_000);
      days.push({
        iso: date.toISOString().slice(0, 10),
        day: date.getUTCDate(),
        inMonth: date.getUTCMonth() === month.getUTCMonth(),
      });
    }
    weeks.push(days);
  }
  return weeks;
}

export function isOutOfRange(iso: string, min?: string, max?: string): boolean {
  if (min && iso < min.slice(0, 10)) return true;
  if (max && iso > max.slice(0, 10)) return true;
  return false;
}
