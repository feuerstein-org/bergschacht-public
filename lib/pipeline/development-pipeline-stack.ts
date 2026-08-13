import * as cdk from 'aws-cdk-lib/core';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { EnvironmentStage } from './environment-stage.ts';
import { PIPELINE_CODEBUILD_DEFAULTS } from './codebuild-defaults.ts';

export interface DevelopmentPipelineStackProps extends cdk.StackProps {
  /**
   * GitHub repository owner (organization or user)
   */
  readonly githubOwner: string;
  /**
   * GitHub repository name
   */
  readonly githubRepo: string;
  /**
   * Arn of the GitHub connection in AWS CodeConnections
   */
  readonly connectionArn: string;
  /**
   * The Dev account ID
   */
  readonly devAccountId: string;
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
 * CDK Pipeline for development deployments.
 * This pipeline deploys ONLY to Dev.
 * It is triggered from dev-* branches via CodePipeline V2 push triggers.
 *
 * This allows deploying feature branch changes instantly without a 2PR.
 *
 * `restartExecutionOnUpdate` is intentionally false: the self-mutation step updates the
 * pipeline via CloudFormation, and CloudFormation-triggered restarts have no push-event
 * context, so they fall back to the hardcoded 'master' BranchName and would overwrite the
 * dev deployment. Self-mutation still runs - it just won't auto-restart after applying.
 * Use the `dev-pipeline.yml` GitHub Actions workflow to manually re-trigger for a specific
 * branch after a stage is added or modified.
 */
export class DevelopmentPipelineStack extends cdk.Stack {
  public readonly pipeline: pipelines.CodePipeline;

  constructor(scope: Construct, id: string, props: DevelopmentPipelineStackProps) {
    super(scope, id, props);

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

    const underlyingPipeline = new codepipeline.Pipeline(this, 'UnderlyingPipelineDevelopment', {
      pipelineName: 'BergschachtDevelopmentPipeline',
      pipelineType: codepipeline.PipelineType.V2,
      artifactBucket,
      crossAccountKeys: false,
      // Prevent CloudFormation-triggered restarts (post self-mutation) from falling back to
      // the hardcoded 'master' BranchName and overwriting the active dev branch deployment.
      restartExecutionOnUpdate: false,
    });

    // Create the source - triggers are disabled here, we configure V2 triggers below
    const source = pipelines.CodePipelineSource.connection(
      `${props.githubOwner}/${props.githubRepo}`,
      'master', // This will be overridden below
      {
        connectionArn: props.connectionArn,
        triggerOnPush: false, // This will be overridden below
        actionName: 'GitHubSource', // Explicit action name for trigger reference
      }
    );

    // Create the CDK Pipeline, only deploy on non-master branches
    this.pipeline = new pipelines.CodePipeline(this, 'DevelopmentPipeline', {
      codePipeline: underlyingPipeline,
      synth: new pipelines.CodeBuildStep('Synth', {
        input: source,
        commands: [
          'npm install -g pnpm',
          'pnpm install --frozen-lockfile',
          'pnpm run build',
          'pnpx cdk synth',
        ],
        primaryOutputDirectory: 'cdk.out',
      }),
      codeBuildDefaults: PIPELINE_CODEBUILD_DEFAULTS,
      dockerEnabledForSynth: false,
      selfMutation: true,
    });

    // Deploy to Dev account only
    const devStage = new EnvironmentStage(this, 'Dev', {
      environment: 'dev',
      accountId: props.devAccountId,
      awsRegion: props.awsRegion,
      pagerDutyEmail: props.pagerDutyEmail,
      env: { account: props.devAccountId, region: props.awsRegion },
    });
    this.pipeline.addStage(devStage);

    // Build the pipeline to finalize the source action before configuring triggers
    this.pipeline.buildPipeline();

    // Configure V2 triggers to run on all branches EXCEPT master
    // Using CloudFormation escape hatch since CDK Pipelines manages the source action internally
    const cfnPipeline = underlyingPipeline.node.defaultChild as codepipeline.CfnPipeline;
    cfnPipeline.addPropertyOverride('Triggers', [
      {
        ProviderType: 'CodeStarSourceConnection',
        GitConfiguration: {
          SourceActionName: 'GitHubSource', // Must match the actionName in CodePipelineSource.connection
          Push: [
            {
              Branches: {
                Includes: ['dev-*'],
              },
            },
          ],
        },
      },
    ]);
    this.addNagSuppressions();
  }

  private addNagSuppressions(): void {
    // Suppress CDK Nag warnings for pipeline-managed resources
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
