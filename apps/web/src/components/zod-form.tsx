import type { ReactNode } from 'react';
import { useForm, type DeepKeys } from '@tanstack/react-form';
import type { StandardSchemaV1 } from '@standard-schema/spec';
import { Alert, AlertDescription } from '#/components/ui/alert';
import { Button } from '#/components/ui/button';
import { Input } from '#/components/ui/input';
import { Label } from '#/components/ui/label';
import { Textarea } from '#/components/ui/textarea';
import { fieldErrorsOf } from '#/lib/api';

/** The bound control handed to a custom field renderer (pickers, UTC datetime). */
export type ZodFormControl = {
  value: string;
  onChange: (next: string) => void;
  onBlur: () => void;
  invalid: boolean;
  errorId: string;
  name: string;
  testId?: string | undefined;
};

/** One rendered field. `name` must be a top-level key of the schema's input. */
export type ZodFormField<TValues> = {
  name: keyof TValues & string;
  label: string;
  type?: 'text' | 'date' | 'email' | 'textarea' | 'number';
  placeholder?: string;
  /** Empty input becomes `undefined` so optional contract fields stay absent. */
  optional?: boolean;
  testId?: string;
  autoComplete?: string;
  /** Replace the default input with a custom control bound to the same field. */
  render?: (control: ZodFormControl) => ReactNode;
};

export type ZodFormProps<TSchema extends StandardSchemaV1> = {
  /** Shared contract schema, consumed as a Standard Schema validator. */
  schema: TSchema;
  defaultValues: StandardSchemaV1.InferInput<TSchema>;
  fields: Array<ZodFormField<StandardSchemaV1.InferInput<TSchema>>>;
  /** Throw an ApiError (with fieldErrors) to surface server reasons on fields. */
  onSubmit: (values: StandardSchemaV1.InferOutput<TSchema>) => Promise<void>;
  submitLabel: string;
  submitTestId?: string;
  resetOnSuccess?: boolean;
};

function errorMessage(error: unknown): string | undefined {
  if (typeof error === 'string') return error || undefined;
  if (error && typeof error === 'object' && 'message' in error) {
    const message = (error as { message?: unknown }).message;
    return typeof message === 'string' ? message : undefined;
  }
  return undefined;
}

function formErrorMessage(error: unknown): string | undefined {
  if (error && typeof error === 'object' && 'form' in error) {
    return errorMessage((error as { form?: unknown }).form);
  }
  return errorMessage(error);
}

/**
 * Reusable schema-driven form (ADR-0009): TanStack Form validates with the
 * shared Zod schema via Standard Schema; field errors merge client issues and
 * the API's `errors[]` taxonomy into one display per field.
 */
export function ZodForm<TSchema extends StandardSchemaV1>({
  schema,
  defaultValues,
  fields,
  onSubmit,
  submitLabel,
  submitTestId,
  resetOnSuccess = false,
}: ZodFormProps<TSchema>) {
  // useForm needs the validator's input tied to the form data type; the
  // generic constraint alone leaves it as StandardSchemaV1<unknown, unknown>.
  const validator: StandardSchemaV1<StandardSchemaV1.InferInput<TSchema>, unknown> = schema;
  const form = useForm({
    defaultValues,
    // Server errors land in the onSubmit error map; they must not block the
    // corrected retry, so submission stays available and validation gates it.
    canSubmitWhenInvalid: true,
    validators: { onChange: validator },
    onSubmit: async ({ value }) => {
      try {
        await onSubmit(value);
        form.setErrorMap({ onSubmit: undefined });
        if (resetOnSuccess) form.reset();
      } catch (error) {
        form.setErrorMap({
          onSubmit: {
            form: error instanceof Error ? error.message : 'Something went wrong',
            fields: Object.fromEntries(
              fieldErrorsOf(error).map((e) => [e.field, e.message]),
            ) as Partial<Record<DeepKeys<StandardSchemaV1.InferInput<TSchema>>, string>>,
          },
        });
      }
    },
  });

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        e.stopPropagation();
        void form.handleSubmit();
      }}
      className="grid gap-4"
      noValidate
    >
      {fields.map((config) => (
        <form.Field key={config.name} name={config.name}>
          {(field) => {
            const value = String(field.state.value ?? '');
            const errors = field.state.meta.errors
              .map(errorMessage)
              .filter((message): message is string => Boolean(message));
            const invalid = errors.length > 0;
            const errorId = `${config.name}-error`;
            const handleChange = (next: string) => {
              const normalized =
                config.type === 'number'
                  ? next === ''
                    ? undefined
                    : Number(next)
                  : config.optional && next === ''
                    ? undefined
                    : next;
              field.handleChange(normalized as typeof field.state.value);
            };
            const control: ZodFormControl = {
              value,
              onChange: handleChange,
              onBlur: field.handleBlur,
              invalid,
              errorId,
              name: config.name,
              testId: config.testId,
            };
            const shared = {
              id: config.name,
              name: config.name,
              value,
              placeholder: config.placeholder,
              autoComplete: config.autoComplete,
              'data-testid': config.testId,
              'aria-invalid': invalid || undefined,
              'aria-describedby': invalid ? errorId : undefined,
              onBlur: field.handleBlur,
            };
            return (
              <div className="grid gap-1.5">
                <Label htmlFor={config.name}>
                  {config.label}
                  {config.optional && (
                    <span className="font-normal text-muted-foreground"> (optional)</span>
                  )}
                </Label>
                {config.render ? (
                  config.render(control)
                ) : config.type === 'textarea' ? (
                  <Textarea {...shared} rows={3} onChange={(e) => handleChange(e.target.value)} />
                ) : (
                  <Input
                    {...shared}
                    type={config.type ?? 'text'}
                    onChange={(e) => handleChange(e.target.value)}
                  />
                )}
                {invalid && (
                  <p
                    id={errorId}
                    data-testid={`field-error-${config.name}`}
                    className="text-sm text-destructive"
                  >
                    {errors.join(' · ')}
                  </p>
                )}
              </div>
            );
          }}
        </form.Field>
      ))}
      <form.Subscribe selector={(state) => [state.isSubmitting, state.errorMap.onSubmit] as const}>
        {([isSubmitting, formError]) => {
          const message = formErrorMessage(formError);
          return (
            <div className="grid gap-3">
              {message && (
                <Alert variant="destructive" data-testid="zod-form-error">
                  <AlertDescription>{message}</AlertDescription>
                </Alert>
              )}
              <Button type="submit" disabled={isSubmitting} data-testid={submitTestId}>
                {isSubmitting ? 'Saving…' : submitLabel}
              </Button>
            </div>
          );
        }}
      </form.Subscribe>
    </form>
  );
}
