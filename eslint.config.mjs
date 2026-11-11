import js from '@eslint/js';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Lint gate for the bridge.
 *
 * Scope: correctness-leaning rules only. This codebase deliberately uses a
 * handful of patterns that the stylistic presets fight (dynamic `fs` access in
 * `-e` scripts, `any` at the JSON boundary), so style stays out of the way and
 * the rules below catch things that actually break at runtime: unused
 * bindings, shadowed globals, loose equality, `var`, reassigned `const`s.
 */
export default tseslint.config(
  {
    ignores: ['dist/**', 'release/**', 'node_modules/**', 'coverage/**'],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      // Prefix with `_` to state "intentionally unused".
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
      // JSON coming off the wire is genuinely untyped; narrowing happens at the
      // parse boundary, so an explicit `any` there is honest.
      '@typescript-eslint/no-explicit-any': 'warn',
      eqeqeq: ['error', 'smart'],
      'no-var': 'error',
      'prefer-const': 'error',
      'no-console': 'off',
    },
  },
);
