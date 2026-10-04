import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { CentralLoggingBucketStack } from '../infrastructure/central-logging-bucket-stack.ts';
import { LambdaArtifactsStack } from '../infrastructure/lambda-artifacts-stack.ts';
import { EcrStack } from '../infrastructure/ecr-stack.ts';
import { SnsPagerDutyStack } from '../infrastructure/sns-pager-duty.ts';
import { ReadOnlyRoleStack } from '../infrastructure/readonly-role-stack.ts';
import { GitHubOIDCProviderStack } from './github-oidc-provider-stack.ts';
import { GitHubActionsStack } from './github-actions-stack.ts';
import { createApplicationRepoGitHubActions } from './application-repo-github-actions-stack.ts';
import {
  type ApplicationRepo,
  centralLoggingBucketName,
  lambdaArtifactsBucketName,
} from '../config/constants.ts';

export interface CicdStageProps extends cdk.StageProps {
  /** Owner of the repository whose Actions control deployments. */
  readonly githubOwner: string;
  /** Repository whose Actions control deployments. */
  readonly githubRepo: string;
  /**
   * The CICD account ID
   */
  readonly cicdAccountId: string;
  /**
   * The Dev account ID
   */
  readonly devAccountId: string;
  /**
   * The Staging account ID
   */
  readonly stageAccountId: string;
  /**
   * The Prod account ID
   */
  readonly prodAccountId: string;
  /**
   * AWS region for deployment
   */
  readonly awsRegion: string;
  /**
   * Email address for PagerDuty alerts
   */
  readonly pagerDutyEmail: string;
  /**
   * Application repositories that get scoped artifact-push permissions.
   * @default []
   */
  readonly applicationRepos?: ApplicationRepo[];
  /**
   * Shared KMS key ARN for encrypting deployment resources (ECR, S3, etc.).
   */
  readonly encryptionKeyArn: string;
}

/**
 * Stage containing all infrastructure stacks for CI/CD.
 * This includes shared resources like ECR repositories, Lambda artifacts, and cross-account roles.
 */
export class CicdStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: CicdStageProps) {
    super(scope, id, props);

    // Add CDK Nag checks to all stacks in this stage
    cdk.Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    const {
      cicdAccountId,
      devAccountId,
      stageAccountId,
      prodAccountId,
      awsRegion,
      pagerDutyEmail,
    } = props;
    const appRepos = props.applicationRepos ?? [];
    const encryptionKeyArn = props.encryptionKeyArn;

    // GitHub OIDC Provider Stack - creates the OIDC provider once per account
    const githubOidcProviderStack = new GitHubOIDCProviderStack(this, 'GitHubOIDCProvider', {
      env: { account: cicdAccountId, region: awsRegion },
    });

