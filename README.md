# Bergschacht

This repo deploys all of Feuersteins CDK infrastructure. Deployments are done using GitHub Actions (CI) + CDK Pipelines (CD).

## Getting started

### Installing dependencies

To start developing simply install all the dependencies and get going. You can do that manually (by reviewing the `mise.toml` file) or use [`mise`](https://mise.jdx.dev/getting-started.html) for that. Simply download it and run the below commands.

```bash
mise trust
mise run install # This will install pnpm, pre-commit etc.
```

### Environment variables

Environment variables are generally only used to override the hardcoded values in `lib/constants.ts`, if desired they can be easily overwritten with `mise` as well.

To do that create a local `mise.local.toml` mise will handle the environment variables for you. This file is excluded from version control and is only for local development - all local env variables or secrets can be set there. See `mise.local.example.toml` for the formatting.

### Development

You can use `pnpm` to format, lint, build and test. Alternatively you can also use `mise` tasks which under will use `pnpm` under the hood.

```bash
# Note that in CI all of the below will run
pnpm run format
pnpm run lint:fix # or just lint to show the errors
pnpm run build
pnpm run watch # watch for changes and compile
pnpm run test

mise run pre-commit # will execute pre-commit (formatting/linting)
mise run test # will run pnpm run build & pnpm run test
```

Additionally you can run the CDK commands.

```bash
pnpm run cdk synth # emits the synthesized CloudFormation template
pnpm run cdk diff # compare deployed stack with current state
pnpm run cdk deploy # deploy to AWS
```

Or with mise, which will also run build, test, format etc.

```bash
mise run test-full # You can also pass a Stack name to see the CFN
mise run synth # will not run tests/lint/formatting, you can pass a Stack name to see the CFN
mise run synth # same as above but for diff, you can pass a Stack name to see the CFN
```

To see all available `mise` tasks run `mise run`.

> Note:
> `cdk diff` and `cdk deploy` requires permissions to the account. Since deployment for now goes through GitHub actions that wouldn't work. But if you have a ReadOnly permissions (or full permissions to the dev account) you can run these commands.

## Project Structure

- `lib/production-pipeline-stack.ts` - CDK Pipeline for production deployments (CICD -> Dev -> Prod)
- `lib/development-pipeline-stack.ts` - CDK Pipeline for development deployments (Dev only, feature branches)
- `lib/stages/cicd-stage.ts` - Stage containing CICD account infrastructure (KMS, ECR, Lambda Artifacts, etc.)
- `lib/stages/dev-stage.ts` - Stage containing Dev account infrastructure
- `lib/stages/prod-stage.ts` - Stage containing Prod account infrastructure
- `lib/readonly-role-stack.ts` - ReadOnly IAM role stack deployed to each account for monitoring and inspection
- `lib/shared-kms-key-stack.ts` - Shared KMS key stack for encrypting resources (ECR, S3, etc.) with cross-account access
- `lib/central-logging-bucket-stack.ts` - Centralized S3 bucket for storing access logs from other S3 buckets
- `lib/lambda-artifacts-stack.ts` - S3 bucket for storing Lambda deployment artifacts with cross-account access
- `lib/ecr-stack.ts` - ECR repository stack for container images with KMS encryption and cross-account pull access
- `lib/sns-pager-duty.ts` - SNS topic stack for PagerDuty alerts
- `lib/constants.ts` - Account mapping, GitHub connection, and other constants
- `bin/bergschacht-pipelines.ts` - CDK app entry point for CDK Pipelines
- `lib/github-oidc-provider-stack.ts` - GitHub OIDC provider stack to CI/CD account
- `lib/github-actions-stack.ts` - Give permissions to various GitHub actions

## Deployment Model

Deployments are handled by two CDK Pipelines which both live in the CI/CD account. At the same time GitHub actions run CI tasks like testing, linting etc.

### Production Pipeline (`ProductionPipelineStack`)

- **Triggered by**: Pushes to `master` branch only
- **Deployment stages**:
  1. **CICD Account** - Shared resources (KMS keys, ECR repository, Lambda artifacts bucket, central logging...)
  2. **Dev Account** - Development environment infrastructure
  3. **Prod Account** - Production environment infrastructure (requires manual approval)

### Development Pipeline (`DevelopmentPipelineStack`)

- **Triggered by**: Pushes to all branches starting with `dev-`, e.g. `dev-feature-login`
- **Deployment stages**:
  1. **Dev Account** - Development environment infrastructure only

**Important**: Any push to a `dev-*` branch will trigger a deployment to the Dev account.

This deployment model has a few issue:

- If two people work on different feature branches they're changes will overwrite each other on the Dev account. The only realistic solution is having separate accounts for each team.
- A deployment from the `master` will also reset the Dev account. A QA/Beta/Staging account should be added later to fix this problem.

### Initial Setup

In case CDK pipelines are not deployed or need to be redeployed

1. **Create a CodeStar Connection to GitHub**:
   - Go to AWS Console → CodePipeline → Settings → Connections
   - Create a new connection for GitHub
   - Complete the OAuth flow to authorize AWS access to your repository, make sure to install the app to not use your personal token
   - Copy the connection ARN to your `GITHUB_CONNECTION_ARN` environment variable or overwrite the value in `lib/constants.ts`

2. **Bootstrap all accounts**:

   ```bash
   # Bootstrap the CICD account (where pipelines will run)
   cdk bootstrap aws://<cicd-account-id>/<region>

   # Bootstrap Dev and Prod accounts with trust to CICD account
   cdk bootstrap aws://<dev-account-id>/<region> --trust <cicd-account-id> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
   cdk bootstrap aws://<prod-account-id>/<region> --trust <cicd-account-id> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
   ```

3. **Deploy the pipeline stacks manually (first time only)**:
   ```bash
   cdk deploy ProductionPipeline DevelopmentPipeline
   ```

After initial deployment, the pipelines are self-mutating and will update themselves when you push changes to the pipeline code.

## Stacks

### GitHubOIDCProviderCicd

This stack creates the GitHub OIDC provider in the CI/CD account:

This needs to be deployed only once to the CI/CD account, then `GitHubActionsStack` instances deploy roles that allow GitHub actions to assume roles and perform various actions. The OIDC provider is then shared across all GitHub Actions roles in that account.

### GitHubActions

This stack gives GitHub actions (a specific repo) permissions in the CI/CD account:

- Creates IAM roles that trust the GitHub OIDC provider
- Configures trust policies to restrict access to specific GitHub repositories and environments
- Configures necessary permissions for CDK deployments in other accounts

The stack uses the `githubEnvironment` property to specify which GitHub environment can assume the role. For example:

- `githubEnvironment: 'prod'` creates a role that can only be assumed from the `prod` environment
- `githubEnvironment: 'dev'` creates a role that can only be assumed from the `dev` environment

You can also attach custom IAM permissions using the `additionalPolicies` property. This is useful for granting specific permissions like ECR push access without needing deployment permissions to other accounts.

### ProductionPipelineStack

This stack creates the CDK Pipeline for production deployments:

- Creates a CodePipeline V2 pipeline with CdeConnecotions GitHub connection
- Deploys to CICD -> Dev -> Prod accounts in sequence
- Includes manual approval step before Prod deployment
- Self-mutating: pipeline updates itself when pipeline code changes

### DevelopmentPipelineStack

This stack creates the CDK Pipeline for development/feature branch deployments:

- Creates a CodePipeline V2 pipeline with CdeConnecotions GitHub connection
- Deploys only to Dev account
- Triggered by feature branch pushes (not master)
- Allows parallel testing of feature branches in Dev environment

### ReadOnlyRole

This stack creates a read-only IAM role in each account (CI/CD, Dev, Prod) that can be assumed by the CI/CD account:

- Creates an IAM role with AWS managed `ReadOnlyAccess` policy
- Allows specified ARNs to assume the role for monitoring and inspection

### SharedKmsKeyStack

This stack creates a shared KMS key for encrypting resources across accounts:

- Creates a KMS key with automatic key rotation enabled
- Optionally grants decrypt permissions to specified AWS accounts for cross-account access
- Optionally creates a key alias for easier reference (e.g., `alias/cicd-deployment-resources`)
- Exports key ID, ARN, and alias name as CloudFormation outputs
- Used for encrypting ECR images, S3 buckets (Lambda artifacts, logging), and other AWS resources in CI/CD account

### CentralLoggingBucketStack

This stack creates a centralized S3 bucket for storing logs:

- Creates an S3 bucket with KMS encryption
- Sets lifecycle rules to transition logs immediately to Glacier Instant Retrieval and delete after 90 days
- Grants account where stack is deployed access to write logs to the bucket
- Does not enable server access logging on the logging bucket itself (to avoid infinite loop)

### LambdaArtifactsStack

This stack creates an S3 bucket for storing Lambda deployment artifacts:

- Creates a versioned S3 bucket with KMS encryption using a shared KMS key
- Optionally grants cross-account read permissions to specified AWS accounts
- Optionally configures server access logging to a central logging bucket
- Sets lifecycle rules to delete old versions after 90 days and abort incomplete multipart uploads after 7 days
- Used by deployment workflows to store and distribute Lambda function code

### EcrStack

This stack creates an ECR repository for storing container images:

- Creates an ECR repository with image scanning enabled on push
- Configures KMS encryption using a shared KMS key
- Configures immutable image tags by default
- Optionally allows mutable tags matching a wildcard pattern (e.g., `*latest`) via `mutableTagWildcard` parameter
- Sets up lifecycle rules to keep only the last 10 images
- Optionally grants cross-account pull permissions to specified AWS accounts
- Optionally sends SNS notifications when image scans detect CRITICAL or HIGH severity vulnerabilities via EventBridge rules
