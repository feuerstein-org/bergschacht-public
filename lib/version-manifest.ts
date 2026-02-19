/**
 * Version manifest accessors backed by AWS SSM Parameter Store.
 *
 * Each artifact is stored as a single JSON-valued SSM parameter for atomicity:
 *   /bergschacht/{repoName}/lambdas/{artifactName}   → {"bucket","key","version","commitSha"}
 *   /bergschacht/{repoName}/images/{artifactName}    → {"repository","imageTag","version","commitSha"}
 */

import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { ssmPrefix } from './constants';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Lambda artifact stored in S3, read from SSM at /{ssmPrefix}/{repo}/lambdas/{name}. */
export interface LambdaArtifact {
  /** S3 bucket containing the Lambda artifact */
  bucket: string;
  /** S3 object key (path to zip file) */
  key: string;
  /** Semantic version of the artifact */
  version: string;
  /** Git commit SHA that produced this artifact (7-40 chars) */
  commitSha: string;
}

/** Container image stored in ECR, read from SSM at /{ssmPrefix}/{repo}/images/{name}. */
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

// ---------------------------------------------------------------------------
// SSM accessors
// ---------------------------------------------------------------------------

/** SSM parameter prefix for all version manifest data */
export const SSM_PREFIX = `/${ssmPrefix}`;

/** Resolves an SSM parameter value at CDK synth time using `valueFromLookup`. */
function lookup(scope: Construct, parameterName: string): string {
  return ssm.StringParameter.valueFromLookup(scope, parameterName);
}

/**
 * Get a named Lambda artifact from SSM (stored as a single JSON parameter).
 *
 * @example
 * const artifact = getLambdaArtifact(this, 'sample-python-repo', 'sample-etl-pipeline');
 * new lambda.Function(this, 'Fn', {
 *   code: lambda.Code.fromBucket(
 *     s3.Bucket.fromBucketName(this, 'Bucket', artifact.bucket),
 *     artifact.key,
 *   ),
 *   ...
 * });
 */
export function getLambdaArtifact(
  scope: Construct,
  repoName: string,
  artifactName: string
): LambdaArtifact {
  const json = lookup(scope, `${SSM_PREFIX}/${repoName}/lambdas/${artifactName}`);
  return JSON.parse(json) as LambdaArtifact;
}

/**
 * Get a named container image artifact from SSM (stored as a single JSON parameter).
 *
 * @example
 * const image = getImageArtifact(this, 'sample-python-repo', 'sample-etl-pipeline');
 * new ecs.ContainerImage.fromEcrRepository(
 *   ecr.Repository.fromRepositoryUri(this, 'Repo', image.repository),
 *   image.imageTag,
 * );
 */
export function getImageArtifact(
  scope: Construct,
  repoName: string,
  artifactName: string
): ContainerArtifact {
  const json = lookup(scope, `${SSM_PREFIX}/${repoName}/images/${artifactName}`);
  return JSON.parse(json) as ContainerArtifact;
}
