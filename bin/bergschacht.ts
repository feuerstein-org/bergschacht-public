#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { InfraPipelineStack } from '../lib/infra-pipeline-stack';
import { DevelopmentPipelineStack } from '../lib/development-pipeline-stack';
import { ProductionPipelineStack } from '../lib/production-pipeline-stack';
import {
  cicdAccount,
  devAccount,
  prodAccount,
  awsRegion,
  pagerDutyEmail,
  githubConnectionArn,
  githubOrg,
  githubRepo,
  applicationRepos,
} from '../lib/constants';

const app = new cdk.App();

// Add CDK Nag checks to all stacks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

/**
 * Infrastructure Pipeline Stack
 * Deploys CicdStage with all shared infrastructure (KMS, ECR, OIDC, cross-account ReadOnlyRole for Dev and Prod).
 * Triggered on infrastructure code changes.
 */
new InfraPipelineStack(app, 'InfraPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  branch: 'master',
  connectionArn: githubConnectionArn,
  cicdAccountId: cicdAccount,
  devAccountId: devAccount,
  prodAccountId: prodAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  applicationRepos: applicationRepos,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for infrastructure deployments',
});

/**
 * Production Pipeline Stack
 * Dev -> Prod (no CICD stage)
 * Deploys application workloads that consume the version manifest.
 * Triggered when version-manifests/ or app stage code changes.
 */
new ProductionPipelineStack(app, 'ProductionPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  branch: 'master',
  connectionArn: githubConnectionArn,
  devAccountId: devAccount,
  prodAccountId: prodAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for application deployments (version manifest driven)',
});

/**
 * Development Pipeline Stack
 * Deploys only to Dev
 * Triggered ONLY on pushes to all non-master branches.
 */
new DevelopmentPipelineStack(app, 'DevelopmentPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  connectionArn: githubConnectionArn,
  devAccountId: devAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for development deployments (Dev only, feature branches)',
});
