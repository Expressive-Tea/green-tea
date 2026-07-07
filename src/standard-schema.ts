// src/standard-schema.ts — vendored Standard Schema (~standard) types + helpers. No imports.

/** Standard Schema v1 interface (spec.standardschema.dev): a validator under the `~standard` key. */
export interface StandardSchemaV1<Input = unknown, Output = Input> {
  readonly '~standard': {
    readonly version: 1;
    readonly vendor: string;
    validate(value: unknown): StandardResult<Output> | Promise<StandardResult<Output>>;
    readonly types?: { readonly input: Input; readonly output: Output };
  };
}

/** Validation outcome: either a parsed `value` or a list of `issues`. */
export type StandardResult<T> =
  { readonly value: T; readonly issues?: undefined } | { readonly issues: ReadonlyArray<StandardIssue> };

/** A single validation issue with a message and optional path to the offending field. */
export interface StandardIssue {
  readonly message: string;
  readonly path?: ReadonlyArray<PropertyKey | { readonly key: PropertyKey }>;
}

/** Type guard: true if `value` implements Standard Schema v1 (has a callable `~standard.validate`). */
export function isStandardSchema(value: unknown): value is StandardSchemaV1 {
  return (
    typeof value === 'object' &&
    value !== null &&
    '~standard' in value &&
    typeof (value as { ['~standard']?: { validate?: unknown } })['~standard']?.validate === 'function'
  );
}

/** Render an issue's path as a dotted string (e.g. `user.email`); empty if pathless. */
export function flattenPath(issue: StandardIssue): string {
  if (!issue.path) return '';
  return issue.path
    .map((segment) => (typeof segment === 'object' && segment !== null && 'key' in segment ? segment.key : segment))
    .map((key) => String(key))
    .join('.');
}
