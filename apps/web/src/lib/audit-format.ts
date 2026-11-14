/**
 * Audit-trail presentation helpers: turn the raw before→after payloads of an
 * Audit Entry into human-readable rows. The immutable payload stays the source
 * of truth — it is always available behind the entry's "Raw payload" disclosure
 * — these helpers only decide what the summary shows.
 */
import type { AuditEntry } from '@careops/shared';

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

const MAX_VALUE_LENGTH = 140;

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
    return value.length > MAX_VALUE_LENGTH ? `${value.slice(0, MAX_VALUE_LENGTH)}…` : value;
  }
  return JSON.stringify(value);
}

/** Entry timestamp: "2026-11-14 08:55:19 UTC". */
export function formatStamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  const stamp = date.toISOString();
  return `${stamp.slice(0, 10)} ${stamp.slice(11, 19)} UTC`;
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

/** Key-order-insensitive text for comparing payload values (nested objects compare by content). */
function stableValue(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableValue).join(',')}]`;
  const entries = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableValue(v)}`).join(',')}}`;
}

/** Non-noise keys across the given payloads, in first-seen order. */
function payloadKeys(...docs: Array<Record<string, unknown> | null>): string[] {
  return [...new Set(docs.flatMap((doc) => (doc ? Object.keys(doc) : [])))].filter(
    (key) => !NOISE_KEYS.has(key),
  );
}

function makeRow(
  key: string,
  beforeDoc: Record<string, unknown> | null,
  afterDoc: Record<string, unknown> | null,
): AuditChangeRow {
  return {
    label: humanizeKey(key),
    before: beforeDoc ? formatValue(key, beforeDoc[key]) : null,
    after: afterDoc ? formatValue(key, afterDoc[key]) : null,
  };
}

/** A plain-language subject for the entry, or null when the payload has nothing human to add. */
export function describeEntity(entry: AuditEntry): string | null {
  const doc = payloadOf(entry.after) ?? payloadOf(entry.before);
  if (!doc) return null;
  if (entry.entity === 'patient') {
    const name = [doc.firstName, doc.lastName].filter((v) => typeof v === 'string' && v).join(' ');
    return name || 'unnamed patient';
  }
  if (entry.entity === 'appointment' && typeof doc.start === 'string') {
    return `starts ${formatStampDate(doc.start, true)}`;
  }
  return null;
}

/** One row per non-noise key, showing only what actually changed. */
export function changedRows(before: unknown, after: unknown): AuditChangeRow[] {
  const beforeDoc = payloadOf(before);
  const afterDoc = payloadOf(after);
  if (!beforeDoc && !afterDoc) return [];
  return payloadKeys(beforeDoc, afterDoc)
    .filter((key) => stableValue(beforeDoc?.[key]) !== stableValue(afterDoc?.[key]))
    .map((key) => makeRow(key, beforeDoc, afterDoc));
}

/** One row per non-empty field — the summary for create (after) and delete (before). */
export function summarizeDoc(doc: unknown): AuditChangeRow[] {
  const payload = payloadOf(doc);
  if (!payload) return [];
  return payloadKeys(payload)
    .filter((key) => payload[key] !== null && payload[key] !== undefined && payload[key] !== '')
    .map((key) => makeRow(key, null, payload));
}

/** Which one-sided summary a non-update action shows, and the rows to render. */
export function entryChanges(entry: AuditEntry): { heading: string; rows: AuditChangeRow[] } {
  if (entry.action === 'update') {
    return { heading: 'Changed', rows: changedRows(entry.before, entry.after) };
  }
  if (entry.action === 'create') {
    return { heading: 'Created with', rows: summarizeDoc(entry.after) };
  }
  return { heading: 'Deleted record', rows: summarizeDoc(entry.before) };
}
