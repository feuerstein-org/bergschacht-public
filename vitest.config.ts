import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    include: ['test/**/*.test.ts'],
    coverage: {
      provider: 'v8',
      include: ['lib/**/*.ts', 'bin/**/*.ts'],
      // Excluded from coverage: CDK app entry + pipeline-wiring stacks are
      // integration-level (exercised by `cdk synth`, not unit tests), and the
      // schema files are static data definitions with no branching logic.
      exclude: [
        'bin/**',
        'lib/bergschacht-stack.ts',
        'lib/infrastructure/schemas/**',
        'lib/pipeline/cicd-stage.ts',
        'lib/pipeline/environment-stage.ts',
        'lib/pipeline/*-pipeline-stack.ts',
        'lib/pipeline/*-deployment-stage.ts',
      ],
      thresholds: {
        lines: 80,
        functions: 80,
        branches: 80,
        statements: 80,
      },
    },
  },
});
