import * as cdk from 'aws-cdk-lib/core';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { CicdStage } from './stages/cicd-stage';
import { ApplicationRepo } from './constants';

export interface InfraPipelineStackProps extends cdk.StackProps {
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
 * CDK Pipeline for infrastructure deployments.
 * This pipeline deploys the CicdStage which contains all shared infrastructure:
 * KMS, ECR, Lambda artifacts, GitHub OIDC, logging, and cross-account
 * ReadOnlyRole for Dev and Prod.
 *
 * Application workloads (including per-environment SNS) are deployed by the ProductionPipelineStack.
 */
export class InfraPipelineStack extends cdk.Stack {
  public readonly pipeline: pipelines.CodePipeline;

  constructor(scope: Construct, id: string, props: InfraPipelineStackProps) {
    super(scope, id, props);

    const branch = props.branch ?? 'master';

    // Create the CodePipeline V2 pipeline
    const underlyingPipeline = new codepipeline.Pipeline(this, 'UnderlyingPipelineInfra', {
      pipelineName: 'BergschachtInfraPipeline',
      pipelineType: codepipeline.PipelineType.V2,
      // Cross-account keys are required for cross-account deployments
      // Potentially we want to reuse the same key we use for other CICD resources
      crossAccountKeys: true,
      restartExecutionOnUpdate: true,
    });

    // Create the CDK Pipeline with CodeStar connection source
    this.pipeline = new pipelines.CodePipeline(this, 'InfraPipeline', {
      codePipeline: underlyingPipeline,
      synth: new pipelines.ShellStep('Synth', {
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
          'pnpx cdk synth',
        ],
        primaryOutputDirectory: 'cdk.out',
      }),
      dockerEnabledForSynth: false,
      selfMutation: true,
    });

    const cicdStage = new CicdStage(this, 'Cicd', {
      cicdAccountId: props.cicdAccountId,
      devAccountId: props.devAccountId,
      prodAccountId: props.prodAccountId,
      awsRegion: props.awsRegion,
      pagerDutyEmail: props.pagerDutyEmail,
      applicationRepos: props.applicationRepos,
      env: { account: props.cicdAccountId, region: props.awsRegion },
    });
    this.pipeline.addStage(cicdStage);

    // Add CDK Nag suppressions for pipeline resources
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
