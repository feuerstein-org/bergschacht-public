import * as cdk from 'aws-cdk-lib/core';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { EnvironmentStage } from './environment-stage';
import { ssmPrefix } from '../config/constants';

export interface ProductionPipelineStackProps extends cdk.StackProps {
  /**
   * GitHub repository owner (organization or user)
   */
  readonly githubOwner: string;
  /**
   * GitHub repository name
   */
  readonly githubRepo: string;
  /**
   * GitHub branch to deploy from
   * @default 'master'
   */
  readonly branch?: string;
  /**
   * Arn of the GitHub connection in AWS CodeConnections
   */
  readonly connectionArn: string;
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
   * KMS key alias for the shared deployment encryption key
   * @example 'alias/cicd-shared'
   */
  readonly encryptionKeyAlias: string;
}

/**
 * CDK Pipeline for production application deployments.
 * This pipeline deploys application workloads (ECS services, Lambda functions, etc.)
 * that consume the version manifest from SSM Parameter Store.
 * It deploys to Staging -> Prod only (no CICD stage needed).
 *
 * Triggered by application repos after they update SSM, or by code changes.
 * Infrastructure changes (KMS, ECR, OIDC, etc.) are handled by InfrastructurePipelineStack.
 */
export class ProductionPipelineStack extends cdk.Stack {
  public readonly pipeline: pipelines.CodePipeline;

  constructor(scope: Construct, id: string, props: ProductionPipelineStackProps) {
    super(scope, id, props);

    const branch = props.branch ?? 'master';

    // Look up the shared KMS key by alias at synth time (resolves to a concrete ARN)
    const encryptionKey = kms.Key.fromLookup(this, 'SharedEncryptionKey', {
      aliasName: props.encryptionKeyAlias,
    });

    // Create artifact bucket encrypted with the shared KMS key
    const artifactBucket = new s3.Bucket(this, 'ArtifactsBucket', {
      bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
      encryptionKey,
      encryption: s3.BucketEncryption.KMS,
      bucketKeyEnabled: true,
      versioned: true,
      enforceSSL: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
    });

    const underlyingPipeline = new codepipeline.Pipeline(this, 'UnderlyingPipelineProduction', {
      pipelineName: 'BergschachtProductionPipeline',
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      crossAccountKeys: false,
      restartExecutionOnUpdate: true,
    });

    this.pipeline = new pipelines.CodePipeline(this, 'ProductionPipeline', {
      codePipeline: underlyingPipeline,
      synth: new pipelines.CodeBuildStep('Synth', {
        input: pipelines.CodePipelineSource.connection(
          `${props.githubOwner}/${props.githubRepo}`,
          branch,
          {
            connectionArn: props.connectionArn,
            triggerOnPush: false,
          }
        ),
        commands: [
          'npm install -g pnpm',
          'pnpm install --frozen-lockfile',
          'pnpm run build',
          `aws ssm get-parameters-by-path --path /${ssmPrefix} --recursive --query "Parameters[*].{Name:Name,Value:Value}" --output json > version-manifest.json`,
          'pnpx cdk synth',
        ],
        primaryOutputDirectory: 'cdk.out',
        rolePolicyStatements: [
          new iam.PolicyStatement({
            actions: ['ssm:GetParametersByPath'],
            resources: [
              `arn:aws:ssm:${props.awsRegion}:${this.account}:parameter/${ssmPrefix}/*`,
              `arn:aws:ssm:${props.awsRegion}:${this.account}:parameter/${ssmPrefix}`,
            ],
          }),
        ],
      }),
      dockerEnabledForSynth: false,
      selfMutation: true,
    });

    const stageStage = new EnvironmentStage(this, 'Stage', {
      accountId: props.stageAccountId,
      awsRegion: props.awsRegion,
      pagerDutyEmail: props.pagerDutyEmail,
      env: { account: props.stageAccountId, region: props.awsRegion },
    });
    this.pipeline.addStage(stageStage);

    const prodStage = new EnvironmentStage(this, 'Prod', {
      accountId: props.prodAccountId,
      awsRegion: props.awsRegion,
      pagerDutyEmail: props.pagerDutyEmail,
      env: { account: props.prodAccountId, region: props.awsRegion },
    });
    this.pipeline.addStage(prodStage, {
      pre: [
        new pipelines.ManualApprovalStep('PromoteToProd', {
          comment: 'Approve application deployment to Production',
        }),
      ],
    });

    this.addNagSuppressions();
  }

  private addNagSuppressions(): void {
    NagSuppressions.addStackSuppressions(this, [
      {
        id: 'AwsSolutions-IAM5',
        reason:
          'CDK Pipelines creates IAM policies with wildcards for CodeBuild and CodePipeline operations',
      },
      {
        id: 'AwsSolutions-CB4',
        reason: 'CDK Pipelines manages CodeBuild encryption settings',
      },
      {
        id: 'AwsSolutions-S1',
        reason: 'CDK Pipelines creates artifact buckets without server access logging by default',
      },
      {
        id: 'AwsSolutions-KMS5',
        reason: 'CDK Pipelines creates KMS keys for cross-account deployment',
      },
    ]);
  }
}
