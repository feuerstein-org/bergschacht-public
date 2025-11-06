/**
 * AWS Account IDs and Region Configuration
 * These are loaded from environment - via GitHub variables
 */

/** Helper function to get required environment variable */
function getRequiredEnv(key: string): string {
  const value = process.env[key];
  if (!value) {
    throw new Error(`Missing required environment variable: ${key}`);
  }
  return value;
}

export const cicdAccount = getRequiredEnv('CICD_ACCOUNT_ID');
export const devAccount = getRequiredEnv('DEV_ACCOUNT_ID');
export const prodAccount = getRequiredEnv('PROD_ACCOUNT_ID');
export const cicdRegion = process.env.CICD_REGION || 'us-west-2';
