// eslint.config.mjs
import { defineConfig } from 'eslint/config';
import tseslint from 'typescript-eslint';
import cdkPlugin from 'eslint-plugin-awscdk';
import jsdoc from 'eslint-plugin-jsdoc';

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    ...cdkPlugin.configs.strict,
    files: ['lib/**/*.ts', 'bin/*.ts', 'test/**/*.ts'],
    ignores: ['**/*.d.ts'],
    plugins: {
      ...cdkPlugin.configs.strict.plugins,
      jsdoc,
    },
    rules: {
      ...cdkPlugin.configs.strict.rules,
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
        },
      ],
      // awscdk/require-jsdoc already enforces JSDoc for Construct properties
      // This adds enforcement for class declarations (CDK Stacks)
      'jsdoc/require-jsdoc': [
        'error',
        {
          require: {
            ClassDeclaration: true,
          },
        },
      ],
    },
  },
]);
