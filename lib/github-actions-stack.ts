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
   */
  readonly accountIds: [string, string][];

  /**
   * Whether the stack that is being deployed also deploys changes to the CI/CD account itself.
   * When true, the created role will be granted additional permissions required to deploy to the CI/CD account
   * (specifically `iam:PassRole` and allow assuming the CDK deploy role in the CICD account).
   *
   * Note: Don't set this to true if non-2PR branches since that would allow someone
   * to deploy a change to the CI/CD account, escalate permissions and then deploy malicious code to prod.
   * @default false
   */
  readonly deploysToCicdAccount?: boolean;

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

    if (props.accountIds.length === 0 || !props.accountIds[0][0] || props.accountIds[0][0] === '') {
      throw new Error('At least one accountId must be provided in accountIds');
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

    // Grant cross-account permissions to assume CDK & ReadOnly roles in deployment accounts
    props.accountIds.forEach((accountId) =>
      githubActionsRole.addToPolicy(
        new iam.PolicyStatement({
          sid: `AllowAssumeRoleIn${accountId[1]}Account`,
          effect: iam.Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [
            `arn:aws:iam::${accountId[0]}:role/cdk-*`,
            `arn:aws:iam::${accountId[0]}:role/ReadOnly`,
          ],
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
    new cdk.CfnOutput(this, 'GitHubActionsAccountIds', {
      value: props.accountIds.map(([id, name]) => `${name}:${id}`).join(', '),
      description: 'AWS account IDs with permissions to deploy to',
      exportName: `${id}-AccountIds`,
    });
  }
}
