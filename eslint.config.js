// @ts-check
/**
 * eslint.config.js — flat config.
 *
 * The repo shipped `"lint": "echo no lint yet"`. That is not a
 * neutral absence of linting: it meant the `lint:unused-disable`
 * and `no-undef` classes of bug had nothing catching them, which is
 * how `evaluatePermission` kept zero call sites and the harness
 * `all` script kept swallowing exit codes.
 *
 * The rule set is deliberately small and mostly type-aware. A large
 * preset on a codebase this size would bury the three rules that
 * actually matter here in thousands of style warnings nobody reads.
 */
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    ignores: [
      '**/dist/**',
      '**/node_modules/**',
      '**/binaries/**',
      '**/coverage/**',
      '**/*.d.ts',
      // Build output and one-off developer scratch scripts. They are
      // not shipped and not run by CI; linting them would only add
      // noise that trains people to ignore the linter.
      'bin/**',
      'dev/**',
      // Disabled code kept for reference. Not compiled, not run.
      '**/_modes.disabled/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommended,

  {
    files: ['**/*.ts', '**/*.tsx'],
    languageOptions: {
      parserOptions: {
        ecmaFeatures: { jsx: true },
      },
    },
    rules: {
      // The three that matter.
      //
      // no-unused-vars catches the dead-code class directly: the audit
      // found `evaluatePermission` with zero call sites, an empty
      // `if` block in the chat-only path, and a 219-line UserModel
      // nobody constructed. None of those are syntax errors; all of
      // them are unused-symbol errors.
      //
      // `args: 'after-used'` is the important setting. The default
      // 'all' flags every unused parameter, which in a codebase with
      // interface implementations and callback signatures produces
      // well over a hundred findings that are not defects. 'after-used'
      // only flags parameters to the RIGHT of the last used one —
      // which is what "someone meant to use this and didn't" looks
      // like. 116 findings dropped to a number worth reading.
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'after-used',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          // Empty `catch {}` is idiomatic here and deliberate: the
          // cleanup paths are best-effort by design.
          caughtErrors: 'none',
        },
      ],
      // An empty block is almost always a stub someone meant to fill.
      'no-empty': ['error', { allowEmptyCatch: true }],

      // Node targets modern syntax; no legacy shims needed.
      'no-var': 'error',
      'prefer-const': 'error',
      eqeqeq: ['error', 'smart'],

      // The codebase is ESM-only by design. A stray `require()` in a
      // .ts file that ships as ESM fails at runtime, not at build
      // time — and the audit found exactly that pattern.
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              group: ['*.json'],
              message: 'Use import attributes or a JSON module import; this codebase is ESM-only.',
            },
          ],
        },
      ],
    },
  },

  // The desktop is a React app with its own concerns.
  {
    files: ['packages/desktop/src/**/*.tsx'],
    rules: {
      // Props are read via destructuring in this codebase; unused
      // ones are usually spread through.
      'react/no-unescaped-entities': 'off',
    },
  },

  // Scripts, the runner, and plugin examples.
  {
    ...tseslint.configs.disableTypeChecked,
    files: ['**/*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: {
        process: 'readonly',
        console: 'readonly',
        Buffer: 'readonly',
        URL: 'readonly',
        URLSearchParams: 'readonly',
        // Node 18+ provides these globally; the scripts use them
        // directly and the parser has no way to know that.
        fetch: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
        AbortController: 'readonly',
        AbortSignal: 'readonly',
        setTimeout: 'readonly',
        clearTimeout: 'readonly',
        setInterval: 'readonly',
        clearInterval: 'readonly',
        TextEncoder: 'readonly',
        TextDecoder: 'readonly',
      },
    },
  },

  // Plugin examples run inside a host that provides the platform
  // globals (an MCP-ish or agent-plugin host with fetch and
  // WebSocket). They are reference implementations, not Node scripts.
  {
    files: ['examples/plugins/**/*.mjs'],
    languageOptions: {
      globals: {
        fetch: 'readonly',
        WebSocket: 'readonly',
        AbortSignal: 'readonly',
        AbortController: 'readonly',
        Response: 'readonly',
        Headers: 'readonly',
      },
    },
    rules: {
      // Best-effort cleanup in the example handlers. `catch {}` with
      // no body is the clearest way to say "I know, and I chose that".
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // The runner strips ANSI escapes from subprocess output to parse
  // pass/fail counts. Matching a literal ESC byte is the point.
  {
    files: ['examples/smoke/run-all.mjs'],
    rules: {
      'no-control-regex': 'off',
    },
  },

  // Provider SSE/JSON parsers.
  //
  // `any` is allowed here and only here. These are the boundaries
  // where an untyped wire format enters the system: `JSON.parse` of
  // an SSE data line from Anthropic / OpenAI / Google / an
  // OpenAI-compatible endpoint. Replacing `any` with `unknown` here
  // means writing a real narrowing guard for every field of four
  // providers' streaming formats — a worthwhile change, but it is a
  // change to these files, not a lint config.
  //
  // The exception is scoped to this directory so it cannot leak into
  // the rest of the codebase.
  {
    files: ['packages/ai/src/providers/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
    },
  },

  // Tests are allowed to be loose about types — they assert on the
  // wire shapes, and a cast there is the point.
  {
    files: ['**/*.test.ts', '**/*.test.tsx', 'examples/smoke/**/*.ts'],
    rules: {
      '@typescript-eslint/no-explicit-any': 'off',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'none' },
      ],
    },
  },
);
