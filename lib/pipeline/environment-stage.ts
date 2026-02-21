import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { SnsPagerDutyStack } from '../infrastructure/sns-pager-duty';

export interface EnvironmentStageProps extends cdk.StageProps {
  /**
   * The target account ID for this environment
   */
  readonly accountId: string;
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
 * Stage containing application workload stacks for a given environment.
 * These are stacks that consume the version manifest (ECS services, Lambda functions, etc.)
 * and change frequently with every application deployment.
 *
 * Used by both the Production Pipeline (prod) and the Development Pipeline (dev branches).
 * Infrastructure stacks (ReadOnlyRole, KMS, ECR, etc.) live in CicdStage.
 */
export class EnvironmentStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: EnvironmentStageProps) {
    super(scope, id, props);

    cdk.Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    new SnsPagerDutyStack(this, 'SnsPagerDuty', {
      topicName: `PagerDutyAlerts${id}`,
      emailAddress: props.pagerDutyEmail,
      env: { account: props.accountId, region: props.awsRegion },
    });
  }
}
