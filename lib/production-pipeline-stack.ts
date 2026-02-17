import * as cdk from 'aws-cdk-lib/core';
import * as pipelines from 'aws-cdk-lib/pipelines';
import * as codepipeline from 'aws-cdk-lib/aws-codepipeline';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { EnvironmentStage } from './stages/environment-stage';

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
}

/**
 * CDK Pipeline for production application deployments.
 * This pipeline deploys application workloads (ECS services, Lambda functions, etc.)
 * that consume the version manifest. It deploys to Dev -> Prod only (no CICD stage needed).
 *
 * Triggered by GitHub Actions when version-manifests/ or application stage code changes.
 * Infrastructure changes (KMS, ECR, OIDC, etc.) are handled by InfraPipelineStack.
 */
export class ProductionPipelineStack extends cdk.Stack {
  public readonly pipeline: pipelines.CodePipeline;

  constructor(scope: Construct, id: string, props: ProductionPipelineStackProps) {
    super(scope, id, props);

    const branch = props.branch ?? 'master';

    const underlyingPipeline = new codepipeline.Pipeline(this, 'UnderlyingPipelineProduction', {
      pipelineName: 'BergschachtProductionPipeline',
      pipelineType: codepipeline.PipelineType.V2,
      crossAccountKeys: true,
      restartExecutionOnUpdate: true,
    });

    this.pipeline = new pipelines.CodePipeline(this, 'ProductionPipeline', {
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

    const devStage = new EnvironmentStage(this, 'Dev', {
      accountId: props.devAccountId,
      awsRegion: props.awsRegion,
      pagerDutyEmail: props.pagerDutyEmail,
      env: { account: props.devAccountId, region: props.awsRegion },
    });
    this.pipeline.addStage(devStage);

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
