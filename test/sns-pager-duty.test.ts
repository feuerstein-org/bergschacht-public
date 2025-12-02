import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { SnsPagerDutyStack } from '../lib/sns-pager-duty';

describe('SnsPagerDutyStack', () => {
  let app: cdk.App;
  let stack: SnsPagerDutyStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new SnsPagerDutyStack(app, 'TestSnsPagerDuty', {
      topicName: 'TestPagerDutyAlerts',
      emailAddress: 'test-alerts@example.com',
    });
    template = Template.fromStack(stack);
  });

  test('creates SNS topic with correct name', () => {
    template.hasResourceProperties('AWS::SNS::Topic', {
      TopicName: 'TestPagerDutyAlerts',
      DisplayName: 'PagerDuty Alerts Topic',
    });
  });

  test('enforces SSL on SNS topic', () => {
    template.hasResourceProperties('AWS::SNS::TopicPolicy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'sns:Publish',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
            Effect: 'Deny',
            Principal: '*',
            Sid: 'AllowPublishThroughSSLOnly',
          },
        ],
      },
    });
  });

  test('creates email subscription', () => {
    template.hasResourceProperties('AWS::SNS::Subscription', {
      Protocol: 'email',
      Endpoint: 'test-alerts@example.com',
    });
  });

  test('outputs topic ARN', () => {
    template.hasOutput('TopicArn', {
      Description: 'SNS Topic ARN for PagerDuty alerts',
    });
  });

  test('outputs email subscription', () => {
    template.hasOutput('EmailSubscription', {
      Description: 'Email address subscribed to PagerDuty SNS topic',
      Value: 'test-alerts@example.com',
    });
  });
});
