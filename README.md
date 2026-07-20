# Bergschacht

CDK infrastructure for Feuerstein. Application packages live in separate repositories and deploy their artifacts (Docker images, Lambda packages) to AWS. After deployment, they commit an update to the version manifest (`version-manifests/latest.json`) in this repo, which triggers the CDK production pipeline. A git commit of this repo therefore fully determines the deployed artifact set - pinning and rollback are plain git operations. This documentation describes how the application code is deployed as well.

## Architecture

```
┌─────────────────────────┐     ┌─────────────────────────┐
│    Application Repo     │     │    Application Repo     │
│    (myapp-repo, etc)    │     │    (other apps...)      │
└───────────┬─────────────┘     └───────────┬─────────────┘
            │                               │
            │ 1. Deploy Docker/Lambda       │
            │ 2. Commit manifest update     │
            │    (GitHub App, contents API) │
            │                               │
            ▼                               ▼
┌─────────────────────────────────────────────────────────┐
│                  Bergschacht (CDK Repo)                 │
│                                                         │
│  version-manifests/latest.json  (committed)             │
│  ┌──────────────────────────────────────────────────┐   │
│  │ repositories.{repo}.lambdas.{name} = {           │   │
│  │   latest: {...}, pinned?: {...} }                │   │
│  │ repositories.{repo}.images.{name}  = { ... }     │   │
│  └──────────────────────────────────────────────────┘   │
│                           │ getLambdaArtifact()         │
│                           │ / getImageArtifact()        │
│                           ▼                             │
│  deploy.yml  (triggered by the manifest commit)         │
│  ┌──────────────────────────────────────────────────┐   │
│  │ 1. Synth CDK & compare template checksums        │   │
│  │ 2. Trigger only changed pipelines                │   │
│  │   ┌───────────────────┐  ┌─────────────────────┐ │   │
│  │   │  Infrastructure   │  │   Production        │ │   │
│  │   │  Pipeline         │  │   Pipeline          │ │   │
│  │   │  (CicdStage)      │  │  (Staging -> Prod)  │ │   │
│  │   └───────────────────┘  └─────────────────────┘ │   │
│  └──────────────────────────────────────────────────┘   │
│                                                         │
│  Development Pipeline (CodePipeline V2 auto-trigger)    │
│  ┌──────────────────────────────────────────────────┐   │
│  │ Triggered by dev-* branches -> Dev account only  │   │
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
│   ├── config/               # Configuration (constants, version manifest)
│   ├── infrastructure/       # Shared infrastructure stacks
│   └── pipeline/             # Pipeline and stage stacks
│       ├── cicd-stage.ts         # Shared infra (KMS, ECR, OIDC, logging, cross-account)
│       └── environment-stage.ts  # App workloads (ECS, Lambda) parameterized by account
├── test/                     # Infrastructure tests
├── version-manifests/        # Committed version manifest
│   ├── latest.json           # Deployed artifact versions (source of truth)
│   └── version-manifest.schema.json
└── .github/
    └── workflows/
        ├── test.yml              # PR testing workflow
        ├── deploy.yml            # Synth-based change detection & pipeline triggering
        └── dev-pipeline.yml      # Manual re-trigger for a specific dev-* branch
```

## Getting started

### Installing dependencies

