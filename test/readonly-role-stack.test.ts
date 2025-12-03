import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { ReadOnlyRoleStack } from '../lib/readonly-role-stack';

describe('ReadOnlyRoleStack', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const stack = new ReadOnlyRoleStack(app, 'TestReadOnlyRole', {
      trustedArns: ['arn:aws:iam::111111111111:root', 'arn:aws:iam::222222222222:user/SomeUser'],
    });
    template = Template.fromStack(stack);
  });

  test('works with multiple trusted ARNs', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              AWS: 'arn:aws:iam::111111111111:root',
            },
          },
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Principal: {
              AWS: 'arn:aws:iam::222222222222:user/SomeUser',
            },
          },
        ],
      },
    });
  });

  test('IAM role has AWS managed read-only policies attached', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: [
        {
          'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':iam::aws:policy/ReadOnlyAccess']],
        },
      ],
    });
  });

  test('creates CloudFormation outputs', () => {
    template.hasOutput('ReadOnlyRoleArn', {
      Description: 'ARN of the ReadOnly IAM role',
      Export: {
        Name: 'TestReadOnlyRole-RoleArn',
      },
    });

    template.hasOutput('TrustedArns', {
      Description: 'ARNs of principals trusted to assume this role',
      Export: {
        Name: 'TestReadOnlyRole-TrustedArns',
      },
    });
  });

  test('outputs trusted ARNs as comma-separated string', () => {
    const outputs = template.toJSON().Outputs;
    expect(outputs.TrustedArns.Value).toBe(
      'arn:aws:iam::111111111111:root, arn:aws:iam::222222222222:user/SomeUser'
    );
  });
});
