import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { CentralLoggingBucketStack } from '../infrastructure/central-logging-bucket-stack';
import { LambdaArtifactsStack } from '../infrastructure/lambda-artifacts-stack';
import { EcrStack } from '../infrastructure/ecr-stack';
import { SnsPagerDutyStack } from '../infrastructure/sns-pager-duty';
import { ReadOnlyRoleStack } from '../infrastructure/readonly-role-stack';
import { GitHubOIDCProviderStack } from './github-oidc-provider-stack';
import { GitHubActionsStack } from './github-actions-stack';
import { createApplicationRepoGitHubActions } from './application-repo-github-actions-stack';
import { ApplicationRepo, ssmPrefix } from '../config/constants';

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
   * The Staging account ID
   */
  readonly stagingAccountId: string;
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
      stagingAccountId,
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
      githubOrg: 'feuerstein-org',
      githubRepo: 'bergschacht',
      githubEnvironment: 'dev',
      lookupAccountIds: [
        [cicdAccountId, 'CICD'],
        [devAccountId, 'Dev'],
        [stagingAccountId, 'Staging'],
        [prodAccountId, 'Prod'],
      ],
      githubOidcProvider: githubOidcProviderStack.provider,
      additionalPolicies: [
        // Permission to read version manifest from SSM during CDK synth
        new iam.PolicyStatement({
          sid: 'AllowSsmReadVersionManifest',
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
          resources: [
            `arn:aws:ssm:${awsRegion}:${cicdAccountId}:parameter/${ssmPrefix}/*`,
            `arn:aws:ssm:${awsRegion}:${cicdAccountId}:parameter/${ssmPrefix}`,
          ],
        }),
      ],
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
        [stagingAccountId, 'Staging'],
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
          resources: [encryptionKeyArn],
        }),
        // Permission to read version manifest from SSM during CDK synth
        new iam.PolicyStatement({
          sid: 'AllowSsmReadVersionManifest',
          effect: iam.Effect.ALLOW,
          actions: ['ssm:GetParameter', 'ssm:GetParametersByPath'],
          resources: [`arn:aws:ssm:${awsRegion}:${cicdAccountId}:parameter/${ssmPrefix}/*`],
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
      encryptionKeyArn,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy Lambda Artifacts S3 bucket in CI/CD account with shared KMS key
    const lambdaArtifactsStack = new LambdaArtifactsStack(this, 'LambdaArtifacts', {
      bucketName: 'example-lambda-artifacts',
      allowedAccountIds: [devAccountId, stagingAccountId, prodAccountId],
      encryptionKeyArn,
      serverAccessLogsBucket: centralLoggingBucket.bucket,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy central ECR Stack in CI/CD account with shared KMS key
    const ecrStack = new EcrStack(this, 'FeuersteinEcr', {
      repositoryName: 'feuerstein',
      notificationTopic: snsPagerDutyStack.topic,
      allowedPullAccountIds: [devAccountId, stagingAccountId, prodAccountId],
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
        ssmPrefix,
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

    // ReadOnly Role for Staging account
    new ReadOnlyRoleStack(this, 'StagingReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: stagingAccountId, region: awsRegion },
    });

    // ReadOnly Role for Prod account
    new ReadOnlyRoleStack(this, 'ProdReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: prodAccountId, region: awsRegion },
    });
  }
}
