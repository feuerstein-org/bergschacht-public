import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

/**
 * CDK Stack that creates a GitHub OIDC provider.
 *
 * This stack should be deployed once to the CI/CD account and will be used by all roles in the
 * GitHubActionsStack instances.
 */
export class GitHubOIDCProviderStack extends cdk.Stack {
  public readonly provider: iam.IOpenIdConnectProvider;

  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    const githubProvider = new iam.OpenIdConnectProvider(this, 'GitHubOIDCProvider', {
      url: 'https://token.actions.githubusercontent.com',
      clientIds: ['sts.amazonaws.com'],
    });

    this.provider = githubProvider;

    // Output the provider ARN for use in other stacks
    new cdk.CfnOutput(this, 'GitHubOIDCProviderArn', {
      value: githubProvider.openIdConnectProviderArn,
      description: 'ARN of the GitHub OIDC provider',
      exportName: `${id}-OIDCProviderArn`,
    });
  }
}
