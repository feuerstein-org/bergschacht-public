import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import { Construct } from 'constructs';

export interface TableBucketStackProps extends cdk.StackProps {
  /**
   * The name of the S3 table bucket.
   * @example 'my-analytics-table-bucket'
   */
  readonly tableBucketName: string;
  /**
   * KMS key to use for SSE-KMS encryption of the table bucket.
   */
  readonly encryptionKey: kms.IKey;
}

/**
 * CDK Stack that creates and owns an S3 Table Bucket.
 *
 * The bucket is shared across multiple namespace stacks (e.g. bronze, gold)
 * which each independently manage their own namespace and tables.
 */
export class TableBucketStack extends cdk.Stack {
  public readonly tableBucket: s3tables.ITableBucket;

  constructor(scope: Construct, id: string, props: TableBucketStackProps) {
    super(scope, id, props);

    this.tableBucket = new s3tables.TableBucket(this, 'TableBucket', {
      tableBucketName: props.tableBucketName,
      unreferencedFileRemoval: {
        status: s3tables.UnreferencedFileRemovalStatus.ENABLED,
        unreferencedDays: 10,
        noncurrentDays: 10,
      },
      encryption: s3tables.TableBucketEncryption.KMS,
      encryptionKey: props.encryptionKey,
    });

    new cdk.CfnOutput(this, 'TableBucketArn', {
      value: this.tableBucket.tableBucketArn,
      description: 'S3 Table Bucket ARN',
    });
  }
}
