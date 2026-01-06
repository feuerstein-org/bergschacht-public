# Bergschacht

This Monorepo deploys all of Feuersteins infrastructure and package code. Deployments are done using GitHub Actions (CI) + CDK Pipelines (CD). Packages live in the `packages` directory and CDK code lives in `cdk` directory.

## Project Structure

```
bergschacht/
├── package.json                             # JS Workspace config
├── uv.lock                                  # Python dependency lock
├── pnpm-lock.yaml                           # JS dependency lock
├── pyproject.toml                           # Root config for python tooling
├── .prettierrc.json                         # Prettier config
├── mise.toml                                # Development tasks (install, lint, test)
├── mise.ci.toml                             # CI-specific tasks
├── ...                                      # Various other configs...
├── version-manifests/                       # Version manifests dictate what versions get deployed
│   ├── latest.json                          # Latest deployed versions
│   └── version-manifest.schema.json         # Latest deployed versions
├── .github/workflows/
│   ├── test.yml                             # PR testing workflow
│   └── deploy.yml                           # Production deployment workflow
├── cdk/                                     # CDK infrastructure
│   ├── package.json                         # CDK specific dependencies
│   ├── cdk.json                             # CDK app config
│   ├── tsconfig.json                        # TypeScript config
│   ├── jest.config.js                       # Jest test config
│   ├── eslint.config.mjs                    # ESLint config
│   ├── bin/                                 # CDK app entry point
│   ├── lib/                                 # Stack definitions
│   └── test/                                # Infrastructure tests
└── packages/
    └── <package_name>/
        ├── pyproject.toml                   # Runtime dependencies + deployment config
        ├── Dockerfile                       # Container definition (for Docker deployments)
        ├── README.md                        # Package documentation
        └── src/                             # Source code
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
mise run pre-commit # Will execute pre-commit (formatting/linting)
mise run cdk-build # Will build the CDK
mise run cdk-test # Will run pnpm run build & pnpm run test
mise run cdk-synth <stack> # Build & Synth, optionally supply Stack name
mise run cdk-test-full <stack> # Build, Test & Synth, optionally supply Stack name
mise run cdk-deploy <stack> # Deploy to AWS, optionally supply Stack name

# Or use pnpm commands directly
cd cdk # Otherwise commands will run on all packages not just CDK
pnpm run build
pnpm run watch # watch for changes and compile
pnpm run test
pnpm run cdk synth
pnpm run cdk diff
pnpm run cdk deploy
```

To see all available `mise` tasks run `mise run`.

> Note:
> `cdk diff` and `cdk deploy` require permissions to the account. You need at least ReadOnly permissions for `diff` and deployment permissions for `deploy`.

### Development with Python Packages

