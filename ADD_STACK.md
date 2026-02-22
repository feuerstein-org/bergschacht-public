# Adding a New CDK Stack

Quick reference for adding a new infrastructure stack to this project.

## Project layout

| Path                                | Purpose                                                                                                                                  |
| ----------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `lib/infrastructure/`               | Stack implementations (one file per stack)                                                                                               |
| `lib/pipeline/environment-stage.ts` | **EnvironmentStage** – app workload stacks deployed per environment (dev / prod). Add stacks here that change with every app deployment. |
| `lib/pipeline/cicd-stage.ts`        | **CicdStage** – shared infra stacks (KMS, ECR, OIDC, logging). Add stacks here that are deployed once in the CI/CD account.              |
| `lib/config/constants.ts`           | Account IDs, region, SSM prefix, application repo list                                                                                   |
| `test/infrastructure/`              | Jest tests for infrastructure stacks                                                                                                     |
| `test/pipeline/`                    | Jest tests for pipeline stacks                                                                                                           |

## Step-by-step

### 1. Create the stack file

Create `lib/infrastructure/<name>-stack.ts`. Follow the established pattern:

```ts
import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';

export interface MyNewStackProps extends cdk.StackProps {
  readonly myParam: string;
}

export class MyNewStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: MyNewStackProps) {
    super(scope, id, props);
    // resources …
  }
}
```

Key conventions:

- **Props interface** extends `cdk.StackProps`, all fields `readonly`.
- **JSDoc** on every prop with `@example`.
- Expose important constructs as `public readonly` class members.
- Add `CfnOutput` entries for ARNs / names consumers need.
- Use `NagSuppressions` from `cdk-nag` when a suppression is justified (with a reason string).

### 2. Register the stack in a stage

Open the appropriate stage file and instantiate the stack.

**EnvironmentStage** (per-environment workloads):

```ts
// lib/pipeline/environment-stage.ts
import { MyNewStack } from '../infrastructure/my-new-stack';

// inside the constructor:
new MyNewStack(this, 'MyNew', {
  myParam: 'value',
  env: { account: props.accountId, region: props.awsRegion },
});
```

**CicdStage** (shared infra, CI/CD account only):

```ts
// lib/pipeline/cicd-stage.ts
import { MyNewStack } from '../infrastructure/my-new-stack';

// inside the constructor:
new MyNewStack(this, 'MyNew', {
  myParam: 'value',
  env: { account: cicdAccountId, region: awsRegion },
});
```

Always pass `env` so the stack is account/region-aware.

### 3. Add tests

Create `test/infrastructure/<name>-stack.test.ts`. Use `Template.fromStack()` from `aws-cdk-lib/assertions`:

```ts
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { MyNewStack } from '../../lib/infrastructure/my-new-stack';

describe('MyNewStack', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new MyNewStack(app, 'Test', { myParam: 'test' });
    template = Template.fromStack(stack);
  });

  test('creates the expected resource', () => {
    template.hasResourceProperties('AWS::Service::Resource', {
      PropertyName: 'test',
    });
  });
});
```

What to test:

- Resource existence and properties (`hasResourceProperties`)
- Resource counts (`resourceCountIs`)
- Outputs (`hasOutput`)
- Dependency ordering when relevant (`DependsOn` in `template.toJSON().Resources`)

### 4. Build & verify

```bash
pnpm run build          # compile TypeScript
pnpm run test           # run Jest tests
pnpm run cdk synth      # synthesise CloudFormation templates
```

Or using `mise`:

```bash
mise run test-full      # build + test + lint + synth
```

## Conventions & gotchas

- **cdk-nag**: `AwsSolutionsChecks` is applied at the stage level. Every resource is validated. Add `NagSuppressions` with a reason when a rule doesn't apply.
- **No `env` = no account-aware lookups**: always pass `env` when instantiating stacks inside stages.
- **Constants**: hardcoded account IDs and region live in `lib/config/constants.ts`. Reference them—don't duplicate.
- **Naming**: stack files use kebab-case (`my-new-stack.ts`), classes use PascalCase (`MyNewStack`), construct IDs use PascalCase (`'MyNew'`).
- **Compiled JS**: `tsc` emits `.js` and `.d.ts` alongside `.ts` files. These are committed. Run `pnpm run build` before committing.