To start developing simply install all the dependencies and get going. You can do that manually (by reviewing the `mise.toml` file) or use [`mise`](https://mise.jdx.dev/getting-started.html) for that. Simply download it and run the below commands.

```bash
mise trust
mise run install # This will install pnpm, pre-commit etc.
```

### Environment variables

CDK Environment variables are generally hardcoded in `lib/config/constants.ts`. Package variables during deployment are set within the package itself or overwritten via CDK, you can find them inside the specific packages directory. If desired they can be easily overwritten with `mise` as well.

To do that create a local `mise.local.toml` file. Mise will handle the environment variables for you. This file is excluded from version control and is only for local development - all local env variables or secrets can be set there. See `mise.local.example.toml` for the formatting.

### Development with CDK

You can use `pnpm` to format, lint, build and test. Alternatively you can also use `mise` tasks which under will use `pnpm` under the hood.

```bash
mise run pre-commit         # Run pre-commit (formatting/linting)
mise run build              # Build CDK
mise run test               # Build & run tests
mise run test-full          # Build, test, pre-commit & synth
mise run synth              # Build & synthesize stacks
mise run diff               # Show diff for stacks
mise run deploy             # Deploy to AWS
mise run pin -- <repo> <images|lambdas> <name> <reason>  # Pin an artifact at its current version
mise run unpin -- <repo> <images|lambdas> <name>         # Drop the pin; latest deploys again

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
> Synth needs no AWS credentials for artifact versions - they come from the committed `version-manifests/latest.json`.

### Adding a New Application Repository

1. Create your new repository, use the `sample-python-repo` repo as the template.
2. Create a new `prod` environment in the repository.
3. Get the App ID and generate the private key for your repo [here](https://github.com/organizations/feuerstein-org/settings/apps/version-manifest)
4. Configure remaining GitHub environment variables/secrets in the `prod` environment:

| Secret                     | Description                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------- |
| `CDK_REPO_APP_ID`          | GitHub App ID for committing manifest updates to the CDK repo (needs `contents: write`) |
| `CDK_REPO_APP_PRIVATE_KEY` | GitHub App private key for authentication                                               |

| Variable                | Description                        |
| ----------------------- | ---------------------------------- |
| `CICD_ACCOUNT_ID`       | AWS account ID for CI/CD resources |
| `AWS_REGION`            | AWS region (e.g., `us-east-1`)     |
| `ECR_REPOSITORY_NAME`   | ECR repository name                |
| `LAMBDA_S3_BUCKET_NAME` | S3 bucket for Lambda artifacts     |
| `CDK_REPO_OWNER`        | GitHub owner of the CDK repo       |
| `CDK_REPO_NAME`         | Name of the CDK repo               |

1. Give your new repository permissions to push to S3/ECR by updating the IAM permissions in this repo. This is done by updating the `constants.ts` file.
2. Deploy your application using CDK. See below for usage in CDK stacks.

#### Artifact Configuration

Each workspace member package can produce **multiple named artifacts** - Docker images, Lambda packages, or a mix. Configure them in each package's `pyproject.toml` under `[tool.bergschacht.artifacts.<name>]`:

The hiararchy is as follows:

- Repository
- Package
- Artifact

Packages are versioned, artifacts are not. This means each package version can have different artifacts. Workspaces allow you to have multiple packages in one repository, if it's not a workspace then the repository will have only one package.

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
[tool.bergschacht.artifacts.sample-python-app]
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

Application artifact versions are tracked in **`version-manifests/latest.json`**, committed to this repo. The manifest is validated against `version-manifests/version-manifest.schema.json` by pre-commit. Because the manifest is part of the repo, **a git commit fully determines the deployed artifact set**: the pipelines synth from their source checkout with no live lookups, so the same commit always produces the same templates, and the git history of the manifest is the history of version sets.

Each artifact entry holds:

- **`latest`** - the newest published artifact; always advanced (only forward) when an app repo deploys. This is what CDK synth resolves - unless:
- **`pinned`** (optional) - a full artifact block that deploys _instead of_ `latest` while present. Automated updates never touch it; publishes keep advancing `latest` underneath.
- **`pinReason`** (optional) - why the pin exists, for the future reader wondering why the artifact is not on `latest`.

> Note: In the future the version manifest will live in a separate repo or a separate Service that manages versions, review [Seilbahn](https://github.com/feuerstein-org/seilbahn) for reasoning. But mainly, security concerns, requirement for multiple version manifests in the future etc.

### How it works

1. **Application repos** build and push Docker images / Lambda packages to AWS
2. Their deploy workflow (seilbahn's `update-version-manifest` action) commits the new artifact metadata to `version-manifests/latest.json` in this repo via the GitHub App (contents API with conflict retry). `latest` is advanced when the version is newer; a `pinned` block, if present, is never touched
3. The manifest commit lands on `master` and triggers `deploy.yml` (the `version-manifests/**` push path), which runs synth-based change detection and triggers the **Production Pipeline** when application templates changed
4. The Production Pipeline snapshots this repo at one commit for the whole execution, so Staging and Prod deploy the exact same artifact set, and the manual Prod approval approves exactly what Staging tested

For infrastructure changes pushed to `master`, `deploy.yml` runs `cdk synth`, compares template checksums against cached values, and only triggers the **Infrastructure Pipeline** and/or **Production Pipeline** if their templates actually changed.

> If an artifact was deleted from AWS you can redeploy it simply by rerunning an old workflow inside the application repo to redeploy the artifact for said version (rebuild-only redeploy - it does not move the manifest).

### Pinning

To freeze an artifact while its source repo keeps releasing:

```bash
mise run pin -- foerderturm images dagster "0.7.0 breaks X, see #123"
# copies `latest` into a `pinned` block (which deploys instead) and records the reason.
# To pin an *older* version, edit the pinned block manually - copy it from git history.
git commit && git push   # the push triggers the deploy
```

While pinned, app repo deploys keep advancing `latest` (so the newest published version stays visible in the manifest) but never touch `pinned`. To release the pin:

```bash
mise run unpin -- foerderturm images dagster # removes the pinned block; latest deploys again
```

### Rollback

- **Specific artifact**: copy the artifact block of the desired version from the manifest's git history (`git log -p version-manifests/latest.json`) into the entry's `pinned` field with a `pinReason`. Commit and push. The pin keeps the next app deploy from overwriting the rollback.
- **Whole version set**: `git revert` the manifest commit(s), or restore the file from an earlier commit. Note the pipeline deploys `master` HEAD - infra code changes merged since are deployed along with the reverted manifest.
- **CDK stage**: Revert to a specific execution ID in CodePipeline or revert to a previous commit in this repo.
- **Manual re-trigger**: Use `workflow_dispatch` on `deploy.yml` to select `infra`, `prod`, or `all` to force-trigger specific pipelines.

### Manifest Structure

```json
{
  "$schema": "./version-manifest.schema.json",
  "schemaVersion": "1.0.0",
  "repositories": {
    "sample-python-repo": {
      "source": "feuerstein-org/sample-python-repo",
      "lambdas": {
        "sample-etl-pipeline": {
          "latest": {
            "bucket": "example-lambda-artifacts",
            "key": "sample-python-repo/sample-etl-pipeline-0.1.0.zip",
            "objectVersion": "AbCdEf1234567890",
            "version": "0.1.0",
            "commitSha": "abc123..."
          }
        }
      },
      "images": {
        "sample-etl-pipeline": {
          "latest": {
            "repository": "123456789.dkr.ecr.us-east-1.amazonaws.com/feuerstein",
            "imageTag": "sample-python-repo-sample-etl-pipeline-0.2.0",
            "version": "0.2.0",
            "commitSha": "def456..."
          },
          "pinned": {
            "repository": "123456789.dkr.ecr.us-east-1.amazonaws.com/feuerstein",
            "imageTag": "sample-python-repo-sample-etl-pipeline-0.1.0",
            "version": "0.1.0",
            "commitSha": "abc123..."
          },
          "pinReason": "0.2.0 breaks X, see #123"
        }
      }
    }
  }
}
```

**Lambda Deployment**

| Field           | Description                                             |
| --------------- | ------------------------------------------------------- |
| `bucket`        | S3 bucket containing the artifact                       |
| `key`           | S3 object key (path to zip file)                        |
| `objectVersion` | S3 object version ID                                    |
| `version`       | Semantic version of the package                         |
| `commitSha`     | Git commit SHA that produced this artifact (7-40 chars) |

**Container Image Deployment**

| Field        | Description                                          |
| ------------ | ---------------------------------------------------- |
| `repository` | Full ECR repository URI                              |
| `imageTag`   | Docker image tag                                     |
| `version`    | Semantic version of the package                      |
| `commitSha`  | Git commit SHA that produced this image (7-40 chars) |

### Usage in CDK Stacks

```typescript
import { getLambdaArtifact, getImageArtifact } from '../lib/config/version-manifest';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';

// Get Lambda package configuration. Pass repo name and artifact name.
// Reads from version-manifests/latest.json (the `pinned` block if present, else `latest`)
const lambdaConfig = getLambdaArtifact('order-processor', 'order-processor');

new lambda.Function(this, 'OrderProcessor', {
  code: lambda.Code.fromBucket(
    s3.Bucket.fromBucketName(this, 'Bucket', lambdaConfig.bucket),
    lambdaConfig.key,
    lambdaConfig.objectVersion
  ),
  // ... other configuration
});

// Get image artifact
const imageConfig = getImageArtifact('order-processor', 'order-processor');
// Use imageConfig.repository and imageConfig.imageTag

// Multi-artifact repo: get specific named artifacts
const workerImage = getImageArtifact('order-service', 'worker');
const apiImage = getImageArtifact('order-service', 'api');
const webhookLambda = getLambdaArtifact('order-service', 'webhook');
```

## Deployment Model

Deployments are handled by three CDK Pipelines which all live in the CI/CD account. GitHub Actions orchestrate CI tasks (testing, linting) and selectively trigger the correct pipeline(s) based on what actually changed.

### Pipelines

| Pipeline                                           | AWS Name                            | Trigger                                     | Stages                                 | Description                                                       |
| -------------------------------------------------- | ----------------------------------- | ------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------- |
| **Infrastructure** (`InfrastructurePipelineStack`) | `BergschachtInfrastructurePipeline` | `deploy.yml` on infrastructure changes      | CicdStage                              | Shared infrastructure: KMS, ECR, OIDC, cross-account ReadOnlyRole |
| **Production** (`ProductionPipelineStack`)         | `BergschachtProductionPipeline`     | `deploy.yml` on app/manifest changes        | Staging -> Prod (with manual approval) | Application workloads consuming the version manifest              |
| **Development** (`DevelopmentPipelineStack`)       | `BergschachtDevelopmentPipeline`    | CodePipeline V2 trigger on `dev-*` branches | Dev only                               | Feature branch testing                                            |

### Stages

There are two stage classes:

- **`CicdStage`** - All shared infrastructure deployed to the CI/CD account, plus cross-account ReadOnlyRole for Dev, Staging, and Prod. Used only by the Infrastructure Pipeline.
- **`EnvironmentStage`** - Application workloads (ECS services, Lambda functions, etc.) and per-environment SNS PagerDuty topic, parameterized by account ID. Used by both the Production and Development Pipelines.

### Change Detection (`deploy.yml`)

When triggered automatically (push to `master`), the deploy workflow uses **synth-based change detection** rather than path-based heuristics:

1. **Synth** - Runs `cdk synth` to produce all CloudFormation templates
2. **Checksum** - Hashes templates grouped by pipeline prefix (`InfrastructurePipeline*` vs `ProductionPipeline*`)
3. **Compare** - Compares against cached checksums from the previous run (GitHub Actions cache)
4. **Trigger** - Only triggers pipelines whose templates actually changed

This avoids unnecessary deployments when e.g. a shared file like `constants.ts` is edited but doesn't affect a particular pipeline's output.

For explicit triggers (`workflow_dispatch`, `workflow_call`), the synth step is skipped entirely - the pipeline is triggered directly:

### Environment Variables & Secrets

These are the required GitHub environment variables (in the `prod` environment) for deploying:

| Variable                  | Description                        |
| ------------------------- | ---------------------------------- |
| `CICD_ACCOUNT_ID`         | AWS account ID for CI/CD resources |
| `AWS_REGION`              | AWS region for deployments         |
| `INFRA_CDK_PIPELINE_NAME` | Infrastructure CDK Pipeline name   |
| `PROD_CDK_PIPELINE_NAME`  | Production CDK Pipeline name       |
| `DEV_CDK_PIPELINE_NAME`   | Development CDK Pipeline name      |

AWS authentication uses OIDC via the `aws-actions/configure-aws-credentials` action, assuming a role: `{repo}-prod-github-actions-role`.

### Infrastructure Pipeline (`InfrastructurePipelineStack`)

- **Triggered by**: `deploy.yml` when infrastructure templates change
- **AWS Pipeline Name**: `BergschachtInfrastructurePipeline`
- **Deployment stages**:
  1. **CICD Account** (`CicdStage`) - KMS keys, ECR repository, Lambda artifacts bucket, GitHub OIDC provider, GitHub Actions roles, central logging, cross-account ReadOnlyRole for Dev, Staging, and Prod

### Production Pipeline (`ProductionPipelineStack`)

- **Triggered by**: `deploy.yml` when application templates change - including version manifest commits pushed by application repos
- **AWS Pipeline Name**: `BergschachtProductionPipeline`
- **Deployment stages**:
  1. **Staging Account** (`EnvironmentStage`) - Staging environment application workloads
  2. **Prod Account** (`EnvironmentStage`) - Production environment application workloads (requires manual approval)

The pipeline's synth step reads artifact versions from the committed `version-manifests/latest.json` of its source checkout - one commit determines the whole execution, so Staging and Prod deploy the same artifact set.

> [!WARNING]
> **Iceberg column renames + superseded pipelines.** Renaming a column on an Iceberg
> table (via the `s3tables-table-manager` custom resource) is a **two-deploy migration**:
> deploy 1 sets `renamedFrom` on the column and performs a true `rename_column`; deploy 2
> removes the directive. This is only safe if deploy 1 reaches **every** stage before
> deploy 2 does. CDK Pipelines / CodePipeline run in the default **SUPERSEDED** execution
> mode, so a quickly-merged deploy 2 can leapfrog deploy 1 at a stage transition (e.g.
> Staging → Prod) and hit a not-yet-renamed table with no `renamedFrom` present — the
> reconciler then **drops the old column (losing its data) and adds an empty new one**
> instead of renaming.
>
> Because `renamedFrom` is idempotent and self-deactivating, the safe default is to **leave
> the directive in place** and only remove it much later as unhurried housekeeping (once the
> rename has provably reached every stage), and/or gate the two deploys — the Prod stage's
> manual approval already helps here. See `IcebergColumn.renamedFrom` in
> `lib/infrastructure/iceberg-schema.ts` for the full rationale.

> [!WARNING]
> **Iceberg column renames + superseded pipelines.** Renaming a column on an Iceberg
> table (via the `s3tables-table-manager` custom resource) is a **two-deploy migration**:
> deploy 1 sets `renamedFrom` on the column and performs a true `rename_column`; deploy 2
> removes the directive. This is only safe if deploy 1 reaches **every** stage before
> deploy 2 does. CDK Pipelines / CodePipeline run in the default **SUPERSEDED** execution
> mode, so a quickly-merged deploy 2 can leapfrog deploy 1 at a stage transition (e.g.
> Staging → Prod) and hit a not-yet-renamed table with no `renamedFrom` present — the
> reconciler then **drops the old column (losing its data) and adds an empty new one**
> instead of renaming.
>
> Because `renamedFrom` is idempotent and self-deactivating, the safe default is to **leave
> the directive in place** and only remove it much later as unhurried housekeeping (once the
> rename has provably reached every stage), and/or gate the two deploys — the Prod stage's
> manual approval already helps here. See `IcebergColumn.renamedFrom` in
> `lib/infrastructure/iceberg-schema.ts` for the full rationale.

### Development Pipeline (`DevelopmentPipelineStack`)

- **Triggered by**: CodePipeline V2 push trigger on all branches matching `dev-*`
- **AWS Pipeline Name**: `BergschachtDevelopmentPipeline`
- **Deployment stages**:
  1. **Dev Account** (`EnvironmentStage`) - Development environment only

**Important**: Any push to a `dev-*` branch will trigger a deployment to the Dev account.

`restartExecutionOnUpdate` is set to `false`. Without this, the self-mutation step would update the pipeline via CloudFormation, and that CloudFormation-triggered restart has no push-event context - it falls back to the hardcoded `master` source branch and overwrites the dev deployment. Self-mutation still runs; the pipeline just won't auto-restart after it applies.

**Manual re-trigger**: The "Release change" button in the CodePipeline console always deploys `master`. After a stage is modified or added (which triggers self-mutation), use the [**Trigger Dev Pipeline**](https://github.com/feuerstein-org/bergschacht/actions/workflows/dev-pipeline.yml) GitHub Actions workflow to re-run the pipeline for your specific branch (The workflow needs to run from the `master` branch to have permissions to trigger the pipeline).

This deployment model has a few additional caveats:

- If two people work on different feature branches their changes will overwrite each other on the Dev account. The only realistic solution is having separate accounts for each team.

### Initial Setup

In case CDK pipelines are not deployed or need to be redeployed:

1. **Create a CodeStar Connection to GitHub**:
   - Go to AWS Console -> CodePipeline -> Settings -> Connections
   - Create a new connection for GitHub
   - Complete the OAuth flow to authorize AWS access to your repository, make sure to install the app to not use your personal token
   - Copy the connection ARN to your `GITHUB_CONNECTION_ARN` environment variable or overwrite the value in `lib/config/constants.ts`

2. **Bootstrap all accounts**:

   ```bash
   # Bootstrap the CICD account (where pipelines will run)
   cdk bootstrap aws://<cicd-account-id>/<region>

   # Bootstrap Dev, Staging, and Prod accounts with trust to CICD account
   cdk bootstrap aws://<account-id>/<region> --trust <cicd-account-id> --cloudformation-execution-policies arn:aws:iam::aws:policy/AdministratorAccess
   ```

3. **Deploy the pipeline stacks manually (first time only)**:

   ```bash
   cdk deploy InfrastructurePipeline ProductionPipeline DevelopmentPipeline
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

### InfrastructurePipelineStack

This stack creates the CDK Pipeline for infrastructure deployments:

- Creates a CodePipeline V2 pipeline (`BergschachtInfrastructurePipeline`) with CodeConnections GitHub connection
- Deploys `CicdStage` to the CICD account only
- Contains all shared infra: KMS, ECR, OIDC, logging, and cross-account ReadOnlyRole for Dev/Staging/Prod
- Triggered by GitHub Actions when infrastructure templates change

### ProductionPipelineStack

This stack creates the CDK Pipeline for application deployments:

- Creates a CodePipeline V2 pipeline (`BergschachtProductionPipeline`) with CodeConnections GitHub connection
- Deploys `EnvironmentStage` to Staging -> Prod accounts in sequence
- Includes manual approval step before Prod deployment
- Triggered by GitHub Actions when application templates or the committed version manifest change

### DevelopmentPipelineStack

This stack creates the CDK Pipeline for development/feature branch deployments:

- Creates a CodePipeline V2 pipeline (`BergschachtDevelopmentPipeline`) with CodeConnections GitHub connection
- Deploys `EnvironmentStage` to the Dev account only
- Triggered by CodePipeline V2 push trigger on `dev-*` branches (not via GitHub Actions)
- Allows parallel testing of feature branches in Dev environment

### ReadOnlyRole

This stack creates a read-only IAM role that can be assumed by the CI/CD account. Deployed as cross-account stacks from `CicdStage` into the Dev, Staging, and Prod accounts:

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

### FoerderturmStack

Application workload stack deployed by `EnvironmentStage` into Dev, Staging, and Prod. Hosts the [foerderturm](https://github.com/feuerstein-org/foerderturm) Dagster control plane (webserver + daemon) on Fargate, with Litestream replicating SQLite to S3 for durability and a Tailscale sidecar exposing the UI over the tailnet. See the [foerderturm repo](https://github.com/feuerstein-org/foerderturm) for the container images, local-dev compose stack, and a deeper explanation of why SQLite + Litestream over Postgres/EFS.

- Creates a minimal per-env VPC (public subnets only, no NAT) and an ECS Fargate cluster running one task with six containers (litestream-restore, dagster-init, dagster-webserver, dagster-daemon, litestream sidecar, tailscale sidecar) sharing a task-scoped `dagster-home` volume
- Versioned, KMS-encrypted S3 bucket for Litestream WAL replication with `RETAIN` removal policy and 30-day noncurrent-version expiration
- Pulls the three container images (`dagster`, `litestream`, `tailscale`) from the version manifest, all published by the foerderturm repo to the shared ECR repo
- Reads the Tailscale OAuth client secret from SSM at `/tailscale/foerderturm/oauth-client` - this is a `SecureString` and must be created out-of-band (CloudFormation cannot create SecureString parameters)
- Service uses `minHealthyPercent=0` / `maxHealthyPercent=100` (stop-then-start) because SQLite is single-writer; `desiredCount` is configured per-environment in `environment-stage.ts` (1 in prod, 0 in dev/staging to reduce cost) But mainly, security concerns, requirement for multiple version manifests in the future etc.
