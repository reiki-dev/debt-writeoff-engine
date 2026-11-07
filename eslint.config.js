'use strict';

const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  {
    ignores: ['node_modules/**', 'coverage/**', 'audit/**', 'public/index.html'],
  },
  {
    ...js.configs.recommended,
    files: ['**/*.js'],
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'commonjs',
      globals: globals.node,
    },
    rules: {
      // Non-breaking spaces are intentional inside regexes that normalize exports.
      'no-irregular-whitespace': ['error', { skipRegExps: true }],
    },
  },
  {
    files: ['public/**/*.js'],
    languageOptions: {
      globals: { ...globals.browser, module: 'readonly' },
    },
  },
];
