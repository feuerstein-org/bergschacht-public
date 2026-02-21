import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface LambdaArtifactsStackProps extends cdk.StackProps {
  /**
   * The name of the S3 bucket for Lambda deployment artifacts
   * @example 'lambda-artifacts'
   */
  readonly bucketName: string;
  /**
   * ARN of the customer managed KMS key for encrypting bucket contents.
   */
  readonly encryptionKeyArn: string;
  /**
   * List of AWS account IDs that should be allowed to read and download from this bucket
   * @default - No cross-account access granted
   */
  readonly allowedAccountIds?: string[];
  /**
   * S3 bucket for storing server access logs
   * @default - Server access logging is not enabled
   */
  readonly serverAccessLogsBucket?: s3.IBucket;
}

/**
 * CDK Stack that creates an S3 bucket for storing Lambda deployment artifacts
 * with KMS encryption and cross-account access for deployment.
 */
export class LambdaArtifactsStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: LambdaArtifactsStackProps) {
    super(scope, id, props);

    this.encryptionKey = kms.Key.fromKeyArn(this, 'EncryptionKey', props.encryptionKeyArn);

    // S3 bucket for Lambda artifacts
    this.bucket = new s3.Bucket(this, 'LambdaArtifactsBucket', {
      bucketName: props.bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      serverAccessLogsBucket: props.serverAccessLogsBucket,
      serverAccessLogsPrefix: props.serverAccessLogsBucket ? `${props.bucketName}/` : undefined,
      lifecycleRules: [
        {
          id: 'DeleteOldVersions',
          noncurrentVersionExpiration: cdk.Duration.days(90),
          enabled: true,
        },
        {
          id: 'AbortIncompleteMultipartUpload',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          enabled: true,
        },
      ],
    });

    // Grant cross-account read and download permissions if specified
    if (props.allowedAccountIds && props.allowedAccountIds.length > 0) {
      this.bucket.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountRead',
          effect: iam.Effect.ALLOW,
          principals: props.allowedAccountIds.map(
            (accountId) => new iam.AccountPrincipal(accountId)
          ),
          actions: ['s3:GetObject', 's3:GetObjectVersion', 's3:GetBucketLocation', 's3:ListBucket'],
          resources: [this.bucket.bucketArn, `${this.bucket.bucketArn}/*`],
        })
      );
    }

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 Bucket name for Lambda artifacts',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: this.bucket.bucketArn,
      description: 'S3 Bucket ARN for Lambda artifacts',
    });
  }
}
