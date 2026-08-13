import * as cdk from 'aws-cdk-lib/core';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import { Construct } from 'constructs';
import type { IcebergSchemaDefinition } from './iceberg-schema.ts';
import { validateSchemaDefinition } from './iceberg-schema.ts';

export interface IcebergTableProps {
  /**
   * Service token from a {@link TableManagerProvider}.
   */
  readonly serviceToken: string;
  /**
   * The S3 Table Bucket that owns this table.
   */
  readonly tableBucket: s3tables.ITableBucket;
  /**
   * The namespace the table belongs to.
   * The construct adds a dependency on this so the namespace exists first.
   */
  readonly namespace: s3tables.INamespace;
  /**
   * Name of the Iceberg table.
   */
  readonly tableName: string;
  /**
   * Declarative Iceberg schema definition.
   */
  readonly schema: IcebergSchemaDefinition;
  /**
   * Removal policy for the table.
   * @default cdk.RemovalPolicy.RETAIN
   */
  readonly removalPolicy?: cdk.RemovalPolicy;
}

/**
 * An Iceberg table managed by the table-manager custom resource.
 *
 * Each instance creates one `AWS::CloudFormation::CustomResource` that
 * delegates create / update / delete to the shared Lambda provider.
 */
export class IcebergTable extends Construct {
  /**
   * The table ARN returned by the custom resource.
   */
  public readonly tableArn: string;
  /**
   * The Iceberg schema ID applied by the custom resource.
   */
  public readonly schemaId: string;
  /**
   * The table name.
   */
  public readonly tableName: string;

  constructor(scope: Construct, id: string, props: IcebergTableProps) {
    super(scope, id);

    this.tableName = props.tableName;

    validateSchemaDefinition(props.schema, props.tableName);

    const resource = new cdk.CustomResource(this, 'Resource', {
      serviceToken: props.serviceToken,
      removalPolicy: props.removalPolicy ?? cdk.RemovalPolicy.RETAIN,
      properties: {
        TableBucketArn: props.tableBucket.tableBucketArn,
        Namespace: props.namespace.namespaceName,
        TableName: props.tableName,
        Schema: JSON.stringify(props.schema),
      },
    });

    // Table creation depends on the namespace existing first
    resource.node.addDependency(props.namespace);

    this.tableArn = resource.getAttString('TableArn');
    this.schemaId = resource.getAttString('SchemaId');
  }
}
