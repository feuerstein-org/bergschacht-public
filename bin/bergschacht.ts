#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
// import { Bergschacht } from '../lib/bergschacht-stack';
import { SnsPagerDutyStack } from '../lib/sns-pager-duty';
import { EcrStack } from '../lib/ecr-stack';
import { GitHubActionsStack } from '../lib/github-actions-stack';
import { GitHubOIDCProviderStack } from '../lib/github-oidc-provider-stack';
import { ReadOnlyRoleStack } from '../lib/readonly-role-stack';
import { cicdAccount, devAccount, prodAccount, awsRegion, pagerDutyEmail } from '../lib/constants';

const app = new cdk.App();

// Add CDK Nag checks to all stacks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

// Convert allAccounts to format needed by GitHubActionsStack
const allAccountIds: [string, string][] = [
  [cicdAccount, 'Cicd'],
  [prodAccount, 'Prod'],
  [devAccount, 'Dev'],
];

// GitHub OIDC Provider Stack - creates the OIDC provider once per account
const githubOidcProviderStack = new GitHubOIDCProviderStack(app, 'GitHubOIDCProviderCicd', {
  env: { account: cicdAccount, region: awsRegion },
});

// GitHub Actions Stack - sets up IAM roles for GitHub Actions to deploy to other accounts from CI/CD account
new GitHubActionsStack(app, 'GitHubActionsProdCicd', {
  githubOrg: 'feuerstein-org',
  githubRepo: 'bergschacht',
  githubBranch: 'master',
  deployAccountIds: allAccountIds,
  githubOidcProvider: githubOidcProviderStack.provider,
  env: { account: cicdAccount, region: awsRegion },
});

new GitHubActionsStack(app, 'GitHubActionsDevCicd', {
  githubOrg: 'feuerstein-org',
  githubRepo: 'bergschacht',
  deployAccountIds: [[devAccount, 'Dev']],
  lookupAccountIds: allAccountIds,
  githubOidcProvider: githubOidcProviderStack.provider,
  env: { account: cicdAccount, region: awsRegion },
});

new GitHubActionsStack(app, 'BergtalzugGitHubActionsEcrPushCicd', {
  githubOrg: 'feuerstein-org',
  githubRepo: 'bergtalzug',
  githubTag: 'v*',
  githubOidcProvider: githubOidcProviderStack.provider,
  additionalPolicies: [
    new iam.PolicyStatement({
      sid: 'AllowEcrAuth',
      effect: iam.Effect.ALLOW,
      actions: ['ecr:GetAuthorizationToken'],
      resources: ['*'], // GetAuthorizationToken doesn't support resource-level permissions
    }),
    new iam.PolicyStatement({
      sid: 'AllowEcrPush',
      effect: iam.Effect.ALLOW,
      actions: [
        'ecr:BatchCheckLayerAvailability',
        'ecr:GetDownloadUrlForLayer',
        'ecr:BatchGetImage',
        'ecr:PutImage',
        'ecr:InitiateLayerUpload',
        'ecr:UploadLayerPart',
        'ecr:CompleteLayerUpload',
      ],
      resources: [`arn:aws:ecr:${awsRegion}:${cicdAccount}:repository/feuerstein`],
    }),
  ],
  env: { account: cicdAccount, region: awsRegion },
});

// Per-account infrastructure stacks
interface AccountStacks {
  readOnlyRole: ReadOnlyRoleStack;
  snsPagerDuty: SnsPagerDutyStack;
}

const accountStacks = new Map<string, AccountStacks>();

allAccountIds.forEach(([account, name]) => {
  // ReadOnly Role Stacks - later this should be used for monitoring
  // Currently just a sample deployment trusting CI/CD account
  // TODO: Delete after using real monitoring roles
  const readOnlyRole = new ReadOnlyRoleStack(app, `ReadOnlyRole${name}`, {
    trustedArns: [cicdAccount],
    env: { account, region: awsRegion },
  });

  const snsPagerDuty = new SnsPagerDutyStack(app, `SnsPagerDutyStack${name}`, {
    topicName: `PagerDutyAlerts${name}`,
    emailAddress: pagerDutyEmail,
    env: { account, region: awsRegion },
  });

  accountStacks.set(name, { readOnlyRole, snsPagerDuty });
});

// Deploy central ECR Stack in CI/CD account and give pull access to Prod and Dev accounts
new EcrStack(app, `EcrStackCicd`, {
  repositoryName: `feuerstein`,
  notificationTopic: accountStacks.get('Cicd')!.snsPagerDuty.topic,
  allowedPullAccountIds: [devAccount, prodAccount],
  env: { account: cicdAccount, region: awsRegion },
});

// Sample application stack for Development
// new Bergschacht(app, 'BergschachtDev', {
//   env: { account: devAccount, region },
// });

// Sample application stack for Production
// new Bergschacht(app, 'BergschachtProd', {
//   env: { account: prodAccount, region },
// });
