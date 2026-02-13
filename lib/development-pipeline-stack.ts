import * as cdk from 'aws-cdk-lib/core';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import { Construct } from 'constructs';
import { NagSuppressions } from 'cdk-nag';
import { DevStage } from './stages/dev-stage';

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
   * The CICD account ID
   */
  readonly cicdAccountId: string;
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
}

/**
 * CDK Pipeline for development deployments.
 * This pipeline deploys ONLY to Dev.
 * It is triggered from ALL branches EXCEPT master (feature branches) of the Github repo.
 *
 * This allows deploying test changes instantly without a 2PR.
 */
export class DevelopmentPipelineStack extends cdk.Stack {
  public readonly pipeline: pipelines.CodePipeline;

  constructor(scope: Construct, id: string, props: DevelopmentPipelineStackProps) {
    super(scope, id, props);

    // Create the CodePipeline V2 pipeline
    const underlyingPipeline = new codepipeline.Pipeline(this, 'UnderlyingPipelineDevelopment', {
      pipelineName: 'BergschachtDevelopmentPipeline',
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: true, // Required for cross-account deployments
      restartExecutionOnUpdate: true,
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
      synth: new pipelines.ShellStep('Synth', {
        input: source,
        commands: [
          'npm install -g pnpm',
          'pnpm install --frozen-lockfile',
          'pnpm run build',
          'pnpx cdk synth',
        ],
        primaryOutputDirectory: 'cdk.out',
      }),
      dockerEnabledForSynth: false,
      selfMutation: true,
    });

    // Deploy to Dev account only
    const devStage = new DevStage(this, 'Dev', {
      cicdAccountId: props.cicdAccountId,
      devAccountId: props.devAccountId,
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
