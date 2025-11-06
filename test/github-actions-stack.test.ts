import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { GitHubActionsStack } from '../lib/github-actions-stack';

describe('GitHubActionsStack', () => {
  let app: cdk.App;
  let stack: GitHubActionsStack;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    stack = new GitHubActionsStack(app, 'TestGitHubActions', {
      githubOrg: 'Feuerstein-Org',
      githubRepo: 'bergschacht',
      githubBranch: 'master',
      deploysToCicdAccount: false,
      accountIds: [
        ['123456789012', 'Dev'],
        ['987654321098', 'Prod'],
      ],
    });
    template = Template.fromStack(stack);
  });

  test('creates IAM role with correct name', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'bergschacht-master-github-actions-role',
      Description: 'Role for GitHub Actions to deploy bergschacht-master CDK stacks',
    });
  });

  test('IAM role has correct trust policy for GitHub', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRoleWithWebIdentity',
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:Feuerstein-Org/bergschacht:ref:refs/heads/master',
              },
            },
            Effect: 'Allow',
          },
        ],
      },
    });
  });

  test('IAM role has permissions to assume CDK roles', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::123456789012:role/cdk-*',
          },
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::987654321098:role/cdk-*',
          },
        ],
      },
    });
  });

  test('creates CloudFormation outputs', () => {
    template.hasOutput('RoleArn', {
      Description: 'ARN of the IAM role for GitHub Actions',
      Export: {
        Name: 'TestGitHubActions-RoleArn',
      },
    });

    template.hasOutput('GitHubActionsAccountIds', {
      Description: 'AWS account IDs with permissions to deploy to',
      Export: {
        Name: 'TestGitHubActions-AccountIds',
      },
    });

    template.hasOutput('GitHubOIDCProviderArn', {
      Description: 'ARN of the GitHub OIDC provider',
      Export: {
        Name: 'TestGitHubActions-OIDCProviderArn',
      },
    });
  });

  test.each([
    ['no account IDs provided', [] as [string, string][]],
    ['empty account ID provided', [['', '']] as [string, string][]],
  ])('throws error when %s', (_description, accountIds) => {
    expect(() => {
      new GitHubActionsStack(app, 'Invalid', {
        githubOrg: 'Feuerstein-Org',
        githubRepo: 'bergschacht',
        githubBranch: 'master',
        accountIds,
      });
    }).toThrow('At least one accountId must be provided in accountIds');
  });

  test('IAM role has permissions to deploy to CI/CD account when deploysToCicdAccount is true', () => {
    const cicdApp = new cdk.App();
    const cicdStack = new GitHubActionsStack(cicdApp, 'TestCICDGitHubActions', {
      githubOrg: 'Feuerstein-Org',
      githubRepo: 'bergschacht',
      githubBranch: 'master',
      deploysToCicdAccount: true,
      accountIds: [['123456789012', 'Dev']],
    });
    const cicdTemplate = Template.fromStack(cicdStack);

    cicdTemplate.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: ['sts:AssumeRole', 'iam:PassRole'],
            Effect: 'Allow',
            Resource: {
              'Fn::Join': ['', ['arn:aws:iam::', { Ref: 'AWS::AccountId' }, ':role/cdk-*']],
            },
          },
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::123456789012:role/cdk-*',
          },
        ],
      },
    });
  });
});
