/**
 * Version manifest accessors backed by the committed manifest file.
 *
 * {@link VERSION_MANIFEST_PATH} (version-manifests/latest.json) is the single source
 * of truth for which artifact versions deploy. Application repos update it after
 * publishing artifacts via seilbahn's `update-version-manifest` action, which commits
 * directly to this repo. A git commit of this repo therefore fully determines the
 * deployed artifact set: pinning and rollback are plain git operations.
 *
 * Each artifact entry holds the newest published artifact under `latest` - that is
 * what CDK synth resolves. A `pinned` block, when present, deploys instead of
 * `latest` and is never touched by automated updates; publishes keep advancing
 * `latest` underneath it until the pin is lifted (`mise run unpin`).
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { Construct } from 'constructs';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lambda artifact stored in S3. */
export interface LambdaArtifact {
  /** S3 bucket containing the Lambda artifact */
  bucket: string;
  /** S3 object key (path to zip file) */
  key: string;
  /** S3 object version ID */
  objectVersion: string;
  /** Semantic version of the artifact */
  version: string;
  /** Git commit SHA that produced this artifact (7-40 chars) */
  commitSha: string;
}

/** Container image stored in ECR. */
export interface ContainerArtifact {
  /** Full ECR repository URI */
  repository: string;
  /** Docker image tag */
  imageTag: string;
  /** Semantic version of the artifact */
  version: string;
  /** Git commit SHA that produced this image (7-40 chars) */
  commitSha: string;
}

/** A manifest entry: the newest published artifact, optionally overridden by a pin. */
export interface ManifestEntry<T> {
  /** The newest published artifact - deploys unless `pinned` is present */
  latest: T;
  /** When present, deploys instead of `latest`; never touched by automated updates */
  pinned?: T;
  /** Why this artifact is pinned */
  pinReason?: string;
}

/** Artifact entries of one independently versioned package. */
export interface ManifestPackage {
  images?: Record<string, ManifestEntry<ContainerArtifact>>;
  lambdas?: Record<string, ManifestEntry<LambdaArtifact>>;
}

/** Packages of a single source repository. */
export interface ManifestRepository {
  /** Source repository (owner/repo) that produces these artifacts */
  source: string;
  packages: Record<string, ManifestPackage>;
}

/** Shape of version-manifests/latest.json. */
export interface VersionManifest {
  schemaVersion: string;
  repositories: Record<string, ManifestRepository>;
}

// ---------------------------------------------------------------------------
// Manifest loading
// ---------------------------------------------------------------------------

/** Absolute path to the committed version manifest. */
export const VERSION_MANIFEST_PATH = path.resolve(
  import.meta.dirname,
  '..',
  '..',
  'version-manifests',
  'latest.json'
);

/** Parsed manifest - loaded lazily on first access. */
let manifestCache: VersionManifest | undefined;

/** Load and cache the version manifest from disk. */
function loadManifest(): VersionManifest {
  if (manifestCache) return manifestCache;
  manifestCache = validateManifest(
    JSON.parse(fs.readFileSync(VERSION_MANIFEST_PATH, 'utf-8')) as VersionManifest
  );
  return manifestCache;
}

/** Validate the package-scoped manifest layout. */
function validateManifest(manifest: VersionManifest): VersionManifest {
  if (manifest.schemaVersion !== '2.0.0') {
    throw new Error('Expected version manifest schemaVersion 2.0.0.');
  }
  for (const [repoName, repo] of Object.entries(manifest.repositories)) {
    if (!repo.packages || 'images' in repo || 'lambdas' in repo) {
      throw new Error(`Repository '${repoName}' must use package-scoped manifest entries.`);
    }
  }
  return manifest;
}

/** Reset the in-memory cache (useful in tests). */
export function _resetManifestCache(): void {
  manifestCache = undefined;
}

/** Inject manifest data directly (for tests - avoids filesystem mocking). */
export function _loadManifestFromData(manifest: VersionManifest): void {
  manifestCache = validateManifest(manifest);
}

