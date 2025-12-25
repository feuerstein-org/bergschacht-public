import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import { ReadOnlyRoleStack } from '../readonly-role-stack';
import { SnsPagerDutyStack } from '../sns-pager-duty';

export interface ProdStageProps extends cdk.StageProps {
  /**
   * The CICD account ID
   */
  readonly cicdAccountId: string;
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
 * Stage containing all infrastructure stacks for Prod.
 */
export class ProdStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: ProdStageProps) {
    super(scope, id, props);

    const { cicdAccountId, prodAccountId, awsRegion, pagerDutyEmail } = props;

    // ReadOnly Role Stack for Prod
    new ReadOnlyRoleStack(this, 'ReadOnlyRole', {
      trustedArns: [cicdAccountId],
      env: { account: prodAccountId, region: awsRegion },
    });

    // SNS PagerDuty Stack for Prod
    new SnsPagerDutyStack(this, 'SnsPagerDuty', {
      topicName: 'PagerDutyAlertsProd',
      emailAddress: pagerDutyEmail,
      env: { account: prodAccountId, region: awsRegion },
    });
  }
}
