/**
 * TypeScript type definitions for the version manifest schema.
 * These types mirror the JSON Schema in version-manifest.schema.json
 */

/**
 * Configuration for Lambda artifacts stored in S3
 */
export interface LambdaArtifactConfig {
  /** S3 bucket containing the Lambda artifact */
  bucket: string;
  /** S3 object key (path to zip file) */
  key: string;
  /** Semantic version of the artifact */
  version: string;
  /** Git commit SHA that produced this artifact (7-40 chars) */
  commitSha: string;
}

/**
 * Configuration for container images stored in ECR
 */
export interface ContainerArtifactConfig {
  /** Full ECR repository URI */
  repository: string;
  /** Docker image tag */
  imageTag: string;
  /** Semantic version of the artifact */
  version: string;
  /** Git commit SHA that produced this image (7-40 chars) */
  commitSha: string;
}

/**
 * Repository with one or more named artifacts.
 * Each artifact type (images, lambdas) is a map of artifact name to config.
 */
export interface Repository {
  /** Source repository (owner/repo) that produces this package */
  source: string;
  /** Named Lambda deployment configurations */
  lambdas?: Record<string, LambdaArtifactConfig>;
  /** Named container image deployment configurations */
  images?: Record<string, ContainerArtifactConfig>;
}

/**
 * Complete version manifest structure
 */
export interface VersionManifest {
  /** JSON Schema reference */
  $schema?: string;
  /** Semantic version of the manifest schema */
  schemaVersion: string;
  /** Map of repository names to their configurations */
  repositories: Record<string, Repository>;
}

/**
 * Check if a repository has any Lambda deployments
 */
export function hasLambdaDeployment(
  repo: Repository
): repo is Repository & { lambdas: Record<string, LambdaArtifactConfig> } {
  return repo.lambdas !== undefined && Object.keys(repo.lambdas).length > 0;
}

/**
 * Check if a repository has any container image deployments
 */
export function hasImageDeployment(
  repo: Repository
): repo is Repository & { images: Record<string, ContainerArtifactConfig> } {
  return repo.images !== undefined && Object.keys(repo.images).length > 0;
}
