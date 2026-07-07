// src/standard-schema.ts — vendored Standard Schema (~standard) types + helpers. No imports.
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

export type StandardResult<T> =
  | { readonly value: T; readonly issues?: undefined }
  | { readonly issues: ReadonlyArray<StandardIssue> };

export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

export function isStandardSchema(x: unknown): x is StandardSchemaV1 {
  return (
    typeof x === 'object' && x !== null &&
    '~standard' in x &&
    typeof (x as { ['~standard']?: { validate?: unknown } })['~standard']?.validate === 'function'
  );
}

export function flattenPath(issue: StandardIssue): string {
  if (!issue.path) return '';
  return issue.path
    .map((seg) => (typeof seg === 'object' && seg !== null && 'key' in seg ? seg.key : seg))
    .map((k) => String(k))
    .join('.');
}
