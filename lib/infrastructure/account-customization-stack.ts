import * as cdk from 'aws-cdk-lib/core';
import * as uxc from 'aws-cdk-lib/aws-uxc';
import { Construct } from 'constructs';

export interface AccountCustomizationStackProps extends cdk.StackProps {
  /**
   * Color shown in the AWS Console navigation bar for this account.
   */
  readonly accountColor: string;
  /**
   * Regions listed in the AWS Console region selector.
   */
  readonly visibleRegions: string[];
}

/**
 * CDK Stack that sets the account-level AWS Console display settings.
 *
 * This changes only what the Console shows. It does not block API access to hidden regions.
 */
export class AccountCustomizationStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: AccountCustomizationStackProps) {
    super(scope, id, props);

    new uxc.CfnAccountCustomization(this, 'AccountCustomization', {
      accountColor: props.accountColor,
      visibleRegions: props.visibleRegions,
    });
  }
}
