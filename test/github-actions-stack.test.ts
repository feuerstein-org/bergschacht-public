import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { IOpenIdConnectProvider } from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
import { GitHubActionsStack } from '../lib/github-actions-stack';
import { GitHubOIDCProviderStack } from '../lib/github-oidc-provider-stack';

describe('GitHubActionsStack', () => {
  let app: cdk.App;
  let oidcProvider: IOpenIdConnectProvider;
  let template: Template;

  beforeEach(() => {
    app = new cdk.App();
    const oidcStack = new GitHubOIDCProviderStack(app, 'TestOIDCProvider');
    oidcProvider = oidcStack.provider;

    const stack = new GitHubActionsStack(app, 'TestGitHubActions', {
      githubOrg: 'feuerstein-org',
      githubRepo: 'bergschacht',
      githubBranch: 'master',
      githubOidcProvider: oidcProvider,
      deployAccountIds: [
        ['111111111111', 'Dev'],
        ['222222222222', 'Prod'],
      ],
      lookupAccountIds: [
        ['111111111111', 'Dev'],
        ['222222222222', 'Prod'],
        ['333333333333', 'Cicd'],
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
                  'repo:feuerstein-org/bergschacht:ref:refs/heads/master',
              },
            },
            Effect: 'Allow',
          },
        ],
      },
    });
  });

  test('IAM role has permissions to assume CDK roles and lookup roles', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::111111111111:role/cdk-*',
            Sid: 'AllowAssumeDeploymentRoleInDevAccount',
          },
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::222222222222:role/cdk-*',
            Sid: 'AllowAssumeDeploymentRoleInProdAccount',
          },
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::111111111111:role/cdk-*-lookup-role-*',
            Sid: 'AllowAssumeLookupRoleInDevAccount',
          },
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::222222222222:role/cdk-*-lookup-role-*',
            Sid: 'AllowAssumeLookupRoleInProdAccount',
          },
          {
            Action: 'sts:AssumeRole',
            Effect: 'Allow',
            Resource: 'arn:aws:iam::333333333333:role/cdk-*-lookup-role-*',
            Sid: 'AllowAssumeLookupRoleInCicdAccount',
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

    template.hasOutput('GitHubActionsDeployAccountIds', {
      Description: 'AWS account IDs with permissions to deploy to',
      Export: {
        Name: 'TestGitHubActions-DeployAccountIds',
      },
    });

    template.hasOutput('GitHubActionsLookupAccountIds', {
      Description: 'AWS account IDs with permissions to lookup',
      Export: {
        Name: 'TestGitHubActions-LookupAccountIds',
      },
    });
  });

  test.each([
    [
      'no account IDs provided',
      {},
      'At least one account must be provided in deployAccountIds or lookupAccountIds, or additionalPolicies must be provided',
    ],
    [
      'empty deploy account ID provided',
      { deployAccountIds: [['', '']] as [string, string][] },
      undefined,
    ],
    [
      'empty lookup account ID provided',
      { lookupAccountIds: [['', '']] as [string, string][] },
      undefined,
    ],
  ])('throws error when %s', (_description, accountProps, expectedError) => {
    if (expectedError) {
      expect(() => {
        new GitHubActionsStack(app, 'Invalid', {
          githubOrg: 'feuerstein-org',
          githubRepo: 'bergschacht',
          githubBranch: 'master',
          githubOidcProvider: oidcProvider,
          ...accountProps,
        });
      }).toThrow(expectedError);
    } else {
      // Should not throw for empty string account IDs (will just create empty policy)
      expect(() => {
        new GitHubActionsStack(app, 'Invalid', {
          githubOrg: 'feuerstein-org',
          githubRepo: 'bergschacht',
          githubBranch: 'master',
          githubOidcProvider: oidcProvider,
          ...accountProps,
        });
      }).not.toThrow();
    }
  });

  describe('when no branch is specified', () => {
    let noBranchApp: cdk.App;
    let noBranchOidcProvider: IOpenIdConnectProvider;
    let noBranchStack: GitHubActionsStack;
    let noBranchTemplate: Template;

    beforeEach(() => {
      noBranchApp = new cdk.App();
      const oidcStack = new GitHubOIDCProviderStack(noBranchApp, 'TestOIDCProviderNoBranch');
      noBranchOidcProvider = oidcStack.provider;

      noBranchStack = new GitHubActionsStack(noBranchApp, 'TestGitHubActionsNoBranch', {
        githubOrg: 'feuerstein-org',
        githubRepo: 'bergschacht',
        githubOidcProvider: noBranchOidcProvider,
        deployAccountIds: [['111111111111', 'Dev']],
      });
      noBranchTemplate = Template.fromStack(noBranchStack);
    });

    test('IAM role has correct trust policy allowing entire repository', () => {
      noBranchTemplate.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                },
                StringLike: {
                  'token.actions.githubusercontent.com:sub': ['repo:feuerstein-org/bergschacht:*'],
                },
              },
              Effect: 'Allow',
            },
          ],
        },
      });
    });

    test('IAM role has correct permissions to assume CDK roles', () => {
      noBranchTemplate.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRole',
              Effect: 'Allow',
              Resource: 'arn:aws:iam::111111111111:role/cdk-*',
              Sid: 'AllowAssumeDeploymentRoleInDevAccount',
            },
          ],
        },
      });
    });
  });

  describe('when additionalPolicies are provided', () => {
    let policyTemplate: Template;

    beforeEach(() => {
      const policyApp = new cdk.App();
      const oidcStack = new GitHubOIDCProviderStack(policyApp, 'TestOIDCProviderPolicy');
      const policyOidcProvider = oidcStack.provider;

      const stack = new GitHubActionsStack(policyApp, 'TestGitHubActionsPolicy', {
        githubOrg: 'other-org',
        githubRepo: 'other-repo',
        githubBranch: 'master',
        githubOidcProvider: policyOidcProvider,
        additionalPolicies: [
          new iam.PolicyStatement({
            sid: 'AllowEcrAuth',
            effect: iam.Effect.ALLOW,
            actions: ['ecr:GetAuthorizationToken'],
            resources: ['*'],
          }),
          new iam.PolicyStatement({
            sid: 'AllowEcrPush',
            effect: iam.Effect.ALLOW,
            actions: [
              'ecr:BatchCheckLayerAvailability',
              'ecr:PutImage',
              'ecr:InitiateLayerUpload',
              'ecr:UploadLayerPart',
              'ecr:CompleteLayerUpload',
              'ecr:GetDownloadUrlForLayer',
            ],
            resources: ['arn:aws:ecr:us-east-1:123456789012:repository/my-repo'],
          }),
        ],
      });
      policyTemplate = Template.fromStack(stack);
    });

    test('creates IAM role with correct name', () => {
      policyTemplate.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'other-repo-master-github-actions-role',
      });
    });

    test('IAM role has additional policy statements', () => {
      policyTemplate.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: [
            {
              Action: 'ecr:GetAuthorizationToken',
              Effect: 'Allow',
              Resource: '*',
              Sid: 'AllowEcrAuth',
            },
            {
              Action: [
                'ecr:BatchCheckLayerAvailability',
                'ecr:PutImage',
                'ecr:InitiateLayerUpload',
                'ecr:UploadLayerPart',
                'ecr:CompleteLayerUpload',
                'ecr:GetDownloadUrlForLayer',
              ],
              Effect: 'Allow',
              Resource: 'arn:aws:ecr:us-east-1:123456789012:repository/my-repo',
              Sid: 'AllowEcrPush',
            },
          ],
        },
      });
    });
  });

  describe('when githubTag is specified', () => {
    let tagTemplate: Template;

    beforeEach(() => {
      const tagApp = new cdk.App();
      const oidcStack = new GitHubOIDCProviderStack(tagApp, 'TestOIDCProviderTag');
      const tagOidcProvider = oidcStack.provider;

      const stack = new GitHubActionsStack(tagApp, 'TestGitHubActionsTag', {
        githubOrg: 'feuerstein-org',
        githubRepo: 'bergschacht',
        githubTag: 'v*',
        githubOidcProvider: tagOidcProvider,
        deployAccountIds: [['111111111111', 'Dev']],
      });
      tagTemplate = Template.fromStack(stack);
    });

    test('IAM role has correct name with tag suffix', () => {
      tagTemplate.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'bergschacht-tag-vx-github-actions-role',
      });
    });

    test('IAM role has correct trust policy for tag pattern', () => {
      tagTemplate.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                },
                StringLike: {
                  'token.actions.githubusercontent.com:sub': [
                    'repo:feuerstein-org/bergschacht:ref:refs/tags/v*',
                  ],
                },
              },
              Effect: 'Allow',
            },
          ],
        },
      });
    });
  });

  describe('when both githubBranch and githubTag are specified', () => {
    let bothApp: cdk.App;
    let bothOidcProvider: IOpenIdConnectProvider;
    let bothTemplate: Template;

    beforeEach(() => {
      bothApp = new cdk.App();
      const oidcStack = new GitHubOIDCProviderStack(bothApp, 'TestOIDCProviderBoth');
      bothOidcProvider = oidcStack.provider;

      const stack = new GitHubActionsStack(bothApp, 'TestGitHubActionsBoth', {
        githubOrg: 'feuerstein-org',
        githubRepo: 'bergschacht',
        githubBranch: 'master',
        githubTag: 'v*',
        githubOidcProvider: bothOidcProvider,
        deployAccountIds: [['111111111111', 'Dev']],
      });
      bothTemplate = Template.fromStack(stack);
    });

    test('IAM role has correct name with both branch and tag suffix', () => {
      bothTemplate.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'bergschacht-master-tag-vx-github-actions-role',
      });
    });

    test('IAM role has correct trust policy allowing both branch and tag', () => {
      bothTemplate.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: [
            {
              Action: 'sts:AssumeRoleWithWebIdentity',
              Condition: {
                StringEquals: {
                  'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                },
                StringLike: {
                  'token.actions.githubusercontent.com:sub': [
                    'repo:feuerstein-org/bergschacht:ref:refs/heads/master',
                    'repo:feuerstein-org/bergschacht:ref:refs/tags/v*',
                  ],
                },
              },
              Effect: 'Allow',
            },
          ],
        },
      });
    });
  });
});
