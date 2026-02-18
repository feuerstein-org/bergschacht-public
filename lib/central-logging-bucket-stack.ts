import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface CentralLoggingBucketStackProps extends cdk.StackProps {
  /**
   * The name of the S3 bucket for storing access logs
   * @example 'central-access-logs'
   */
  readonly bucketName: string;
  /**
   * ARN of the customer managed KMS key for encrypting bucket contents.
   */
  readonly encryptionKeyArn: string;
}

/**
 * CDK Stack that creates a centralized S3 bucket for storing access logs
 * from other S3 buckets in the account.
 */
export class CentralLoggingBucketStack extends cdk.Stack {
  public readonly bucket: s3.IBucket;
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: CentralLoggingBucketStackProps) {
    super(scope, id, props);

    this.encryptionKey = kms.Key.fromKeyArn(this, 'EncryptionKey', props.encryptionKeyArn);

    // S3 bucket for storing access logs
    this.bucket = new s3.Bucket(this, 'CentralLoggingBucket', {
      bucketName: props.bucketName,
      encryption: s3.BucketEncryption.KMS,
      encryptionKey: this.encryptionKey,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED, // Required for access logs
      lifecycleRules: [
        {
          id: 'DeleteOldLogs',
          expiration: cdk.Duration.days(90), // Keep for 90 days before deletion
          enabled: true,
        },
        {
          id: 'TransitionToGlacierIR',
          transitions: [
            {
              storageClass: s3.StorageClass.GLACIER_INSTANT_RETRIEVAL,
              transitionAfter: cdk.Duration.days(0), // Immediate transition to Glacier Instant Retrieval
            },
          ],
          enabled: true,
        },
        {
          id: 'AbortIncompleteMultipartUpload',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          enabled: true,
        },
      ],
    });

    // Grant S3 logging service permission to write logs to this bucket
    this.bucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('logging.s3.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [this.bucket.arnForObjects('*')],
        conditions: {
          StringEquals: {
            'aws:SourceAccount': cdk.Stack.of(this).account,
          },
        },
      })
    );

    // CDK Nag suppression: Logging buckets should NOT have server access logging
    // enabled to avoid infinite log generation loop
    NagSuppressions.addResourceSuppressions(
      this.bucket,
      [
        {
          id: 'AwsSolutions-S1',
          reason:
            'This is a centralized logging bucket. Enabling server access logs on a logging bucket would create an infinite loop of log generation.',
        },
      ],
      true
    );

    new cdk.CfnOutput(this, 'BucketName', {
      value: this.bucket.bucketName,
      description: 'S3 Bucket name for centralized access logs',
    });

    new cdk.CfnOutput(this, 'BucketArn', {
      value: this.bucket.bucketArn,
      description: 'S3 Bucket ARN for centralized access logs',
    });
  }
}
