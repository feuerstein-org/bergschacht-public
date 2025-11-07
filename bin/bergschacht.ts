#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
// import { Bergschacht } from '../lib/bergschacht-stack';
import { GitHubActionsStack } from '../lib/github-actions-stack';
import { GitHubOIDCProviderStack } from '../lib/github-oidc-provider-stack';
import { cicdAccount, devAccount, prodAccount, cicdRegion } from '../lib/constants';

const app = new cdk.App();

// GitHub OIDC Provider Stack - creates the OIDC provider once per account
const githubOidcProviderStack = new GitHubOIDCProviderStack(app, 'GitHubOIDCProviderCicd', {
  env: { account: cicdAccount, region: cicdRegion },
});

// GitHub Actions Stack - sets up IAM roles for GitHub Actions to deploy to other accounts from Ci/CD account
new GitHubActionsStack(app, 'BergschachtGitHubActionsProdCicd', {
  githubOrg: 'Feuerstein-Org',
  githubRepo: 'bergschacht',
  githubBranch: 'master',
  accountIds: [
    [devAccount, 'Dev'],
    [prodAccount, 'Prod'],
  ],
  deploysToCicdAccount: true, // Only the master branch can deploy to CICD account
  githubOidcProvider: githubOidcProviderStack.provider,
  env: { account: cicdAccount, region: cicdRegion },
});

new GitHubActionsStack(app, 'BergschachtGitHubActionsDevCicd', {
  githubOrg: 'Feuerstein-Org',
  githubRepo: 'bergschacht',
  githubBranch: 'dev',
  accountIds: [[devAccount, 'Dev']],
  githubOidcProvider: githubOidcProviderStack.provider,
  env: { account: cicdAccount, region: cicdRegion },
});

// Sample application stack for Development
// new Bergschacht(app, 'BergschachtDev', {
//   env: { account: devAccount, region },
// });

// Sample application stack for Production
// new Bergschacht(app, 'BergschachtProd', {
//   env: { account: prodAccount, region },
// });
