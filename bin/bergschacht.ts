#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { ProductionPipelineStack } from '../lib/production-pipeline-stack';
import { DevelopmentPipelineStack } from '../lib/development-pipeline-stack';
import {
  cicdAccount,
  devAccount,
  prodAccount,
  awsRegion,
  pagerDutyEmail,
  githubConnectionArn,
  githubOrg,
  githubRepo,
} from '../lib/constants';

const app = new cdk.App();

// Add CDK Nag checks to all stacks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

/**
 * Production Pipeline Stack
 * CICD -> Dev -> Prod
 * Triggered ONLY on pushes to the 'master' branch.
 */
new ProductionPipelineStack(app, 'ProductionPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  branch: 'master',
  connectionArn: githubConnectionArn,
  cicdAccountId: cicdAccount,
  devAccountId: devAccount,
  prodAccountId: prodAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for production deployments',
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
  cicdAccountId: cicdAccount,
  devAccountId: devAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for development deployments (Dev only, feature branches)',
});
