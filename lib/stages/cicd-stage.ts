import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { SharedKmsKeyStack } from '../shared-kms-key-stack';
import { CentralLoggingBucketStack } from '../central-logging-bucket-stack';
import { LambdaArtifactsStack } from '../lambda-artifacts-stack';
import { EcrStack } from '../ecr-stack';
import { SnsPagerDutyStack } from '../sns-pager-duty';
import { ReadOnlyRoleStack } from '../readonly-role-stack';
import { GitHubOIDCProviderStack } from '../github-oidc-provider-stack';
import { GitHubActionsStack } from '../github-actions-stack';
import { createApplicationRepoGitHubActions } from '../application-repo-github-actions-stack';
import { ApplicationRepo } from '../constants';

export interface CicdStageProps extends cdk.StageProps {
  /**
   * The CICD account ID
   */
  readonly cicdAccountId: string;
  /**
   * The Dev account ID
   */
  readonly devAccountId: string;
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
}

/**
 * Stage containing all infrastructure stacks for CI/CD.
 * This includes shared resources like KMS keys, ECR repositories, and Lambda artifacts.
 */
export class CicdStage extends cdk.Stage {
  public readonly deploymentResourcesKmsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: CicdStageProps) {
    super(scope, id, props);

    // Add CDK Nag checks to all stacks in this stage
    cdk.Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    const { cicdAccountId, devAccountId, prodAccountId, awsRegion, pagerDutyEmail } = props;
    const appRepos = props.applicationRepos ?? [];

    // GitHub OIDC Provider Stack - creates the OIDC provider once per account
    const githubOidcProviderStack = new GitHubOIDCProviderStack(this, 'GitHubOIDCProvider', {
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Create shared KMS key for ECR and Lambda artifacts in CI/CD account
    const deploymentResourcesKmsKeyStack = new SharedKmsKeyStack(
      this,
      'DeploymentResourcesKmsKey',
      {
        kmsDescription: 'Shared KMS key for Deployment resources',
        keyAlias: 'cicd-deployment-resources',
        // TODO: These policies can be tightened and limited to specific ARNs
        // Do it like with the ReadOnlyRoleStack trustedArns and specify the specific ARNs that need access
        // Since it's only deployment artifacts this is not urgent
        allowedDecryptAccountIds: [cicdAccountId, devAccountId, prodAccountId],
        env: { account: cicdAccountId, region: awsRegion },
      }
    );

    // GitHub Actions Stack - sets up IAM roles for GitHub Actions to run CDK diff
    new GitHubActionsStack(this, 'FeuersteinBergschachtDevGitHubActions', {
      githubOrg: 'feuerstein-org',
      githubRepo: 'bergschacht',
      githubEnvironment: 'dev',
      lookupAccountIds: [
        [cicdAccountId, 'CICD'],
        [devAccountId, 'Dev'],
        [prodAccountId, 'Prod'],
      ],
      githubOidcProvider: githubOidcProviderStack.provider,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // GitHub Actions Stack - sets up IAM roles for GitHub Actions to deploy artifacts and trigger pipeline
    new GitHubActionsStack(this, 'FeuersteinBergschachtProdGitHubActions', {
      githubOrg: 'feuerstein-org',
      githubRepo: 'bergschacht',
      githubEnvironment: 'prod',
      lookupAccountIds: [
        [cicdAccountId, 'CICD'],
        [devAccountId, 'Dev'],
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
            `arn:aws:codepipeline:${awsRegion}:${cicdAccountId}:BergschachtInfraPipeline`,
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
            'arn:aws:s3:::example-lambda-artifacts',
            'arn:aws:s3:::example-lambda-artifacts/*',
          ],
        }),
        // Permission to use the KMS key for encryption
        new iam.PolicyStatement({
          sid: 'AllowKmsForDeploymentResources',
          effect: iam.Effect.ALLOW,
          actions: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*'],
          resources: [deploymentResourcesKmsKeyStack.key.keyArn],
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
      bucketName: 'example-cicd-logs',
      encryptionKey: deploymentResourcesKmsKeyStack.key,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy Lambda Artifacts S3 bucket in CI/CD account with shared KMS key
    const lambdaArtifactsStack = new LambdaArtifactsStack(this, 'LambdaArtifacts', {
      bucketName: 'example-lambda-artifacts',
      allowedAccountIds: [devAccountId, prodAccountId],
      encryptionKey: deploymentResourcesKmsKeyStack.key,
      serverAccessLogsBucket: centralLoggingBucket.bucket,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy central ECR Stack in CI/CD account with shared KMS key
    const ecrStack = new EcrStack(this, 'FeuersteinEcr', {
      repositoryName: 'feuerstein',
      notificationTopic: snsPagerDutyStack.topic,
      allowedPullAccountIds: [devAccountId, prodAccountId],
      encryptionKey: deploymentResourcesKmsKeyStack.key,
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
        deploymentResourcesKmsKey: deploymentResourcesKmsKeyStack.key,
      });
    }

    // --- Cross-account infrastructure for Dev and Prod ---
    // These stacks deploy into the Dev/Prod accounts but are owned by the infra pipeline
    // so the application pipeline doesn't need to redeploy them.

    // ReadOnly Role for Dev account
    new ReadOnlyRoleStack(this, 'DevReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: devAccountId, region: awsRegion },
    });

    // ReadOnly Role for Prod account
    new ReadOnlyRoleStack(this, 'ProdReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: prodAccountId, region: awsRegion },
    });
  }
}
