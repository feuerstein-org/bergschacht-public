# Bergschacht

CDK infrastructure for Feuerstein. Application packages live in separate repositories and deploy their artifacts (Docker images, Lambda packages) to AWS. After deployment, they send a `repository_dispatch` event to this repo, which updates the version manifest and triggers a CDK deployment. This documentation describes how the application code is deployed as well.

## Architecture

```
┌─────────────────────────┐     ┌─────────────────────────┐
│    Application Repo     │     │    Application Repo     │
│    (myapp-repo, etc)    │     │    (other apps...)      │
└───────────┬─────────────┘     └───────────┬─────────────┘
            │                               │
            │ 1. Deploy Docker/Lambda       │
            │ 2. repository_dispatch        │
            │                               │
            ▼                               ▼
┌─────────────────────────────────────────────────────────┐
│                  Bergschacht (CDK Repo)                 │
│                                                         │
│  update-manifest.yml                                    │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 1. Run update_version_manifest.py (version check)│   │
│  │ 2. Commit updated latest.json                    │   │
│  └──────────────────┬───────────────────────────────┘   │
│                     │ push to master                    │
│                     ▼                                   │
│  deploy.yml                                             │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Trigger CDK Pipeline                             │   │
│  └──────────────────────────────────────────────────┘   │
└─────────────────────────────────────────────────────────┘
```

## Project Structure

```
bergschacht/
├── package.json              # Dependencies and scripts
├── tsconfig.json             # TypeScript config
├── cdk.json                  # CDK app config
├── jest.config.js            # Jest test config
├── eslint.config.mjs         # ESLint config
├── mise.toml                 # Development tasks
├── mise.ci.toml              # CI-specific tasks
├── bin/                      # CDK app entry point
├── lib/                      # Stack definitions
├── test/                     # Infrastructure tests
├── version-manifests/        # Version manifests
│   ├── latest.json           # Current deployed versions
│   └── version-manifest.schema.json
└── .github/
    ├── scripts/
    │   └── update_version_manifest.py  # Updates manifest with version check
    └── workflows/
        ├── test.yml              # PR testing workflow
        ├── deploy.yml            # Triggers CDK pipeline on push to master
        └── update-manifest.yml   # Receives dispatch events from app repos
```

## Getting started

### Installing dependencies

