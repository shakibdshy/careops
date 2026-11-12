import type { z, ZodType } from 'zod';

/** Error from a non-2xx API response, carrying the server's error taxonomy. */
export type ApiError = Error & {
  status?: number;
  fieldErrors?: Array<{ field: string; message: string }>;
};

/**
 * Typed fetch against the API (same-origin via the dev proxy). Responses are
 * validated against the shared contract schema — drift fails loudly on the
 * client instead of surfacing as mysterious UI bugs.
 */
export async function apiGet<S extends ZodType>(
  path: string,
  schema: S,
  init?: { signal?: AbortSignal },
): Promise<z.output<S>> {
  const res = await fetch(path, init);
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    throw Object.assign(new Error(body?.message ?? `GET ${path} failed (${res.status})`), {
      status: res.status,
    });
  }
  const parsed = schema.safeParse((await res.json()) as unknown);
  if (!parsed.success) {
    throw new Error(`GET ${path}: response failed contract validation`);
  }
  return parsed.data;
}

export async function apiPost<S extends ZodType>(
  path: string,
  schema: S,
  body: unknown,
): Promise<z.output<S>> {
  return apiSend('POST', path, schema, body);
}

export async function apiPatch<S extends ZodType>(
  path: string,
  schema: S,
  body: unknown,
): Promise<z.output<S>> {
  return apiSend('PATCH', path, schema, body);
}

async function apiSend<S extends ZodType>(
  method: 'POST' | 'PATCH',
  path: string,
  schema: S,
  body: unknown,
): Promise<z.output<S>> {
  const res = await fetch(path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const json = (await res.json().catch(() => undefined)) as
      { message?: string; errors?: Array<{ field: string; message: string }> } | undefined;
    throw Object.assign(new Error(json?.message ?? `${method} ${path} failed (${res.status})`), {
      status: res.status,
      fieldErrors: json?.errors,
    });
  }
  const parsed = schema.safeParse((await res.json()) as unknown);
  if (!parsed.success) {
    throw new Error(`${method} ${path}: response failed contract validation`);
  }
  return parsed.data;
}

export async function apiDelete(path: string): Promise<void> {
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) {
    const body = (await res.json().catch(() => undefined)) as { message?: string } | undefined;
    throw Object.assign(new Error(body?.message ?? `DELETE ${path} failed (${res.status})`), {
      status: res.status,
    });
  }
}

/** Field errors from a failed POST/PATCH, for form-level display. */
export function fieldErrorsOf(error: unknown): Array<{ field: string; message: string }> {
  const fieldErrors = (error as { fieldErrors?: unknown }).fieldErrors;
  return Array.isArray(fieldErrors)
    ? (fieldErrors as Array<{ field: string; message: string }>)
    : [];
}
