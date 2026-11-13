// @ts-check
import js from '@eslint/js';
import prettier from 'eslint-config-prettier';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import globals from 'globals';
import tseslint from 'typescript-eslint';

/**
 * Aturan keras CLAUDE.md: hanya WhatsApp Cloud API resmi Meta.
 * Library tidak resmi diblokir di tingkat lint supaya tidak bisa "nyelip".
 */
const UNOFFICIAL_WHATSAPP_LIBS = [
  '*baileys*',
  'whatsapp-web.js',
  '*wppconnect*',
  'venom',
  'venom-bot',
  '*open-wa*',
  'wa-automate*',
  'wa-multi-session',
];

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '**/build/**',
      '**/coverage/**',
      '**/*.gen.ts',
      'packages/db/drizzle/**',
      'e2e/screenshots/**',
      'e2e/playwright-report/**',
      'e2e/test-results/**',
      'docs/**',
      'assets/**',
    ],
  },

  js.configs.recommended,
  ...tseslint.configs.recommendedTypeChecked,

  {
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { prefer: 'type-imports', fixStyle: 'inline-type-imports' },
      ],
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
      '@typescript-eslint/no-misused-promises': [
        'error',
        { checksVoidReturn: { attributes: false } },
      ],
      eqeqeq: ['error', 'always', { null: 'ignore' }],
      'no-restricted-imports': [
        'error',
        {
          // Pola gaya gitignore: mencakup sub-path (baileys/lib/…) dan paket ber-scope.
          patterns: [
            {
              group: UNOFFICIAL_WHATSAPP_LIBS,
              message:
                'Library WhatsApp tidak resmi dilarang. Pakai WhatsApp Cloud API resmi Meta (CLAUDE.md).',
            },
          ],
        },
      ],
    },
  },

  // Berkas JS biasa (konfigurasi, hook) tidak perlu lint berbasis tipe.
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: { globals: globals.node },
  },

  // Server: api, worker, core, db, e2e
  {
    files: [
      'apps/api/**/*.ts',
      'apps/worker/**/*.ts',
      'packages/core/**/*.ts',
      'packages/db/**/*.ts',
      'e2e/**/*.ts',
    ],
    languageOptions: { globals: globals.node },
  },
  {
    // Log wajib lewat pino (redaksi rahasia) — bukan console.
    files: ['apps/api/src/**/*.ts', 'apps/worker/src/**/*.ts', 'packages/core/src/**/*.ts'],
    rules: { 'no-console': 'error' },
  },

  // Web
  {
    files: ['apps/web/**/*.{ts,tsx}'],
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    languageOptions: { globals: globals.browser },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      'no-console': ['error', { allow: ['warn', 'error'] }],
    },
  },

  prettier,
);
