import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface GitHubActionsStackProps extends cdk.StackProps {
  /**
   * GitHub organization or user name
   * @example 'feuerstein-org'
   */
  readonly githubOrg: string;

  /**
   * GitHub repository name
   * @example 'bergschacht'
   */
  readonly githubRepo: string;

  /**
   * GitHub environment name.
   * @example 'prod', 'dev', 'stage'
   */
  readonly githubEnvironment: string;

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

  /**
   * Additional IAM policy statements to attach to the GitHub Actions role.
   * Use this to grant custom permissions like ECR push access.
   * @example [
   *   new iam.PolicyStatement({
   *     effect: iam.Effect.ALLOW,
   *     actions: ['ecr:PutImage', 'ecr:InitiateLayerUpload', ...],
   *     resources: ['arn:aws:ecr:*:*:repository/my-repo'],
   *   })
   * ]
   * @default - No additional permissions
   */
  readonly additionalPolicies?: iam.PolicyStatement[];
}

/**
 * CDK Stack that sets up GitHub Actions OIDC authentication for AWS.
 *
 * Creates an OIDC provider and IAM role that allows GitHub Actions workflows
 * from a specific repository and environment to assume roles and deploy CDK stacks
 * via the CI/CD account to specified deployment accounts.
 */
export class GitHubActionsStack extends cdk.Stack {
  public readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: GitHubActionsStackProps) {
    super(scope, id, props);

    const deployAccountIds = props.deployAccountIds ?? [];
    const lookupAccountIds = props.lookupAccountIds ?? [];
    const additionalPolicies = props.additionalPolicies ?? [];

    if (
      deployAccountIds.length === 0 &&
      lookupAccountIds.length === 0 &&
      additionalPolicies.length === 0
    ) {
      throw new Error(
        'At least one account must be provided in deployAccountIds or lookupAccountIds, or additionalPolicies must be provided'
      );
    }
    // Build the subject identifier for GitHub OIDC
    const subjectIdentifier = `repo:${props.githubOrg}/${props.githubRepo}:environment:${props.githubEnvironment}`;

    // If no environment is specified, use StringLike for sub condition to match whole repo
    const conditions = {
      StringEquals: {
        'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com',
        'token.actions.githubusercontent.com:sub': subjectIdentifier,
      },
    };

    // Create the IAM role for GitHub Actions
    const githubActionsRole = new iam.Role(this, 'GitHubActionsRole', {
      roleName: `${props.githubRepo}-${props.githubEnvironment}-github-actions-role`,
      description: `Role for GitHub Actions ${props.githubRepo}-${props.githubEnvironment} workflows to assume for deployments`,
      assumedBy: new iam.OpenIdConnectPrincipal(props.githubOidcProvider, conditions),
    });

    // Create policy statements
    const policyStatements: iam.PolicyStatement[] = [];

    // Grant cross-account permissions to assume CDK roles in deployment accounts
    deployAccountIds.forEach((accountId) =>
      policyStatements.push(
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
      policyStatements.push(
        new iam.PolicyStatement({
          sid: `AllowAssumeLookupRoleIn${accountId[1]}Account`,
          effect: iam.Effect.ALLOW,
          actions: ['sts:AssumeRole'],
          resources: [`arn:aws:iam::${accountId[0]}:role/cdk-*-lookup-role-*`],
        })
      )
    );

    // Add additional custom policy statements
    policyStatements.push(...additionalPolicies);

    const rolePolicy = new iam.Policy(this, 'GitHubActionsRolePolicy', {
      statements: policyStatements,
    });
    rolePolicy.attachToRole(githubActionsRole);

    this.role = githubActionsRole;

    // Suppress CDK Nag warnings for wildcard permissions in CDK role ARNs
    // These wildcards are necessary to allow GitHub Actions to assume CDK bootstrap roles
    // and for additional policies that may contain wildcards (e.g., ECR push permissions)
    NagSuppressions.addResourceSuppressions(
      rolePolicy,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'Wildcard permissions are required for CDK deployment roles and additional policies (e.g., ECR) to allow GitHub Actions to assume the appropriate bootstrap roles in target accounts.',
        },
      ],
      true
    );

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
