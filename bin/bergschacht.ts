#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
// import { Bergschacht } from '../lib/bergschacht-stack';
import { GitHubActionsStack } from '../lib/github-actions-stack';
import { cicdAccount, devAccount, prodAccount, region } from '../lib/constants';

const app = new cdk.App();

// GitHub Actions OIDC Stack - sets up OIDC provider and IAM role for GitHub Actions
new GitHubActionsStack(app, 'BergschachtGitHubActionsProd', {
  githubOrg: 'Feuerstein-Org',
  githubRepo: 'bergschacht',
  githubBranch: 'master',
  accountIds: [devAccount, prodAccount],
  deploysToCicdAccount: true, // Only the master branch can deploy to CICD account
  env: { account: cicdAccount, region },
});

new GitHubActionsStack(app, 'BergschachtGitHubActionsDev', {
  githubOrg: 'Feuerstein-Org',
  githubRepo: 'bergschacht',
  githubBranch: 'dev',
  accountIds: [devAccount],
  env: { account: cicdAccount, region },
});

// Sample application stack for Development
// new Bergschacht(app, 'BergschachtDev', {
//   env: { account: devAccount, region },
// });

// Sample application stack for Production
// new Bergschacht(app, 'BergschachtProd', {
//   env: { account: prodAccount, region },
// });
