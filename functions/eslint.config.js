// Flat ESLint config for Firebase Cloud Functions (Node.js, CommonJS).
// Overrides the React-oriented root config in the project's eslint.config.js.
const globals = require("globals");

module.exports = [
  {
    ignores: ["node_modules/", "lib/", "scripts/"],
  },
  {
    files: ["**/*.js", "**/*.cjs"],
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: "commonjs",
      globals: {
        ...globals.node,
      },
    },
    rules: {
      "no-unused-vars": ["warn", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },
];
