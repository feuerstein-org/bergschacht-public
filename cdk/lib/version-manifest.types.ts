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
  /** Semantic version of the package */
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
  /** Semantic version of the package */
  version: string;
  /** Git commit SHA that produced this image (7-40 chars) */
  commitSha: string;
}

/**
 * Package with one or more deployment types.
 * A package can have lambda, image, or both deployment configurations.
 */
export interface Package {
  /** Lambda deployment configuration */
  lambda?: LambdaArtifactConfig;
  /** Container image deployment configuration */
  image?: ContainerArtifactConfig;
}

/**
 * Complete version manifest structure
 */
export interface VersionManifest {
  /** JSON Schema reference */
  $schema?: string;
  /** Semantic version of the manifest schema */
  schemaVersion: string;
  /** Map of package names to their configurations */
  packages: Record<string, Package>;
}

/**
 * Check if a package has a Lambda deployment
 */
export function hasLambdaDeployment(
  pkg: Package
): pkg is Package & { lambda: LambdaArtifactConfig } {
  return pkg.lambda !== undefined;
}

/**
 * Check if a package has a container image deployment
 */
export function hasImageDeployment(
  pkg: Package
): pkg is Package & { image: ContainerArtifactConfig } {
  return pkg.image !== undefined;
}
