/**
 * Audit-trail presentation helpers: turn the raw before→after payloads of an
 * Audit Entry into human-readable rows. The immutable payload stays the source
 * of truth — it is always available behind the entry's "Raw payload" disclosure
 * — these helpers only decide what the summary shows.
 */

/** Internal bookkeeping keys — meaningful to the record, not to a reader. */
const NOISE_KEYS = new Set([
  'id',
  '_id',
  'organizationId',
  'createdAt',
  'updatedAt',
  'patientId',
  'memberId',
]);

const LABELS: Record<string, string> = {
  firstName: 'First name',
  lastName: 'Last name',
  dateOfBirth: 'Date of birth',
  phone: 'Phone',
  contactEmail: 'Contact email',
  notes: 'Notes',
  start: 'Start (UTC)',
  durationMinutes: 'Duration',
  status: 'Status',
};

const NOTES_LIMIT = 140;

export type AuditChangeRow = {
  label: string;
  /** Formatted old value — null on create. */
  before: string | null;
  /** Formatted new value — null on delete. */
  after: string | null;
};

function payloadOf(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function humanizeKey(key: string): string {
  return (
    LABELS[key] ?? key.replace(/([a-z0-9])([A-Z])/g, '$1 $2').replace(/^./, (c) => c.toUpperCase())
  );
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined || value === '') return '—';
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (key === 'durationMinutes' && typeof value === 'number') return `${value} min`;
  if (key === 'status' && typeof value === 'string')
    return value
      .toLowerCase()
      .split(/[\s_]+/)
      .map((word) => word.replace(/^./, (c) => c.toUpperCase()))
      .join(' ');
  if (typeof value === 'string') {
    if (key === 'dateOfBirth' && /^\d{4}-\d{2}-\d{2}T/.test(value)) {
      return formatStampDate(value);
    }
    if (key === 'start') return formatStampDate(value, true);
    return value.length > NOTES_LIMIT ? `${value.slice(0, NOTES_LIMIT)}…` : value;
  }
  return JSON.stringify(value);
}

function formatStampDate(value: string, withTime = false): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const day = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
    year: 'numeric',
    timeZone: 'UTC',
  });
  if (!withTime) return day;
  const time = date.toISOString().slice(11, 16);
  return `${day} · ${time} UTC`;
}

/** A plain-language subject for the entry: "Ada Lovelace" or "starts Nov 12 · 03:17 UTC". */
export function describeEntity(entity: string, before: unknown, after: unknown): string {
  const doc = payloadOf(after) ?? payloadOf(before);
  if (!doc) return entity;
  if (entity === 'patient') {
    const name = [doc.firstName, doc.lastName].filter((v) => typeof v === 'string' && v).join(' ');
    return name || 'unnamed patient';
  }
  if (entity === 'appointment' && typeof doc.start === 'string') {
    return `starts ${formatStampDate(doc.start, true)}`;
  }
  return entity;
}

/** One row per non-noise key, showing only what actually changed. */
export function changedRows(before: unknown, after: unknown): AuditChangeRow[] {
  const beforeDoc = payloadOf(before);
  const afterDoc = payloadOf(after);
  if (!beforeDoc && !afterDoc) return [];
  const keys = [
    ...new Set([...Object.keys(beforeDoc ?? {}), ...Object.keys(afterDoc ?? {})]),
  ].filter((key) => !NOISE_KEYS.has(key));
  const rows: AuditChangeRow[] = [];
  for (const key of keys) {
    const beforeValue = beforeDoc ? beforeDoc[key] : undefined;
    const afterValue = afterDoc ? afterDoc[key] : undefined;
    if (JSON.stringify(beforeValue ?? null) === JSON.stringify(afterValue ?? null)) continue;
    rows.push({
      label: humanizeKey(key),
      before: beforeDoc ? formatValue(key, beforeValue) : null,
      after: afterDoc ? formatValue(key, afterValue) : null,
    });
  }
  return rows;
}

/** One row per non-empty field — the summary for create (after) and delete (before). */
export function summarizeDoc(doc: unknown): AuditChangeRow[] {
  const payload = payloadOf(doc);
  if (!payload) return [];
  return Object.keys(payload)
    .filter((key) => !NOISE_KEYS.has(key))
    .filter((key) => payload[key] !== null && payload[key] !== undefined && payload[key] !== '')
    .map((key) => ({
      label: humanizeKey(key),
      before: null,
      after: formatValue(key, payload[key]),
    }));
}

/** Which one-sided summary a non-update action shows, and the rows to render. */
export function entryChanges(
  action: 'create' | 'update' | 'delete',
  before: unknown,
  after: unknown,
): { heading: string; rows: AuditChangeRow[] } {
  if (action === 'update') {
    return { heading: 'Changed', rows: changedRows(before, after) };
  }
  if (action === 'create') {
    return { heading: 'Created with', rows: summarizeDoc(after) };
  }
  return { heading: 'Deleted record', rows: summarizeDoc(before) };
}
