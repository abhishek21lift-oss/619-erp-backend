const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    languageOptions: {
      ecmaVersion: 2022,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
        ...globals.jest,
      },
    },
    rules: {
      'no-console': ['warn', { allow: ['warn', 'error'] }],
      'no-unused-vars': ['warn', {
        argsIgnorePattern: '^_',
        ignoreRestSiblings: true,
        caughtErrorsIgnorePattern: '^_',
      }],
      'no-constant-condition': ['warn', { checkLoops: false }],
      'prefer-const': 'warn',
      'no-var': 'warn',
      'eqeqeq': ['warn', 'always', { null: 'ignore' }],
    },
  },
  {
    files: ['src/__tests__/**/*.test.js'],
    languageOptions: {
      sourceType: 'module',
    },
  },
  {
    files: ['scripts/**/*.js', 'src/db/migrate.js', 'src/db/seed.js'],
    rules: {
      'no-console': 'off',
    },
  },
  {
    ignores: ['node_modules/', 'coverage/', 'uploads/'],
  },
];
