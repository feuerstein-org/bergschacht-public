import * as cdk from 'aws-cdk-lib/core';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { GitHubOIDCProviderStack } from '../lib/github-oidc-provider-stack';
import { createApplicationRepoGitHubActions } from '../lib/application-repo-github-actions-stack';

const TEST_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:111111111111:key/test-key-id';

describe('createApplicationRepoGitHubActions', () => {
  let app: cdk.App;
  let template: Template;

  const testEnv = { account: '111111111111', region: 'us-east-1' };

  beforeEach(() => {
    app = new cdk.App();
    const oidcStack = new GitHubOIDCProviderStack(app, 'OIDCProvider', { env: testEnv });
    const sharedStack = new cdk.Stack(app, 'Shared', { env: testEnv });
    const bucket = new s3.Bucket(sharedStack, 'TestBucket', {
      bucketName: 'example-lambda-artifacts',
    });
    const repository = new ecr.Repository(sharedStack, 'TestRepo', {
      repositoryName: 'feuerstein',
    });

    const stack = createApplicationRepoGitHubActions(app, {
      appRepo: {
        org: 'feuerstein-org',
        repo: 'sample-python-repo',
        environment: 'prod',
      },
      githubOidcProvider: oidcStack.provider,
      cicdAccountId: '111111111111',
      awsRegion: 'us-east-1',
      ecrRepository: repository,
      lambdaArtifactsBucket: bucket,
      deploymentResourcesKmsKeyArn: TEST_KMS_KEY_ARN,
    });

    template = Template.fromStack(stack);
  });

  test('creates IAM role with correct name derived from repo', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'sample-python-repo-prod-github-actions-role',
    });
  });

  test('trust policy uses correct GitHub OIDC subject', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      AssumeRolePolicyDocument: {
        Statement: [
          {
            Condition: {
              StringEquals: {
                'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
                'token.actions.githubusercontent.com:sub':
                  'repo:feuerstein-org/sample-python-repo:environment:prod',
              },
            },
            Effect: 'Allow',
          },
        ],
      },
    });
  });

  test('grants ECR auth and push permissions', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'ecr:GetAuthorizationToken',
            Effect: 'Allow',
            Resource: '*',
            Sid: 'AllowEcrAuth',
          }),
          Match.objectLike({
            Action: Match.arrayWith(['ecr:PutImage', 'ecr:InitiateLayerUpload']),
            Effect: 'Allow',
            Sid: 'AllowEcrPush',
          }),
        ]),
      },
    });
  });

  test('S3 ListBucket is scoped to the app prefix', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:ListBucket',
            Effect: 'Allow',
            Condition: {
              StringLike: {
                's3:prefix': ['sample-python-repo/*'],
              },
            },
            Sid: 'AllowS3ListOwnPrefix',
          }),
        ]),
      },
    });
  });

  test('S3 PutObject/GetObject is scoped to the app prefix', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['s3:PutObject', 's3:GetObject', 's3:HeadObject'],
            Effect: 'Allow',
            Sid: 'AllowS3ReadWriteOwnPrefix',
          }),
        ]),
      },
    });
  });

  test('grants KMS permissions for the deployment resources key', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'AllowKmsForDeploymentResources',
            Effect: 'Allow',
            Action: ['kms:Encrypt', 'kms:Decrypt', 'kms:GenerateDataKey*'],
          }),
        ]),
      },
    });
  });

  test('stack id is PascalCase of repo name', () => {
    // The stack should have been created with id 'MyAppGitHubActions'
    const testApp = new cdk.App();
    const env = { account: '222222222222', region: 'us-east-1' };
    const shared = new cdk.Stack(testApp, 'Shared', { env });
    const stack = createApplicationRepoGitHubActions(testApp, {
      appRepo: {
        org: 'feuerstein-org',
        repo: 'my-app',
        environment: 'prod',
      },
      githubOidcProvider: new GitHubOIDCProviderStack(testApp, 'OIDC2', { env }).provider,
      cicdAccountId: '222222222222',
      awsRegion: 'us-east-1',
      ecrRepository: new ecr.Repository(shared, 'Repo', { repositoryName: 'feuerstein' }),
      lambdaArtifactsBucket: new s3.Bucket(shared, 'Bucket', { bucketName: 'artifacts' }),
      deploymentResourcesKmsKeyArn: TEST_KMS_KEY_ARN,
    });

    expect(stack.stackName).toContain('MyAppGitHubActions');
  });
});
