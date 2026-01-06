import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { GitHubOIDCProviderStack } from '../lib/github-oidc-provider-stack';

describe('GitHubOIDCProviderStack', () => {
  let stack: GitHubOIDCProviderStack;
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    stack = new GitHubOIDCProviderStack(app, 'TestGitHubOIDCProvider');
    template = Template.fromStack(stack);
  });

  test('creates GitHub OIDC provider with correct configuration', () => {
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: 'https://token.actions.githubusercontent.com',
      ClientIDList: ['sts.amazonaws.com'],
    });
  });

  test('creates CloudFormation output for provider ARN', () => {
    template.hasOutput('GitHubOIDCProviderArn', {
      Description: 'ARN of the GitHub OIDC provider',
      Export: {
        Name: 'TestGitHubOIDCProvider-OIDCProviderArn',
      },
    });
  });

  test('exports the provider for use in other stacks', () => {
    expect(stack.provider).toBeDefined();
  });
});