    // GitHub Actions Stack - sets up IAM roles for GitHub Actions to run CDK diff
    new GitHubActionsStack(this, 'FeuersteinBergschachtDevGitHubActions', {
      githubOrg: props.githubOwner,
      githubRepo: props.githubRepo,
      githubEnvironment: 'dev',
      lookupAccountIds: [
        [cicdAccountId, 'CICD'],
        [devAccountId, 'Dev'],
        [stageAccountId, 'Stage'],
        [prodAccountId, 'Prod'],
      ],
      githubOidcProvider: githubOidcProviderStack.provider,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // GitHub Actions Stack - sets up IAM roles for GitHub Actions to deploy artifacts and trigger pipeline
    new GitHubActionsStack(this, 'FeuersteinBergschachtProdGitHubActions', {
      githubOrg: props.githubOwner,
      githubRepo: props.githubRepo,
      githubEnvironment: 'prod',
      lookupAccountIds: [
        [cicdAccountId, 'CICD'],
        [devAccountId, 'Dev'],
        [stageAccountId, 'Stage'],
        [prodAccountId, 'Prod'],
      ],
      githubOidcProvider: githubOidcProviderStack.provider,
      additionalPolicies: [
        // Permission to trigger the CDK production pipeline
        new iam.PolicyStatement({
          sid: 'AllowTriggerProductionPipeline',
          effect: iam.Effect.ALLOW,
          actions: ['codepipeline:StartPipelineExecution'],
          resources: [
            `arn:aws:codepipeline:${awsRegion}:${cicdAccountId}:BergschachtInfrastructurePipeline`,
            `arn:aws:codepipeline:${awsRegion}:${cicdAccountId}:BergschachtProductionPipeline`,
          ],
        }),
        // Permission to push images to ECR
        new iam.PolicyStatement({
          sid: 'AllowEcrAuth',
          effect: iam.Effect.ALLOW,
          actions: ['ecr:GetAuthorizationToken'],
          resources: ['*'],
        }),
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
          resources: [`arn:aws:ecr:${awsRegion}:${cicdAccountId}:repository/feuerstein`],
        }),
        // Permission to upload Lambda artifacts to S3
        new iam.PolicyStatement({
          sid: 'AllowS3LambdaArtifactsUpload',
          effect: iam.Effect.ALLOW,
          actions: ['s3:PutObject', 's3:GetObject', 's3:ListBucket'],
          resources: [
            `arn:aws:s3:::${lambdaArtifactsBucketName}`,
            `arn:aws:s3:::${lambdaArtifactsBucketName}/*`,
          ],
        }),
        // Permission to use the KMS key for encryption
        new iam.PolicyStatement({
          sid: 'AllowKmsForDeploymentResources',
          effect: iam.Effect.ALLOW,
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: [encryptionKeyArn],
        }),
      ],
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Create SNS PagerDuty topic for CICD account
    const snsPagerDutyStack = new SnsPagerDutyStack(this, 'SnsPagerDuty', {
      topicName: 'PagerDutyAlertsCicd',
      emailAddress: pagerDutyEmail,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Create centralized logging bucket for CI/CD account
    const centralLoggingBucket = new CentralLoggingBucketStack(this, 'CentralLoggingBucket', {
      bucketName: centralLoggingBucketName,
      encryptionKeyArn,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy Lambda Artifacts S3 bucket in CI/CD account with shared KMS key
    const lambdaArtifactsStack = new LambdaArtifactsStack(this, 'LambdaArtifacts', {
      bucketName: lambdaArtifactsBucketName,
      allowedAccountIds: [devAccountId, stageAccountId, prodAccountId],
      encryptionKeyArn,
      serverAccessLogsBucket: centralLoggingBucket.bucket,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy central ECR Stack in CI/CD account with shared KMS key
    const ecrStack = new EcrStack(this, 'FeuersteinEcr', {
      repositoryName: 'feuerstein',
      notificationTopic: snsPagerDutyStack.topic,
      allowedPullAccountIds: [devAccountId, stageAccountId, prodAccountId],
      encryptionKeyArn,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Create scoped GitHub Actions roles for each application repository
    for (const appRepo of appRepos) {
      createApplicationRepoGitHubActions(this, {
        appRepo,
        githubOidcProvider: githubOidcProviderStack.provider,
        cicdAccountId,
        awsRegion,
        ecrRepository: ecrStack.repository,
        lambdaArtifactsBucket: lambdaArtifactsStack.bucket,
        deploymentResourcesKmsKeyArn: encryptionKeyArn,
      });
    }

    // --- Cross-account infrastructure for Dev and Prod ---
    // These stacks deploy into the Dev/Prod accounts but are owned by the infrastructure pipeline
    // so the application pipeline doesn't need to redeploy them.

    // ReadOnly Role for Dev account
    new ReadOnlyRoleStack(this, 'DevReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: devAccountId, region: awsRegion },
    });

    // ReadOnly Role for Stage account
    new ReadOnlyRoleStack(this, 'StageReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: stageAccountId, region: awsRegion },
    });

    // ReadOnly Role for Prod account
    new ReadOnlyRoleStack(this, 'ProdReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: prodAccountId, region: awsRegion },
    });
  }
}
