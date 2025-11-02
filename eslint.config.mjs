// eslint.config.mjs
import { defineConfig } from "eslint/config";
import tseslint from "typescript-eslint";
import cdkPlugin from "eslint-plugin-awscdk";

export default defineConfig([
  ...tseslint.configs.recommended,
  {
    ...cdkPlugin.configs.strict,
    files: ["lib/**/*.ts", "bin/*.ts", "test/**/*.ts"],
    ignores: ["**/*.d.ts"],
    rules: {
      ...cdkPlugin.configs.strict.rules,
      '@typescript-eslint/no-unused-vars': ['error', { 
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_'
      }]
    }
  },
]);