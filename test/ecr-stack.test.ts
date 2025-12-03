import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EcrStack } from '../lib/ecr-stack';

describe('EcrStack', () => {
  let stack: EcrStack;
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    stack = new EcrStack(app, 'TestEcr', {
      repositoryName: 'test-repository',
    });
    template = Template.fromStack(stack);
  });

  test('creates ECR repository with correct name and properties', () => {
    template.resourceCountIs('AWS::ECR::Repository', 1);
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

  test('does not create policy if no cross-account pull permissions are specified', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      RepositoryPolicyText: Match.absent(),
    });
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

  describe('with cross-account pull permissions', () => {
    let templateWithCrossAccount: Template;

    beforeEach(() => {
      const app = new cdk.App();
      const stack = new EcrStack(app, 'TestEcrCrossAccount', {
        repositoryName: 'test-repository',
        allowedPullAccountIds: ['11111111111', '222222222222'],
      });
      templateWithCrossAccount = Template.fromStack(stack);
    });

    test('creates repository policy with cross-account pull permissions for specified accounts', () => {
      templateWithCrossAccount.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryPolicyText: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
              ],
              Principal: {
                AWS: {
                  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::11111111111:root']],
                },
              },
            }),
            Match.objectLike({
              Effect: 'Allow',
              Action: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
              ],
              Principal: {
                AWS: {
                  'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::222222222222:root']],
                },
              },
            }),
          ]),
        },
      });
    });
  });

  describe('with notification topic', () => {
    let stackWithNotifications: EcrStack;
    let templateWithNotifications: Template;
    let topic: sns.Topic;

    beforeEach(() => {
      const notificationApp = new cdk.App();
      const topicStack = new cdk.Stack(notificationApp, 'Topic');
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
                  HIGH: [{ exists: true }],
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
