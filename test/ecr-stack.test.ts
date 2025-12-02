import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EcrStack } from '../lib/ecr-stack';

describe('EcrStack', () => {
  let app: cdk.App;
  let stack: EcrStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new EcrStack(app, 'TestEcr', {
      repositoryName: 'test-repository',
    });
    template = Template.fromStack(stack);
  });

  test('creates ECR repository with correct name', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryName: 'test-repository',
      ImageTagMutability: 'IMMUTABLE',
      ImageScanningConfiguration: {
        ScanOnPush: true,
      },
      LifecyclePolicy: {
        LifecyclePolicyText: Match.stringLikeRegexp('.*imageCountMoreThan.*countNumber.*10.*'),
      },
    });
  });

  test('does not create EventBridge rule since no notification topic is provided', () => {
    template.resourceCountIs('AWS::Events::Rule', 0);
  });

  test('creates CloudFormation outputs', () => {
    template.hasOutput('RepositoryUri', {
      Description: 'ECR Repository URI',
    });

    template.hasOutput('RepositoryArn', {
      Description: 'ECR Repository ARN',
    });
  });

  test('exports the repository for use in other stacks', () => {
    expect(stack.repository).toBeDefined();
  });

  describe('with notification topic', () => {
    let stackWithNotifications: EcrStack;
    let templateWithNotifications: Template;
    let topicStack: cdk.Stack;
    let topic: sns.Topic;

    beforeEach(() => {
      const notificationApp = new cdk.App();
      topicStack = new cdk.Stack(notificationApp, 'Topic');
      topic = new sns.Topic(topicStack, 'TestTopic', {
        topicName: 'test-topic',
      });
      stackWithNotifications = new EcrStack(notificationApp, 'TestEcrWithNotifications', {
        repositoryName: 'test-repository',
        notificationTopic: topic,
      });
      templateWithNotifications = Template.fromStack(stackWithNotifications);
    });

    test('creates EventBridge rule for image scan findings', () => {
      templateWithNotifications.hasResourceProperties('AWS::Events::Rule', {
        Description: Match.stringLikeRegexp('.*test-repository.*'),
        EventPattern: {
          source: ['aws.ecr'],
          'detail-type': ['ECR Image Scan'],
          detail: {
            'repository-name': ['test-repository'],
            'scan-status': ['COMPLETE'],
            'finding-severity-counts': {
              $or: [
                {
                  CRITICAL: [{ exists: true }],
                },
                {
                  MEDIUM: [{ exists: true }],
                },
              ],
            },
          },
        },
        State: 'ENABLED',
      });
    });

    test('configures EventBridge rule with SNS topic as target', () => {
      templateWithNotifications.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: stackWithNotifications.resolve(topic.topicArn),
          }),
        ]),
      });
    });

    test('creates CloudFormation output for scan notification rule', () => {
      templateWithNotifications.hasOutput('ScanNotificationRuleArn', {
        Description: 'EventBridge rule ARN for ECR scan notifications',
      });
    });
  });
});
