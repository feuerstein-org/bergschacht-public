import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface GitHubActionsStackProps extends cdk.StackProps {
  /**
   * GitHub organization or user name
   * @example 'Feuerstein-Org'
   */
  readonly githubOrg: string;

  /**
   * GitHub repository name
   * @example 'bergschacht'
   */
  readonly githubRepo: string;

  /**
   * Restrict to specific branch
   * @example 'master'
   */
  readonly githubBranch: string;

  /**
   * AWS account IDs and names to give permissions to deploy to
   * @example [['123456789012', 'Dev'], ['987654321098', 'Prod']]
   * @default - No deployment permissions
   */
  readonly deployAccountIds?: [string, string][];

  /**
   * AWS account IDs and names to give permissions to lookup (read-only access)
   * @example [['123456789012', 'Dev'], ['987654321098', 'Prod']]
   * @default - No lookup permissions
   */
  readonly lookupAccountIds?: [string, string][];

  /**
   * The GitHub OIDC provider to use for authentication.
   * This should be created once in the CI/CD account using GitHubOIDCProviderStack.
   */
  readonly githubOidcProvider: iam.IOpenIdConnectProvider;
}

/**
 * CDK Stack that sets up GitHub Actions OIDC authentication for AWS.
 *
 * Creates an OIDC provider and IAM role that allows GitHub Actions workflows
 * from a specific repository and branch to assume roles and deploy CDK stacks
 * via the CI/CD account to specified deployment accounts.
 */
export class GitHubActionsStack extends cdk.Stack {
  public readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: GitHubActionsStackProps) {
    super(scope, id, props);

    const deployAccountIds = props.deployAccountIds ?? [];
    const lookupAccountIds = props.lookupAccountIds ?? [];

    if (deployAccountIds.length === 0 && lookupAccountIds.length === 0) {
      throw new Error(
        'At least one account must be provided in deployAccountIds or lookupAccountIds'
      );
    }

    // Format: repo:ORG/REPO:ref:refs/heads/BRANCH
    const trusted_branch: string = `repo:${props.githubOrg}/${props.githubRepo}:ref:refs/heads/${props.githubBranch}`;

    // Create condition for the trust policy
    const conditions: { [key: string]: unknown } = {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': trusted_branch,
      },
    };

    // Create the IAM role for GitHub Actions
    const githubActionsRole = new iam.Role(this, 'GitHubActionsRole', {
      roleName: `${props.githubRepo}-${props.githubBranch}-github-actions-role`,
      description: `Role for GitHub Actions to deploy ${props.githubRepo}-${props.githubBranch} CDK stacks`,
      assumedBy: new iam.OpenIdConnectPrincipal(props.githubOidcProvider, conditions),
    });

    // Grant cross-account permissions to assume CDK roles in deployment accounts
    deployAccountIds.forEach((accountId) =>
      githubActionsRole.addToPolicy(
        new iam.PolicyStatement({
          sid: `AllowAssumeDeploymentRoleIn${accountId[1]}Account`,
          effect: iam.Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${accountId[0]}:role/cdk-*`],
        })
      )
    );

    // Grant cross-account permissions to assume CDK lookup roles in lookup accounts
    lookupAccountIds.forEach((accountId) =>
      githubActionsRole.addToPolicy(
        new iam.PolicyStatement({
          sid: `AllowAssumeLookupRoleIn${accountId[1]}Account`,
          effect: iam.Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${accountId[0]}:role/cdk-*-lookup-role-*`],
        })
      )
    );

    this.role = githubActionsRole;

    // Output the role ARN for use in GitHub Actions
    new cdk.CfnOutput(this, 'RoleArn', {
      value: githubActionsRole.roleArn,
      description: 'ARN of the IAM role for GitHub Actions',
      exportName: `${id}-RoleArn`,
    });

    // output the accounts to deploy to
    if (deployAccountIds.length > 0) {
      new cdk.CfnOutput(this, 'GitHubActionsDeployAccountIds', {
        value: deployAccountIds.map(([id, name]) => `${name}:${id}`).join(', '),
        description: 'AWS account IDs with permissions to deploy to',
        exportName: `${id}-DeployAccountIds`,
      });
    }

    // output the accounts to lookup
    if (lookupAccountIds.length > 0) {
      new cdk.CfnOutput(this, 'GitHubActionsLookupAccountIds', {
        value: lookupAccountIds.map(([id, name]) => `${name}:${id}`).join(', '),
        description: 'AWS account IDs with permissions to lookup',
        exportName: `${id}-LookupAccountIds`,
      });
    }
  }
}
