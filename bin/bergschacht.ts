#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SharedKmsKeyStack } from '../lib/shared-kms-key-stack';
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
 * Shared KMS Key Stack
 * A single KMS key used by all pipelines (artifact encryption) and deployment
 * resources (ECR, Lambda artifacts S3 bucket, logging bucket).
 *
 * This stack must be deployed once before the pipelines can self-mutate.
 * After that, the pipelines manage themselves.
 */
const sharedKmsKeyStack = new SharedKmsKeyStack(app, 'SharedKmsKey', {
  kmsDescription: 'Shared KMS key for all pipeline artifacts and deployment resources',
  keyAlias: 'cicd-shared',
  allowedDecryptAccountIds: [cicdAccount, devAccount, prodAccount],
  env: { account: cicdAccount, region: awsRegion },
  description: 'Shared KMS key for pipeline artifacts and deployment resources',
});

const sharedKmsKeyAliasArn = `arn:aws:kms:${awsRegion}:${cicdAccount}:alias/cicd-shared`;

/**
 * Infrastructure Pipeline Stack
 * Deploys CicdStage with all shared infrastructure (ECR, OIDC, cross-account ReadOnlyRole for Dev and Prod).
 * Triggered on infrastructure code changes.
 */
const infraPipeline = new InfraPipelineStack(app, 'InfraPipeline', {
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
  encryptionKeyArn: sharedKmsKeyAliasArn,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for infrastructure deployments',
});
infraPipeline.addDependency(sharedKmsKeyStack);

/**
 * Production Pipeline Stack
 * Dev -> Prod (no CICD stage)
 * Deploys application workloads that consume the version manifest.
 * Triggered when version-manifests/ or app stage code changes.
 */
const productionPipeline = new ProductionPipelineStack(app, 'ProductionPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  branch: 'master',
  connectionArn: githubConnectionArn,
  devAccountId: devAccount,
  prodAccountId: prodAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  encryptionKeyArn: sharedKmsKeyAliasArn,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for application deployments (version manifest driven)',
});
productionPipeline.addDependency(sharedKmsKeyStack);

/**
 * Development Pipeline Stack
 * Deploys only to Dev
 * Triggered ONLY on pushes to all non-master branches.
 */
const developmentPipeline = new DevelopmentPipelineStack(app, 'DevelopmentPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  connectionArn: githubConnectionArn,
  devAccountId: devAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  encryptionKeyArn: sharedKmsKeyAliasArn,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for development deployments (Dev only, feature branches)',
});
developmentPipeline.addDependency(sharedKmsKeyStack);
