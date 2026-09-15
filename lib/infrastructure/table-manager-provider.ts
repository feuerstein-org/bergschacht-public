import * as cdk from 'aws-cdk-lib/core';
import * as cr from 'aws-cdk-lib/custom-resources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { getLambdaArtifact } from '../config/version-manifest.ts';

export interface TableManagerProviderProps {
  /**
   * The S3 Table Bucket the managed tables belong to.
   * Used to scope IAM permissions.
   */
  readonly tableBucket: s3tables.ITableBucket;
  /**
   * KMS key used for table bucket encryption.
   * The Lambda function is granted encrypt/decrypt.
   */
  readonly encryptionKey: kms.IKey;
}

/**
 * Shared construct that owns the table-manager Lambda function and
 * CloudFormation custom-resource provider.
 *
 * Instantiate once per stack and pass the `serviceToken` to every
 * {@link IcebergTable} that needs to be managed.
 */
export class TableManagerProvider extends Construct {
  /**
   * The service token to pass to `cdk.CustomResource` instances.
   */
  public readonly serviceToken: string;

  constructor(scope: Construct, id: string, props: TableManagerProviderProps) {
    super(scope, id);

    const artifact = getLambdaArtifact(
      'bergschacht-custom-resources',
      's3tables-table-manager',
      's3tables-table-manager'
    );

    const artifactBucket = s3.Bucket.fromBucketName(this, 'ArtifactBucket', artifact.bucket);

    const fn = new lambda.Function(this, 'Handler', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 's3tables_table_manager.handler.handler',
      code: lambda.Code.fromBucket(artifactBucket, artifact.key, artifact.objectVersion),
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      description: 'Manages Iceberg table lifecycle on S3 Tables via pyiceberg',
      logGroup: new logs.LogGroup(this, 'HandlerLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });

    // Grant S3 Tables permissions for full table lifecycle management
    fn.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'AllowS3TablesTableManagement',
        effect: iam.Effect.ALLOW,
        actions: [
          's3tables:CreateTable',
          's3tables:DeleteTable',
          's3tables:GetTable',
          's3tables:GetTableData',
          's3tables:GetTableMetadataLocation',
          's3tables:UpdateTableMetadataLocation',
          's3tables:GetTableBucket',
          's3tables:GetNamespace',
          's3tables:ListNamespaces',
          's3tables:ListTables',
          's3tables:PutTableData',
        ],
        resources: [props.tableBucket.tableBucketArn, `${props.tableBucket.tableBucketArn}/*`],
      })
    );

    // Grant KMS permissions for the data encryption key
    props.encryptionKey.grantEncryptDecrypt(fn);

    const provider = new cr.Provider(this, 'Provider', {
      onEventHandler: fn,
      logGroup: new logs.LogGroup(this, 'ProviderLogs', {
        retention: logs.RetentionDays.ONE_MONTH,
      }),
    });

    this.serviceToken = provider.serviceToken;

    // ------------------------------------------------------------------
    // cdk-nag suppressions
    // ------------------------------------------------------------------

    NagSuppressions.addResourceSuppressions(
      fn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'AWSLambdaBasicExecutionRole managed policy is acceptable for logging',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'S3 Tables requires wildcard sub-resource access on the table bucket ARN',
          appliesTo: [
            'Resource::<TableBucket0BF18B0D.TableBucketARN>/*',
            'Action::kms:GenerateDataKey*',
            'Action::kms:ReEncrypt*',
          ],
        },
      ],
      true
    );
    NagSuppressions.addResourceSuppressions(
      provider,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason: 'Provider framework Lambda uses AWSLambdaBasicExecutionRole',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason: 'Provider framework requires wildcard permissions for invoking onEvent handler',
        },
        {
          id: 'AwsSolutions-L1',
          reason: 'Provider framework Lambda runtime is managed by CDK',
        },
      ],
      true
    );
  }
}
