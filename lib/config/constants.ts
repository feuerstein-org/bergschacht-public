/**
 * AWS Account IDs, Region Configuration and other constants
 */
export const githubConnectionArn =
  process.env.GITHUB_CONNECTION_ARN ||
  'arn:aws:codeconnections:us-east-1:111111111111:connection/00000000-0000-0000-0000-000000000000';
export const cicdAccount = process.env.CICD_ACCOUNT_ID || '111111111111';
export const devAccount = process.env.DEV_ACCOUNT_ID || '222222222222';
export const stageAccount = process.env.STAGE_ACCOUNT_ID || '333333333333';
export const prodAccount = process.env.PROD_ACCOUNT_ID || '444444444444';
export const awsRegion = process.env.AWS_REGION || 'us-east-1';
export const pagerDutyEmail = process.env.PAGERDUTY_EMAIL || 'alerts@example.com';
// export const eodhdApiKey = process.env.EODHD_API_KEY!;

// GitHub organization and repository
export const githubOrg = process.env.GITHUB_ORG || 'feuerstein-org';
export const githubRepo = process.env.GITHUB_REPO || 'bergschacht';

export const centralLoggingBucketName = 'example-cicd-logs';
export const lambdaArtifactsBucketName = 'example-lambda-artifacts';
export const tableBucketPrefix = 'example-tables';

/**
 * Naming for the Dagster run-worker ECS tasks the orchestrator launches via the
 * `WorkerImageEcsRunLauncher` (one task per run). The task definitions themselves are
 * registered dynamically by the launcher at run time (family `run-worker_<worker>_<job>`); these
 * names cover only the deterministic *roles* the launcher passes (`iam:PassRole`) and are
 * referenced by ARN, so no cross-stack handle is needed.
 */
export const runWorkerPrefix = 'foerderturm-runworker-';
/** Execution role for run-worker ECS tasks (ECR pull, CloudWatch logs, DB-secret read). */
export const runWorkerExecRoleName = (environment: string): string =>
  `${runWorkerPrefix}exec-${environment}`;
/**
 * Task-definition family prefix the EcsRunLauncher stamps onto every run-worker task def
 * (`task_definition_prefix` in foerderturm's dagster.yaml). The orchestrator's `ecs:RunTask`
 * is scoped to `<prefix>_*`, so this MUST stay in sync with dagster.yaml. Max 16 chars.
 * WorkerImageEcsRunLauncher completes each family as `<prefix>_<worker>_<job>`.
 */
export const runWorkerTaskFamilyPrefix = 'run-worker';

/**
 * Application repository configuration.
 * Each entry defines a GitHub repo that is allowed to push artifacts (Docker images / Lambda packages)
 * to the central CI/CD account.
 */
export interface ApplicationRepo {
  /** GitHub organization or user name */
  readonly org: string;
  /** GitHub repository name - also used as the S3 prefix and ECR tag prefix */
  readonly repo: string;
  /** GitHub environment name that the deploy workflow runs in */
  readonly environment: string;
}

/**
 * List of application repositories that deploy artifacts to the CI/CD account.
 * Add new repos here; the CI/CD stage will automatically create scoped IAM roles for each.
 */
export const applicationRepos: ApplicationRepo[] = [
  { org: 'feuerstein-org', repo: 'sample-python-repo', environment: 'prod' },
  { org: 'feuerstein-org', repo: 'sample-python-monorepo', environment: 'prod' },
  { org: 'feuerstein-org', repo: 'bergschacht-custom-resources', environment: 'prod' },
  { org: 'feuerstein-org', repo: 'foerderturm', environment: 'prod' },
  { org: 'feuerstein-org', repo: 'schmelzwerk', environment: 'prod' },
];
