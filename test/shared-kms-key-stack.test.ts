import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { SharedKmsKeyStack } from '../lib/shared-kms-key-stack';

describe('SharedKmsKeyStack', () => {
  let stack: SharedKmsKeyStack;
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    stack = new SharedKmsKeyStack(app, 'TestSharedKmsKey', {
      description: 'Test shared KMS key',
      allowedDecryptAccountIds: ['123456789012', '210987654321'],
    });
    template = Template.fromStack(stack);
  });

  test('creates KMS key with correct properties', () => {
    template.resourceCountIs('AWS::KMS::Key', 1);
    template.hasResourceProperties('AWS::KMS::Key', {
      Description: 'Test shared KMS key',
      EnableKeyRotation: true,
    });
  });

  test('sets retention policy to RETAIN', () => {
    template.hasResource('AWS::KMS::Key', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  test('grants decrypt permissions to specified accounts', () => {
    template.hasResourceProperties('AWS::KMS::Key', {
      KeyPolicy: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowDecryptFromAccounts',
            Effect: 'Allow',
            Principal: {
              AWS: Match.arrayWith([
                Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp('.*123456789012')]),
                  ]),
                }),
                Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp('.*210987654321')]),
                  ]),
                }),
              ]),
            },
            Action: ['kms:Decrypt', 'kms:DescribeKey'],
          }),
        ]),
      },
    });
  });

  test('creates CloudFormation outputs for key ID and ARN', () => {
    template.hasOutput('KeyId', {
      Description: 'KMS Key ID',
    });

    template.hasOutput('KeyArn', {
      Description: 'KMS Key ARN',
    });
  });

  test('exports the key for use in other stacks', () => {
    expect(stack.key).toBeDefined();
  });

  describe('without allowed account IDs', () => {
    let templateWithoutAccounts: Template;

    beforeEach(() => {
      const app = new cdk.App();
      const stack = new SharedKmsKeyStack(app, 'TestSharedKmsKeyNoAccounts', {
        description: 'Test shared KMS key without accounts',
      });
      templateWithoutAccounts = Template.fromStack(stack);
    });

    test('does not create cross-account decrypt policy when allowedDecryptAccountIds is not provided', () => {
      templateWithoutAccounts.hasResourceProperties('AWS::KMS::Key', {
        KeyPolicy: {
          Statement: Match.not(
            Match.arrayWith([
              Match.objectLike({
                Effect: 'Allow',
                Action: Match.arrayWith(['kms:Decrypt', 'kms:DescribeKey']),
                Principal: {
                  AWS: Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                      Match.arrayWith([Match.stringLikeRegexp('arn:.*:iam::[0-9]+:root')]),
                    ]),
                  }),
                },
              }),
            ])
          ),
        },
      });
    });
  });
});
