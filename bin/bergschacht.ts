#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { SharedKmsKeyStack } from '../lib/infrastructure/shared-kms-key-stack';
import { InfraPipelineStack } from '../lib/pipeline/infra-pipeline-stack';
import { DevelopmentPipelineStack } from '../lib/pipeline/development-pipeline-stack';
import { ProductionPipelineStack } from '../lib/pipeline/production-pipeline-stack';
import {
  cicdAccount,
  devAccount,
  stagingAccount,
  prodAccount,
  awsRegion,
  pagerDutyEmail,
  githubConnectionArn,
  githubOrg,
  githubRepo,
  applicationRepos,
} from '../lib/config/constants';

const app = new cdk.App();

// Add CDK Nag checks to all stacks
cdk.Aspects.of(app).add(new AwsSolutionsChecks({ verbose: true }));

const keyAlias = 'alias/cicd-shared';

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
  keyAlias: keyAlias,
  allowedDecryptAccountIds: [cicdAccount, devAccount, stagingAccount, prodAccount],
  env: { account: cicdAccount, region: awsRegion },
  description: 'Shared KMS key for pipeline artifacts and deployment resources',
});

/**
 * Infrastructure Pipeline Stack
 * Deploys CicdStage with all shared infrastructure (ECR, OIDC, cross-account ReadOnlyRole for Dev, Staging, and Prod).
 * Triggered on infrastructure code changes.
 */
const infraPipeline = new InfraPipelineStack(app, 'InfraPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  branch: 'master',
  connectionArn: githubConnectionArn,
  cicdAccountId: cicdAccount,
  devAccountId: devAccount,
  stagingAccountId: stagingAccount,
  prodAccountId: prodAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  applicationRepos: applicationRepos,
  encryptionKeyAlias: keyAlias,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for infrastructure deployments',
});
infraPipeline.addDependency(sharedKmsKeyStack);

/**
 * Production Pipeline Stack
 * Staging -> Prod (no CICD stage)
 * Deploys application workloads that consume the version manifest from SSM.
 * Triggered by application repos after they update SSM parameters.
 */
const productionPipeline = new ProductionPipelineStack(app, 'ProductionPipeline', {
  githubOwner: githubOrg,
  githubRepo: githubRepo,
  branch: 'master',
  connectionArn: githubConnectionArn,
  stagingAccountId: stagingAccount,
  prodAccountId: prodAccount,
  awsRegion: awsRegion,
  pagerDutyEmail: pagerDutyEmail,
  encryptionKeyAlias: keyAlias,
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
  encryptionKeyAlias: keyAlias,
  env: { account: cicdAccount, region: awsRegion },
  description: 'CDK Pipeline for development deployments (Dev only, feature branches)',
});
developmentPipeline.addDependency(sharedKmsKeyStack);
