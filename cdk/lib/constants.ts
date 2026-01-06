/**
 * AWS Account IDs, Region Configuration and other constants
 */
export const githubConnectionArn =
  process.env.GITHUB_CONNECTION_ARN ||
  'arn:aws:codeconnections:us-east-1:111111111111:connection/00000000-0000-0000-0000-000000000000';
export const cicdAccount = process.env.CICD_ACCOUNT_ID || '111111111111';
export const devAccount = process.env.DEV_ACCOUNT_ID || '222222222222';
export const prodAccount = process.env.PROD_ACCOUNT_ID || '444444444444';
export const awsRegion = process.env.AWS_REGION || 'us-east-1';
export const pagerDutyEmail =
  process.env.PAGERDUTY_EMAIL || 'alerts@example.invalid';
// export const eodhdApiKey = process.env.EODHD_API_KEY!;

// GitHub organization and repository
export const githubOrg = process.env.GITHUB_ORG || 'feuerstein-org';
export const githubRepo = process.env.GITHUB_REPO || 'bergschacht';
