import js from '@eslint/js'
import globals from 'globals'
import react from 'eslint-plugin-react'
import reactHooks from 'eslint-plugin-react-hooks'
import reactRefresh from 'eslint-plugin-react-refresh'
import { defineConfig, globalIgnores } from 'eslint/config'

export default defineConfig([
  // Build output, dependencies, and packages that carry their own ESLint
  // config (functions/ has functions/eslint.config.js and runs its own lint).
  globalIgnores([
    'dist',
    '**/node_modules',
    'functions',
  ]),

  // ── Vite React app (browser) ───────────────────────────────────────────────
  {
    files: ['src/**/*.{js,jsx}'],
    extends: [
      js.configs.recommended,
      reactHooks.configs.flat.recommended,
      reactRefresh.configs.vite,
    ],
    plugins: { react },
    languageOptions: {
      ecmaVersion: 2020,
      globals: globals.browser,
      parserOptions: {
        ecmaVersion: 'latest',
        ecmaFeatures: { jsx: true },
        sourceType: 'module',
      },
    },
    rules: {
      // Teach no-unused-vars that JSX (<motion.div>) counts as using the
      // referenced identifier; without this, JSX-only imports read as unused.
      'react/jsx-uses-vars': 'error',
      'react/jsx-uses-react': 'error',
      // ignoreRestSiblings lets `({ node, ...props })` strip a prop via rest
      // spread without `node` reading as unused (common react-markdown idiom).
      'no-unused-vars': ['error', { varsIgnorePattern: '^[A-Z_]', ignoreRestSiblings: true }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── Chrome extension (browser + WebExtensions APIs) ─────────────────────────
  {
    files: ['extension/**/*.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.browser,
        ...globals.webextensions,
      },
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },

  // ── Firebase messaging service worker (importScripts + firebase global) ─────
  {
    files: ['public/firebase-messaging-sw.js'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'script',
      globals: {
        ...globals.serviceworker,
        importScripts: 'readonly',
        firebase: 'readonly',
      },
    },
  },

  // ── MCP server + one-off Node scripts (CommonJS) ────────────────────────────
  {
    files: ['mcp-server/**/*.js', 'scripts/**/*.cjs'],
    extends: [js.configs.recommended],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      'no-unused-vars': ['warn', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      'no-empty': ['error', { allowEmptyCatch: true }],
    },
  },
])
