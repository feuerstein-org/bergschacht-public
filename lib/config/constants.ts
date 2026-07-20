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
export const pagerDutyEmail =
  process.env.PAGERDUTY_EMAIL || 'alerts@example.invalid';
// export const eodhdApiKey = process.env.EODHD_API_KEY!;

// GitHub organization and repository
export const githubOrg = process.env.GITHUB_ORG || 'feuerstein-org';
export const githubRepo = process.env.GITHUB_REPO || 'bergschacht';

/**
 * Naming convention for foerderturm connector Lambdas. Connectors live in their own
 * (data-plane) stack, but the orchestrator invokes them by name via Dagster Pipes
 * (`dg.EnvVar("CONNECTOR_<VENDOR>_LAMBDA_NAME")`). Keeping the name deterministic lets the
 * orchestrator grant `lambda:InvokeFunction` on a prefix pattern and receive the name as a
 * plain-string env var, so connectors can be added/removed without a hard cross-stack reference.
 */
export const connectorPrefix = 'foerderturm-connector-';

/** Deterministic function name for a connector, e.g. `connectorFunctionName('example', 'dev')` */
export const connectorFunctionName = (vendor: string, environment: string): string =>
  `${connectorPrefix}${vendor}-${environment}`;

/** Deterministic task name for a connetor, e.g. `connectorEcsTaskFamily('example', 'dev')` */
export const connectorEcsTaskFamily = (vendor: string, environment: string): string =>
  `${connectorPrefix}${vendor}-ecs-${environment}`;
export const connectorEcsTaskRoleName = (vendor: string, environment: string): string =>
  `${connectorPrefix}${vendor}-ecs-task-${environment}`;
export const connectorEcsExecRoleName = (vendor: string, environment: string): string =>
  `${connectorPrefix}${vendor}-ecs-exec-${environment}`;

/**
 * Container name of the connector container inside every connector ECS task definition. The
 * orchestrator targets it in `run_task` containerOverrides (feed/source env), so it must be
 * identical across connectors.
 */
export const connectorEcsContainerName = 'connector';

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
];
