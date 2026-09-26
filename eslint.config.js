import js from '@eslint/js';
import globals from 'globals';
import reactHooks from 'eslint-plugin-react-hooks';
import reactRefresh from 'eslint-plugin-react-refresh';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['dist', 'dev-dist', 'node_modules', 'playwright-report', 'test-results'] },
  {
    extends: [js.configs.recommended, ...tseslint.configs.recommended],
    files: ['**/*.{ts,tsx}'],
    languageOptions: { ecmaVersion: 2022, globals: { ...globals.browser, ...globals.node } },
    plugins: { 'react-hooks': reactHooks, 'react-refresh': reactRefresh },
    rules: {
      ...reactHooks.configs.recommended.rules,
      'react-refresh/only-export-components': ['warn', { allowConstantExport: true }],
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
    },
  },
  {
    // Architecture rule (spec §3.2): screens, components and rules never import Dexie directly.
    files: ['src/**/*.{ts,tsx}'],
    ignores: ['src/data/local/**'],
    rules: {
      'no-restricted-imports': ['error', { paths: [{ name: 'dexie', message: 'Only src/data/local/ may import Dexie. Use the interfaces in src/data/repos.ts.' }] }],
    },
  },
  {
    // Rules are pure: no storage, no React.
    files: ['src/rules/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', { patterns: [{ group: ['react', 'react-dom', 'zustand', 'dexie', '../data/local/*', '../data/local'], message: 'src/rules must be pure TypeScript: no React, storage or Dexie.' }] }],
    },
  },
);
