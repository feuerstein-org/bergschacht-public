import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as subscriptions from 'aws-cdk-lib/aws-sns-subscriptions';
import { Construct } from 'constructs';

export interface SnsPagerDutyProps extends cdk.StackProps {
  /**
   * The name of the SNS topic
   * @example 'PagerDutyAlerts'
   */
  readonly topicName: string;
  /**
   * The email address to subscribe to the topic for PagerDuty integration
   * @example 'alerts@example.com'
   */
  readonly emailAddress: string;
}

/**
 * CDK Stack that creates an SNS topic for PagerDuty alerts.
 * Currently alerts are sent via email integration.
 */
export class SnsPagerDutyStack extends cdk.Stack {
  public readonly topic: sns.ITopic;

  constructor(scope: Construct, id: string, props: SnsPagerDutyProps) {
    super(scope, id, props);

    // Create SNS topic
    this.topic = new sns.Topic(this, 'PagerDutyTopic', {
      topicName: props.topicName,
      displayName: 'PagerDuty Alerts Topic',
      enforceSSL: true,
    });

    this.topic.addSubscription(new subscriptions.EmailSubscription(props.emailAddress));

    // Re-add default policy since setting enforceSSL above removes it
    this.topic.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'AllowOwnerAccountPublishing',
        effect: iam.Effect.ALLOW,
        principals: [new iam.AnyPrincipal()],
        actions: ['sns:Publish'],
        resources: [this.topic.topicArn],
        conditions: { StringEquals: { 'AWS:SourceOwner': this.account } },
      })
    );

    new cdk.CfnOutput(this, 'TopicArn', {
      value: this.topic.topicArn,
      description: 'SNS Topic ARN for PagerDuty alerts',
    });
    new cdk.CfnOutput(this, 'EmailSubscription', {
      value: props.emailAddress,
      description: 'Email address subscribed to PagerDuty SNS topic',
    });
  }
}
