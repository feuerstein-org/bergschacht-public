import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ReadOnlyRoleStack } from '../readonly-role-stack';
import { SnsPagerDutyStack } from '../sns-pager-duty';

export interface DevStageProps extends cdk.StageProps {
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
 * Stage containing all infrastructure stacks for Dev.
 */
export class DevStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: DevStageProps) {
    super(scope, id, props);

    const { cicdAccountId, devAccountId, awsRegion, pagerDutyEmail } = props;

    // ReadOnly Role Stack for Dev account
    new ReadOnlyRoleStack(this, 'ReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: devAccountId, region: awsRegion },
    });

    // SNS PagerDuty Stack for Dev account
    new SnsPagerDutyStack(this, 'SnsPagerDuty', {
      topicName: 'PagerDutyAlertsDev',
      emailAddress: pagerDutyEmail,
      env: { account: devAccountId, region: awsRegion },
    });
  }
}
