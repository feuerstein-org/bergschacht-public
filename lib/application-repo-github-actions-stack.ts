import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { GitHubActionsStack } from './github-actions-stack';
import { ApplicationRepo } from './constants';

export interface ApplicationRepoGitHubActionsProps {
  /**
   * The application repository to create permissions for
   */
  readonly appRepo: ApplicationRepo;

  /**
   * The GitHub OIDC provider for authentication
   */
  readonly githubOidcProvider: iam.IOpenIdConnectProvider;

  /**
   * AWS account ID where CI/CD resources live (ECR, S3, KMS)
   */
  readonly cicdAccountId: string;

  /**
   * AWS region for resource ARNs
   */
  readonly awsRegion: string;

  /**
   * The shared ECR repository for container images
   */
  readonly ecrRepository: ecr.IRepository;

  /**
   * The S3 bucket for Lambda deployment artifacts
   */
  readonly lambdaArtifactsBucket: s3.IBucket;

  /**
   * ARN of the KMS key used to encrypt ECR images and S3 objects.
   */
  readonly deploymentResourcesKmsKeyArn: string;

  /**
   * SSM parameter prefix for version manifest data (without leading slash).
   */
  readonly ssmPrefix: string;
}

/**
 * Creates a GitHubActionsStack for a single application repository with scoped permissions.
 *
 * S3 permissions are restricted to the app's own prefix (`<repo-name>/`).
 * ECR permissions are repository-wide.
 */
export function createApplicationRepoGitHubActions(
  scope: Construct,
  props: ApplicationRepoGitHubActionsProps
): GitHubActionsStack {
  const {
    appRepo,
    githubOidcProvider,
    cicdAccountId,
    awsRegion,
    ecrRepository,
    lambdaArtifactsBucket,
    deploymentResourcesKmsKeyArn,
    ssmPrefix,
  } = props;

  // Construct a PascalCase stack id from the repo name
  // e.g. 'sample-python-repo' -> 'SamplePythonRepo'
  const stackId = appRepo.repo
    .split(/[-_]/)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join('');

  return new GitHubActionsStack(scope, `${stackId}GitHubActions`, {
    githubOrg: appRepo.org,
    githubRepo: appRepo.repo,
    githubEnvironment: appRepo.environment,
    githubOidcProvider,
    additionalPolicies: [
      // ECR authentication (account-wide, no resource scoping possible)
      new iam.PolicyStatement({
        sid: 'AllowEcrAuth',
        effect: iam.Effect.ALLOW,
        actions: ['ecr:GetAuthorizationToken'],
        resources: ['*'],
      }),
      // ECR push - scoped to the shared repository
      // (tag-level restriction is not supported by IAM)
      new iam.PolicyStatement({
        sid: 'AllowEcrPush',
        effect: iam.Effect.ALLOW,
        actions: [
          'ecr:BatchCheckLayerAvailability',
          'ecr:GetDownloadUrlForLayer',
          'ecr:BatchGetImage',
          'ecr:PutImage',
          'ecr:InitiateLayerUpload',
          'ecr:UploadLayerPart',
          'ecr:CompleteLayerUpload',
          'ecr:DescribeImages',
        ],
        resources: [ecrRepository.repositoryArn],
      }),
      // S3 - ListBucket scoped to the app's own prefix only
      new iam.PolicyStatement({
        sid: 'AllowS3ListOwnPrefix',
        effect: iam.Effect.ALLOW,
        actions: ['s3:ListBucket'],
        resources: [lambdaArtifactsBucket.bucketArn],
        conditions: {
          StringLike: {
            's3:prefix': [`${appRepo.repo}/*`],
          },
        },
      }),
      // S3 - PutObject / GetObject / HeadObject scoped to the app's own prefix
      new iam.PolicyStatement({
        sid: 'AllowS3ReadWriteOwnPrefix',
        effect: iam.Effect.ALLOW,
        actions: ['s3:PutObject', 's3:GetObject', 's3:HeadObject'],
        resources: [`${lambdaArtifactsBucket.bucketArn}/${appRepo.repo}/*`],
      }),
      // KMS - encrypt / decrypt for the shared deployment resources key
      new iam.PolicyStatement({
        sid: 'AllowKmsForDeploymentResources',
        effect: iam.Effect.ALLOW,
        actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*'],
        resources: [deploymentResourcesKmsKeyArn],
      }),
      // SSM - read and write version manifest parameters scoped to the app's own prefix
      new iam.PolicyStatement({
        sid: 'AllowSsmVersionManifest',
        effect: iam.Effect.ALLOW,
        actions: ['ssm:GetParameter', 'ssm:GetParametersByPath', 'ssm:PutParameter'],
        resources: [
          `arn:aws:ssm:${awsRegion}:${cicdAccountId}:parameter/${ssmPrefix}/${appRepo.repo}/*`,
        ],
      }),
    ],
    env: { account: cicdAccountId, region: awsRegion },
  });
}
