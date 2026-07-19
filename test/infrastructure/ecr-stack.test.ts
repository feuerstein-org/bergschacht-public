import * as cdk from 'aws-cdk-lib/core';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { EcrStack } from '../../lib/infrastructure/ecr-stack';

const TEST_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:111111111111:key/test-key-id';

describe('EcrStack', () => {
  let stack: EcrStack;
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    stack = new EcrStack(app, 'TestEcr', {
      repositoryName: 'test-repository',
      encryptionKeyArn: TEST_KMS_KEY_ARN,
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
        LifecyclePolicyText: Match.stringLikeRegexp('.*imageCountMoreThan.*countNumber.*30.*'),
      },
    });
  });

  test('enables encryption with the provided KMS key', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      EncryptionConfiguration: {
        EncryptionType: 'KMS',
        KmsKey: TEST_KMS_KEY_ARN,
      },
    });
  });

  test('does not create exclusion filter when mutableTagWildcard is not provided', () => {
    template.hasResourceProperties('AWS::ECR::Repository', {
      ImageTagMutabilityExclusionFilters: Match.absent(),
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

  describe('with mutableTagWildcard', () => {
    let templateWithMutableTag: Template;

    beforeEach(() => {
      const app = new cdk.App();
      const stack = new EcrStack(app, 'TestEcrMutableTag', {
        repositoryName: 'test-repository',
        mutableTagWildcard: '*latest',
        encryptionKeyArn: TEST_KMS_KEY_ARN,
      });
      templateWithMutableTag = Template.fromStack(stack);
    });

    test('creates ECR repository with IMMUTABLE_WITH_EXCLUSION when mutableTagWildcard is provided', () => {
      templateWithMutableTag.hasResourceProperties('AWS::ECR::Repository', {
        ImageTagMutability: 'IMMUTABLE_WITH_EXCLUSION',
        ImageTagMutabilityExclusionFilters: [
          {
            ImageTagMutabilityExclusionFilterType: 'WILDCARD',
            ImageTagMutabilityExclusionFilterValue: '*latest',
          },
        ],
      });
    });
  });

  describe('with cross-account pull permissions', () => {
    let templateWithCrossAccount: Template;

    beforeEach(() => {
      const app = new cdk.App();
      const stack = new EcrStack(app, 'TestEcrCrossAccount', {
        repositoryName: 'test-repository',
        allowedPullAccountIds: ['11111111111', '222222222222'],
        encryptionKeyArn: TEST_KMS_KEY_ARN,
      });
      templateWithCrossAccount = Template.fromStack(stack);
    });

    test('creates repository policy with cross-account pull permissions for specified accounts', () => {
      templateWithCrossAccount.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryPolicyText: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowCrossAccountPull',
              Effect: 'Allow',
              Action: [
                'ecr:GetDownloadUrlForLayer',
                'ecr:BatchGetImage',
                'ecr:BatchCheckLayerAvailability',
              ],
              Principal: {
                AWS: Match.arrayWith([
                  Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                      Match.arrayWith([Match.stringLikeRegexp('.*11111111111')]),
                    ]),
                  }),
                  Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                      Match.arrayWith([Match.stringLikeRegexp('.*222222222222')]),
                    ]),
                  }),
                ]),
              },
            }),
          ]),
        },
      });
    });

    test('grants the Lambda service principal cross-account pull scoped by source function ARN', () => {
      templateWithCrossAccount.hasResourceProperties('AWS::ECR::Repository', {
        RepositoryPolicyText: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowCrossAccountLambdaPull',
              Effect: 'Allow',
              Action: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
              Principal: {
                Service: 'lambda.amazonaws.com',
              },
              Condition: {
                StringLike: {
                  // region renders as a Ref token, so each sourceArn is an Fn::Join
                  'aws:sourceArn': Match.arrayWith([
                    Match.objectLike({
                      'Fn::Join': Match.arrayWith([
                        Match.arrayWith([Match.stringLikeRegexp('.*11111111111:function:\\*')]),
                      ]),
                    }),
                    Match.objectLike({
                      'Fn::Join': Match.arrayWith([
                        Match.arrayWith([Match.stringLikeRegexp('.*222222222222:function:\\*')]),
                      ]),
                    }),
                  ]),
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
        encryptionKeyArn: TEST_KMS_KEY_ARN,
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
