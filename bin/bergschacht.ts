#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
// import { Bergschacht } from '../lib/bergschacht-stack';
import { GitHubActionsStack } from '../lib/github-actions-stack';
import { GitHubOIDCProviderStack } from '../lib/github-oidc-provider-stack';
import { ReadOnlyRoleStack } from '../lib/readonly-role-stack';
import { cicdAccount, devAccount, prodAccount, awsRegion } from '../lib/constants';

const app = new cdk.App();

// GitHub OIDC Provider Stack - creates the OIDC provider once per account
const githubOidcProviderStack = new GitHubOIDCProviderStack(app, 'GitHubOIDCProviderCicd', {
  env: { account: cicdAccount, region: awsRegion },
});

// GitHub Actions Stack - sets up IAM roles for GitHub Actions to deploy to other accounts from Ci/CD account
new GitHubActionsStack(app, 'GitHubActionsProdCicd', {
  githubOrg: 'Feuerstein-Org',
  githubRepo: 'bergschacht',
  githubBranch: 'master',
  deployAccountIds: [
    [cicdAccount, 'Cicd'],
    [prodAccount, 'Prod'],
    [devAccount, 'Dev'],
  ],
  githubOidcProvider: githubOidcProviderStack.provider,
  env: { account: cicdAccount, region: awsRegion },
});

new GitHubActionsStack(app, 'GitHubActionsDevCicd', {
  githubOrg: 'Feuerstein-Org',
  githubRepo: 'bergschacht',
  githubBranch: 'dev',
  deployAccountIds: [[devAccount, 'Dev']],
  lookupAccountIds: [
    [cicdAccount, 'Cicd'],
    [prodAccount, 'Prod'],
    [devAccount, 'Dev'],
  ],
  githubOidcProvider: githubOidcProviderStack.provider,
  env: { account: cicdAccount, region: awsRegion },
});

// ReadOnly Role Stacks - later this should be used for monitoring
// Currently just a sample deployment trusting CI/CD account
// TODO: Delete after using real monitoring roles
const readOnlyRoleAccounts = [
  { name: 'Cicd', account: cicdAccount },
  { name: 'Dev', account: devAccount },
  { name: 'Prod', account: prodAccount },
];

readOnlyRoleAccounts.forEach(({ name, account }) => {
  new ReadOnlyRoleStack(app, `ReadOnlyRole${name}`, {
    trustedArns: [cicdAccount],
    env: { account, region: awsRegion },
  });
});

// Sample application stack for Development
// new Bergschacht(app, 'BergschachtDev', {
//   env: { account: devAccount, region },
// });

// Sample application stack for Production
// new Bergschacht(app, 'BergschachtProd', {
//   env: { account: prodAccount, region },
// });
