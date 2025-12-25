import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import { Construct } from 'constructs';
import { SharedKmsKeyStack } from '../shared-kms-key-stack';
import { CentralLoggingBucketStack } from '../central-logging-bucket-stack';
import { LambdaArtifactsStack } from '../lambda-artifacts-stack';
import { EcrStack } from '../ecr-stack';
import { SnsPagerDutyStack } from '../sns-pager-duty';

export interface CicdStageProps extends cdk.StageProps {
  /**
   * The CICD account ID
   */
  readonly cicdAccountId: string;
  /**
   * The Dev account ID
   */
  readonly devAccountId: string;
  /**
   * The Prod account ID
   */
  readonly prodAccountId: string;
  /**
   * AWS region for deployment
   */
  readonly awsRegion: string;
  /**
   * Email address for PagerDuty alerts
   */
  readonly pagerDutyEmail: string;
}

/**
 * Stage containing all infrastructure stacks for CI/CD.
 * This includes shared resources like KMS keys, ECR repositories, and Lambda artifacts.
 */
export class CicdStage extends cdk.Stage {
  public readonly deploymentResourcesKmsKey: kms.IKey;

  constructor(scope: Construct, id: string, props: CicdStageProps) {
    super(scope, id, props);

    const { cicdAccountId, devAccountId, prodAccountId, awsRegion, pagerDutyEmail } = props;

    // Create SNS PagerDuty topic for CICD account
    const snsPagerDutyStack = new SnsPagerDutyStack(this, 'SnsPagerDuty', {
      topicName: 'PagerDutyAlertsCicd',
      emailAddress: pagerDutyEmail,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Create shared KMS key for ECR and Lambda artifacts in CI/CD account
    const deploymentResourcesKmsKeyStack = new SharedKmsKeyStack(
      this,
      'DeploymentResourcesKmsKey',
      {
        kmsDescription: 'Shared KMS key for Deployment resources',
        keyAlias: 'cicd-deployment-resources',
        // TODO: These policies can be tightened and limited to specific ARNs
        // Do it like with the ReadOnlyRoleStack trustedArns and specify the specific ARNs that need access
        // Since it's only deployment artifacts this is not urgent
        allowedDecryptAccountIds: [cicdAccountId, devAccountId, prodAccountId],
        env: { account: cicdAccountId, region: awsRegion },
      }
    );

    // Create centralized logging bucket for CI/CD account
    const centralLoggingBucket = new CentralLoggingBucketStack(this, 'CentralLoggingBucket', {
      bucketName: 'example-cicd-logs',
      encryptionKey: deploymentResourcesKmsKeyStack.key,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy Lambda Artifacts S3 bucket in CI/CD account with shared KMS key
    new LambdaArtifactsStack(this, 'LambdaArtifacts', {
      bucketName: 'example-lambda-artifacts',
      allowedAccountIds: [devAccountId, prodAccountId],
      encryptionKey: deploymentResourcesKmsKeyStack.key,
      serverAccessLogsBucket: centralLoggingBucket.bucket,
      env: { account: cicdAccountId, region: awsRegion },
    });

    // Deploy central ECR Stack in CI/CD account with shared KMS key
    new EcrStack(this, 'FeuersteinEcr', {
      repositoryName: 'feuerstein',
      notificationTopic: snsPagerDutyStack.topic,
      allowedPullAccountIds: [devAccountId, prodAccountId],
      encryptionKey: deploymentResourcesKmsKeyStack.key,
      env: { account: cicdAccountId, region: awsRegion },
    });
  }
}