To start developing simply install all the dependencies and get going. You can do that manually (by reviewing the `mise.toml` file) or use [`mise`](https://mise.jdx.dev/getting-started.html) for that. Simply download it and run the below commands.

```bash
mise trust
mise run install # This will install pnpm, pre-commit etc.
```

### Environment variables

CDK Environment variables are generally hardcoded in `lib/constants.ts`. Package variables during deployment are set within the package itself or overwritten via CDK, you can find them inside the specific packages directory. If desired they can be easily overwritten with `mise` as well.

To do that create a local `mise.local.toml` file. Mise will handle the environment variables for you. This file is excluded from version control and is only for local development - all local env variables or secrets can be set there. See `mise.local.example.toml` for the formatting.

### Development with CDK

You can use `pnpm` to format, lint, build and test. Alternatively you can also use `mise` tasks which under will use `pnpm` under the hood.

```bash
mise run pre-commit    # Run pre-commit (formatting/linting)
mise run build         # Build CDK
mise run test          # Build & run tests
mise run test-full     # Build, test, pre-commit & synth
mise run synth         # Build & synthesize stacks
mise run diff          # Show diff for stacks
mise run deploy        # Deploy to AWS

# Or use pnpm directly
pnpm run build
pnpm run test
pnpm run cdk synth
pnpm run cdk diff
pnpm run cdk deploy
```

To see all available `mise` tasks run `mise run`.

> Note:
> `cdk diff` and `cdk deploy` require permissions to the account. You need at least ReadOnly permissions for `diff` and deployment permissions for `deploy`.

### Adding a New Application Repository

1. Create a Personal Access Token (PAT) that can trigger workflows on this repo
2. Create a new `prod` environment in the repository.
3. Add the PAT as secret `CDK_REPO_PAT` in the new repo
4. Configure remaining GitHub environment variables in the environment:

| Variable                | Description                        |
| ----------------------- | ---------------------------------- |
| `CICD_ACCOUNT_ID`       | AWS account ID for CI/CD resources |
| `AWS_REGION`            | AWS region (e.g., `us-east-1`)     |
| `ECR_REPOSITORY_NAME`   | ECR repository name                |
| `LAMBDA_S3_BUCKET_NAME` | S3 bucket for Lambda artifacts     |
| `CDK_REPO_OWNER`        | GitHub owner of the CDK repo       |
| `CDK_REPO_NAME`         | Name of the CDK repo               |

4. Build the application, use the `sample-python-repo` repo as the template.
5. Give your new repository permissions to push to S3/ECR by updating the IAM permissions in this repo. This is done by updating the `constants.ts` file.
6. Deploy your application using CDK. See below for usage in CDK stacks.

#### Artifact Configuration

Each workspace member package can produce **multiple named artifacts** - Docker images, Lambda packages, or a mix. Configure them in each package's `pyproject.toml` under `[tool.bergschacht.artifacts.<name>]`:

**Single Docker image (simplest case)**

```toml
[tool.bergschacht.artifacts.my-app]
type = "docker"
```

**Single Lambda**

```toml
[tool.bergschacht.artifacts.my-app]
type = "lambda"
```

**Docker Image and Lambda using the same artifact name**

```toml
[tool.bergschacht.artifacts.sample-python-repo]
type = ["docker", "lambda"]
```

The `type` field can be:

- A single string: `type = "docker"`
- A list of types: `type = ["docker", "lambda"]`

When multiple types are specified, separate artifacts are created for each type, all using the same artifact name.

**Multiple artifacts from one package**

```toml
[tool.bergschacht.artifacts.worker]
type = "docker"
dockerfile = "Dockerfile.worker"   # optional, defaults to Dockerfile

[tool.bergschacht.artifacts.api]
type = "docker"
dockerfile = "Dockerfile.api"

[tool.bergschacht.artifacts.webhook]
type = "lambda"
```

Each artifact name becomes a key in the version manifest and is used for the image tag / S3 key.

#### uv Workspace Support

Application repos support [uv workspaces](https://docs.astral.sh/uv/concepts/workspaces/) for monorepos with multiple independently versioned packages.

**Workspace layout:**

```
my-etl-monorepo/
├── pyproject.toml              # workspace root
├── packages/
│   ├── etl-users/
│   │   ├── pyproject.toml      # version = "1.2.0"
│   │   ├── Dockerfile
│   │   └── src/etl_users/
│   ├── etl-orders/
│   │   ├── pyproject.toml      # version = "0.5.0"
│   │   ├── Dockerfile
│   │   └── src/etl_orders/
│   └── etl-payments/
│       ├── pyproject.toml      # version = "3.1.0"
│       └── src/etl_payments/
└── .github/
    ├── scripts/extract_config.py
    └── workflows/deploy.yml
```

**Root `pyproject.toml`:**

```toml
[project]
name = "my-etl-monorepo"
version = "0.0.0"  # workspace root version is unused

[tool.uv.workspace]
members = ["packages/*"]
```

**Member `packages/etl-users/pyproject.toml`:**

```toml
[project]
name = "etl-users"
version = "1.2.0"
dependencies = ["pandas>=2.0.0"]

[tool.bergschacht.artifacts.etl-users]
type = "docker"
```

The deploy workflow automatically:

1. Discovers all workspace members via `[tool.uv.workspace.members]` globs
2. Compares each member's version against the previous commit
3. Deploys only packages whose version was bumped
4. Creates per-package tags (e.g., `etl-users/v1.2.0`)
5. Each artifact carries its own version in the manifest payload

For non-workspace repos (single `pyproject.toml` at root), everything works the same - the script treats the root as the only package.

### Version Management

Application versions are tracked in `version-manifests/latest.json`.

### How it works

1. **Application repos** build and push Docker images / Lambda packages to AWS
2. They send a `repository_dispatch` event to this repo with deployment metadata (each artifact includes its own version)
3. The `update-manifest.yml` workflow runs `update_version_manifest.py`, which only updates the manifest if the version is newer than the existing one
4. The manifest commit triggers `deploy.yml`, which starts the **CDK pipeline**

> If an artifact was deleted from AWS you can redeploy it simply by rerunning an old workflow inside the application repo to redeploy the artifact for said version.

### Rollback

- **Specific artifact**: Revert the version manifest commit or make a new commit to the version manifest.
- **CDK stage**: Revert to a specific execution ID in CodePipeline or revert to a previous commit in this repo.

### Version Manifest Structure

```json
{
  "$schema": "./version-manifest.schema.json",
  "schemaVersion": "1.0.0",
  "repositories": {
    "sample-python-repo": {
      "source": "feuerstein/sample-python-repo",
      "images": {
        "sample-python-repo": {
          "repository": "123456789.dkr.ecr.us-east-1.amazonaws.com/feuerstein",
          "imageTag": "sample-python-repo-0.1.0",
          "version": "0.1.0",
          "commitSha": "abc123..."
        }
      },
      "lambdas": {
        "sample-python-repo": {
          "bucket": "example-lambda-artifacts",
          "key": "sample-python-repo/sample-python-repo-0.1.0.zip",
          "version": "0.1.0",
          "commitSha": "abc123..."
        }
      }
    }
  }
}
```

**Lambda Deployment**

| Field       | Description                                             |
| ----------- | ------------------------------------------------------- |
| `bucket`    | S3 bucket containing the artifact                       |
| `key`       | S3 object key (path to zip file)                        |
| `version`   | Semantic version of the package                         |
| `commitSha` | Git commit SHA that produced this artifact (7-40 chars) |

**Container Image Deployment**

| Field        | Description                                          |
| ------------ | ---------------------------------------------------- |
| `repository` | Full ECR repository URI                              |
| `imageTag`   | Docker image tag                                     |
| `version`    | Semantic version of the package                      |
| `commitSha`  | Git commit SHA that produced this image (7-40 chars) |

### Usage in CDK Stacks

```typescript
import {
  getLambdaArtifact,
  getImageArtifact,
  getRepositoryDeploymentTypes,
} from '../lib/version-manifest';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

// Get Lambda package configuration. Pass repo and artifact name.
const lambdaConfig = getLambdaArtifact('order-processor', 'order-processor');

new lambda.Function(this, 'OrderProcessor', {
  code: lambda.Code.fromBucket(
    s3.Bucket.fromBucketName(this, 'Bucket', lambdaConfig.bucket),
    lambdaConfig.key
  ),
  // ... other configuration
});

const lambdaConfig = getImageArtifact('order-processor', 'order-processor');
// Use imageConfig.repository and imageConfig.imageTag

// Multi-artifact repo: get specific named artifacts
const workerImage = getImageArtifact('order-service', 'worker');
const apiImage = getImageArtifact('order-service', 'api');
const webhookLambda = getLambdaArtifact('order-service', 'webhook');

// Check deployment types for a repository
const types = getRepositoryDeploymentTypes('dual-deploy-service');
// Returns: ['lambda', 'image']
```

## Deployment Model

Deployments are handled by two CDK Pipelines which both live in the CI/CD account. At the same time GitHub actions run CI tasks like testing, linting etc.

### Environment Variables & Secrets

These are the required environment variables that GitHub Actions require to trigger the Production CDK pipeline:

| Variable                 | Description                        |
| ------------------------ | ---------------------------------- |
| `CICD_ACCOUNT_ID`        | AWS account ID for CI/CD resources |
| `AWS_REGION`             | AWS region for deployments         |
| `PROD_CDK_PIPELINE_NAME` | Production CDK Pipeline name       |

AWS authentication uses OIDC via the `aws-actions/configure-aws-credentials` action, assuming a role: `{repo}-prod-github-actions-role`.

### Production Pipeline (`ProductionPipelineStack`)

- **Triggered by**: GithubAction triggered on push to `master` branch.
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

- If two people work on different feature branches their changes will overwrite each other on the Dev account. The only realistic solution is having separate accounts for each team.
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

### GitHubOIDCProvider

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

- Creates a CodePipeline V2 pipeline with CodeConnections GitHub connection
- Deploys to CICD -> Dev -> Prod accounts in sequence
- Includes manual approval step before Prod deployment
- Self-mutating: pipeline updates itself when pipeline code changes

### DevelopmentPipelineStack

This stack creates the CDK Pipeline for development/feature branch deployments:

- Creates a CodePipeline V2 pipeline with CodeConnections GitHub connection
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