Python packages live in the `packages/` directory. Each package uses [uv workspaces](https://docs.astral.sh/uv/concepts/workspaces/):

- **Root `pyproject.toml`**: Contains **dev dependencies only** (pytest, ruff, pyright, etc.)
- **Package `pyproject.toml`**: Contains **runtime dependencies** for that specific package

This separation is required for Docker builds to include only required dependencies for each package. Instead of all dependencies from all packages.

```bash
mise run pre-commit       # Run Pre-commit
mise run py-lint          # Show linting issues
mise run py-lint-fix      # Auto-fix linting issues
mise run py-test sample_etl   # Run tests for specific package
```

There is a `sample_etl` package that showcases a sample package.

#### Deployment Types

Each package can be deployed as a **Docker container**, a **Lambda function**, or **both**. Configure this in the package's `pyproject.toml`:

**Docker Only (default)**

```toml
[tool.bergschacht]
deploy_types = ["docker"]
```

**Lambda Only**

```toml
[tool.bergschacht]
deploy_types = ["lambda"]
lambda_function_name = "my-lambda-function"
```

**Both Docker and Lambda**

```toml
[tool.bergschacht]
deploy_types = ["docker", "lambda"]
lambda_function_name = "my-lambda-function"
```

#### Adding a New Python Package

1. Create a new directory under `packages/`
2. Add a `pyproject.toml` with runtime dependencies
3. Add deployment configuration in `[tool.bergschacht]`:
   - For Docker: Add a `Dockerfile` for containerization (see note below)
   - For Lambda: Specify `lambda_function_name` (the Lambda function must be created and configured via CDK in `cdk/lib/`)

The deployment workflow will automatically detect the deployment type and handle the build/deploy accordingly.

**Important for Docker deployments**: Since this is a uv workspace, Dockerfiles must be written to build from the **workspace root** context. Your Dockerfile should:

```dockerfile
# Copy workspace root files (pyproject.toml defines workspace, uv.lock has all dependencies)
COPY pyproject.toml uv.lock ./

# Copy your specific package
COPY packages/your-package/ ./packages/your-package/

# Build with --package flag
RUN uv build --package your-package --wheel --out-dir /wheels
```

When building locally, run from the workspace root:

```bash
docker build -f packages/your-package/Dockerfile -t your-package .
```

## Version Management

Application versions (Lambda & Docker images) are managed through the version manifest which is stored in the `version-manifest/` directory. To rollback you can simply revert back to a good commit. To revert a specific stage in the CDK pipeline you can revert to a specific execution Id in the pipeline itself.

### Version Manifest Structure

Each package can have one or more deployment types (lambda, image, or both):

```json
{
  "$schema": "./version-manifest.schema.json",
  "schemaVersion": "1.0.0",
  "packages": {
    "my-lambda": {
      "lambda": {
        "bucket": "my-artifacts-bucket",
        "key": "lambdas/my-lambda/v1.0.0.zip",
        "version": "1.0.0",
        "commitSha": "abc1234"
      }
    },
    "my-service": {
      "image": {
        "repository": "123456789012.dkr.ecr.us-east-1.amazonaws.com/my-service",
        "imageTag": "v2.0.0",
        "version": "2.0.0",
        "commitSha": "def5678"
      }
    },
    "dual-deploy-service": {
      "lambda": {
        "bucket": "my-artifacts-bucket",
        "key": "lambdas/dual-deploy-service/v1.0.0.zip",
        "version": "1.0.0",
        "commitSha": "abc1234"
      },
      "image": {
        "repository": "123456789012.dkr.ecr.us-east-1.amazonaws.com/dual-deploy-service",
        "imageTag": "v1.0.0",
        "version": "1.0.0",
        "commitSha": "abc1234"
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
  getLambdaPackage,
  getImagePackage,
  getPackageDeploymentTypes,
} from '../lib/version-manifest';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

// Get Lambda package configuration
const lambdaConfig = getLambdaPackage('order-processor');

new lambda.Function(this, 'OrderProcessor', {
  code: lambda.Code.fromBucket(
    s3.Bucket.fromBucketName(this, 'Bucket', lambdaConfig.bucket),
    lambdaConfig.key
  ),
  // ... other configuration
});

// Get container image configuration
const imageConfig = getImagePackage('payment-service');
// Use imageConfig.repository and imageConfig.imageTag

// For packages with both deployment types
const dualDeployTypes = getPackageDeploymentTypes('dual-deploy-service');
// Returns: ['lambda', 'image']
const dualLambdaConfig = getLambdaPackage('dual-deploy-service');
const dualImageConfig = getImagePackage('dual-deploy-service');
```

### Updating Versions

A workflow will automatically publish a new version after a package is updated and the new commit is merged to master but you can do it manually as well if something specific needs to be overridden.

```bash
# Update latest.json with new Lambda version (use jq or edit manually)
jq '.packages["my-lambda"].lambda = {
  "bucket": "my-artifacts-bucket",
  "key": "lambdas/my-lambda/v1.1.0.zip",
  "version": "1.1.0",
  "commitSha": "newsha123"
}' version-manifests/latest.json > tmp.json && mv tmp.json version-manifests/latest.json

# Commit and push
git add version-manifests/latest.json
git commit -m "chore: bump my-lambda to v1.1.0"
git push
```

Schema validation is done as part of pre-commit. Simply run `mise run pre-commit`.

**Note**:

- In the future we should have specific overrides per region/stage/account etc. This might be done via a separate `version-manifest` service or maybe a separate repo.

## GitHub Actions CI/CD

GitHub Actions handles the continuous integration and artifact deployment pipeline. The workflows live in `.github/workflows/` and are supported by Python scripts in `.github/scripts/`.

### Workflows

#### Test Workflow (`test.yml`)

Runs on every pull request and push to `master`:

1. **Pre-commit** - Runs formatting and linting checks
2. **Test** - Runs Python tests, builds CDK, runs CDK tests, and performs `cdk diff`

#### Deploy Workflow (`deploy.yml`)

Runs only on push to `master` and handles the full deployment pipeline:

```
┌─────────────────┐     ┌─────────────┐     ┌───────────────┐     ┌─────────────────┐     ┌────────────┐
│ detect-changes  │---->│ create-tags │---->│ deploy-docker │---->│ commit-manifest │---->│ deploy-cdk │
│                 │     │             │     │ deploy-lambda │     │                 │     │            │
└─────────────────┘     └─────────────┘     └───────────────┘     └─────────────────┘     └────────────┘
```

### Change Detection

The workflow automatically detects which packages have changed using [dorny/paths-filter](https://github.com/dorny/paths-filter):

Only packages with actual file changes are built and deployed.

### Helper Scripts

Located in `.github/scripts/`:

| Script                       | Purpose                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------- |
| `categorize_packages.py`     | Reads `pyproject.toml` for each changed package and categorizes them by deployment type (docker/lambda) |
| `extract_config.py`          | Extracts version and deployment config from a single package's `pyproject.toml`                         |
| `update_version_manifest.py` | Updates `version-manifests/latest.json` with newly deployed package versions                            |

### Deployment Flow

#### 1. Create Tags (`create-tags` job)

For each changed package, creates a git tag in the format `{package}-v{version}`:

- If the tag already exists on the current commit -> proceeds (allows re-deployment, this is needed if this version was deleted from AWS)
- If the tag exists on a different commit -> fails (version must be bumped)
- If the tag doesn't exist → creates and pushes the new tag

#### 2. Build & Push Artifacts

**Docker Packages (`deploy-docker` job)**:

- Checks if image already exists in ECR (skips build if so)
- Builds Docker image from `packages/{package}/Dockerfile`
- Pushes to ECR with tag: `{repo}-{package}-{version}`
- Creates deployment metadata artifact

**Lambda Packages (`deploy-lambda` job)**:

- Checks if zip already exists in S3 (skips build if so)
- Uses `uv pip install --target` to create a deployment package
- Uploads zip to S3: `s3://{bucket}/{repo}/{package}/{package}.zip`
- Creates deployment metadata artifact

Jobs run in parallel via matrix

#### 3. Update Version Manifest (`commit-manifest` job)

After successful deployments:

1. Downloads all deployment metadata artifacts
2. Runs `update_version_manifest.py` for each artifact
3. The script performs version comparison - only updates if the new version is higher
4. Commits changes to `version-manifests/latest.json` with `[skip ci]` to prevent infinite loops
5. Uses retry logic with rebase for concurrent updates

The commit is made by `github-actions[bot]`:

```
chore: update package versions [skip ci]
```

#### 4. Trigger CDK Pipeline (`deploy-cdk` job)

Finally, triggers the AWS CodePipeline to deploy infrastructure:

```bash
aws codepipeline start-pipeline-execution --name BergschachtProductionPipeline
```

The CDK pipeline reads `version-manifests/latest.json` to determine which artifact versions to deploy.

### Environment Variables & Secrets

The workflow uses GitHub environment variables:

| Variable                 | Description                        |
| ------------------------ | ---------------------------------- |
| `CICD_ACCOUNT_ID`        | AWS account ID for CI/CD resources |
| `AWS_REGION`             | AWS region for deployments         |
| `LAMBDA_S3_BUCKET_NAME`  | S3 bucket for Lambda artifacts     |
| `ECR_REPOSITORY_NAME`    | ECR Repository name for images     |
| `PROD_CDK_PIPELINE_NAME` | Production CDK Pipeline name       |

AWS authentication uses OIDC via the `aws-actions/configure-aws-credentials` action, assuming a role: `{repo}-prod-github-actions-role`.

## Deployment Model

Deployments are handled by two CDK Pipelines which both live in the CI/CD account. At the same time GitHub actions run CI tasks like testing, linting etc.

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

## Packages

| Package      | Description                           | Deploy Type     |
| ------------ | ------------------------------------- | --------------- |
| `sample_etl` | Sample ETL pipeline for demonstration | Docker & Lambda |