/** Resolve an artifact entry to what deploys, throwing a descriptive error when absent. */
function resolve<T>(
  entries: Record<string, ManifestEntry<T>> | undefined,
  repoName: string,
  packageName: string,
  kind: 'images' | 'lambdas',
  artifactName: string
): T {
  const entry = entries?.[artifactName];
  if (entry === undefined) {
    throw new Error(
      `Artifact '${repoName}/${packageName}/${kind}/${artifactName}' not found in ${VERSION_MANIFEST_PATH}.\n` +
        'Entries are added by the source repo deploy workflow (seilbahn update-version-manifest).'
    );
  }
  return entry.pinned ?? entry.latest;
}

/**
 * Get a named Lambda artifact from the manifest (the `pinned` block if present, else `latest`).
 *
 * @example
 * const artifact = getLambdaArtifact('sample-python-repo', 'sample-python-repo', 'sample-etl-pipeline');
 * new lambda.Function(this, 'Fn', {
 *   code: lambda.Code.fromBucket(
 *     s3.Bucket.fromBucketName(this, 'Bucket', artifact.bucket),
 *     artifact.key,
 *     artifact.objectVersion,
 *   ),
 *   ...
 * });
 */
export function getLambdaArtifact(
  repoName: string,
  packageName: string,
  artifactName: string
): LambdaArtifact {
  const lambdas = loadManifest().repositories[repoName]?.packages[packageName]?.lambdas;
  return resolve(lambdas, repoName, packageName, 'lambdas', artifactName);
}

/**
 * Get a named container image artifact from the manifest (the `pinned` block if present, else `latest`).
 *
 * @example
 * const artifact = getImageArtifact('sample-python-repo', 'sample-python-repo', 'sample-etl-pipeline');
 * const image = getContainerImage(this, 'SampleImage', artifact);
 */
export function getImageArtifact(
  repoName: string,
  packageName: string,
  artifactName: string
): ContainerArtifact {
  const images = loadManifest().repositories[repoName]?.packages[packageName]?.images;
  return resolve(images, repoName, packageName, 'images', artifactName);
}

/**
 * Parse a ContainerArtifact's ECR repository URI into its component pieces.
 *
 * @throws Error if `artifact.repository` is not a recognizable ECR URI.
 */
function parseEcrRepository(
  scope: Construct,
  id: string,
  artifact: ContainerArtifact
): ecr.IRepository {
  const [host, ...pathParts] = artifact.repository.split('/');
  if (!host) {
    throw new Error(`Invalid repository with empty host: ${artifact.repository}`);
  }
  const name = pathParts.join('/');
  const hostMatch = /^(\d{12})\.dkr\.ecr\.([a-z0-9-]+)\.amazonaws\.com$/.exec(host);
  if (!hostMatch || !name) {
    throw new Error(`Unrecognized ECR repository URI: ${artifact.repository}`);
  }
  const region = hostMatch[2];
  const account = hostMatch[1];
  const repository = ecr.Repository.fromRepositoryAttributes(scope, id, {
    repositoryArn: `arn:aws:ecr:${region}:${account}:repository/${name}`,
    repositoryName: name,
  });
  return repository;
}

/**
 * Build an `ecs.ContainerImage` for a ContainerArtifact
 *
 * @throws Error if `artifact.repository` is not a recognizable ECR URI.
 */
export function getContainerImage(
  scope: Construct,
  id: string,
  artifact: ContainerArtifact
): ecs.ContainerImage {
  const repository = parseEcrRepository(scope, id, artifact);
  return ecs.ContainerImage.fromEcrRepository(repository, artifact.imageTag);
}

/**
 * Build `lambda.DockerImageCode` for a ContainerArtifact
 *
 * @throws Error if `artifact.repository` is not a recognizable ECR URI.
 */
export function getLambdaDockerImageCode(
  scope: Construct,
  id: string,
  artifact: ContainerArtifact
): lambda.DockerImageCode {
  const repository = parseEcrRepository(scope, id, artifact);
  return lambda.DockerImageCode.fromEcr(repository, { tagOrDigest: artifact.imageTag });
}
