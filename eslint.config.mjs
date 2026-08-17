import js from '@eslint/js';
import tseslint from 'typescript-eslint';
import stylistic from '@stylistic/eslint-plugin';

export default tseslint.config(
  { ignores: ['dist', 'node_modules', 'bench', 'coverage'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    plugins: { '@stylistic': stylistic },
    rules: {
      // The request pipeline accumulates a dynamic context object by design;
      // `any` there is load-bearing, not laziness. Flag it as a warning so new
      // uses are visible without failing the build.
      '@typescript-eslint/no-explicit-any': 'warn',
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      // Breathing room around multi-line blocks (for/while/if/function/class) so
      // consecutive blocks don't read as one wall of code. Auto-fixable.
      '@stylistic/padding-line-between-statements': [
        'error',
        { blankLine: 'always', prev: 'multiline-block-like', next: '*' },
        { blankLine: 'always', prev: '*', next: 'multiline-block-like' },
      ],
    },
  },
  {
    // Nothing in core writes to console directly — every diagnostic goes through the injectable
    // `Logger`, or an application cannot redirect it. This is the rule form of a check that was
    // otherwise a `grep` somebody has to remember to run.
    files: ['src/**/*.ts'],
    ignores: ['src/logger.ts'], // the default logger *is* the console sink; that is its whole job
    rules: { 'no-console': 'error' },
  },
);
