import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import { Construct } from 'constructs';
import type { IcebergSchemaDefinition } from './iceberg-schema';
import { IcebergTable } from './iceberg-table';
import { TableManagerProvider } from './table-manager-provider';

/**
 * Definition of a single Iceberg table to be created inside the namespace.
 */
export interface TableDefinition {
  /**
   * Name of the Iceberg table.
   * @example 'events'
   */
  readonly tableName: string;
  /**
   * Declarative Iceberg schema definition.
   */
  readonly schema: IcebergSchemaDefinition;
}

export interface TableNamespaceStackProps extends cdk.StackProps {
  /**
   * The S3 Table Bucket to create the namespace in.
   */
  readonly tableBucket: s3tables.ITableBucket;
  /**
   * The namespace to create within the table bucket.
   * @example 'analytics'
   */
  readonly namespaceName: string;
  /**
   * KMS key used for table bucket encryption.
   * Passed to the table-manager Lambda for encrypt/decrypt permissions.
   */
  readonly encryptionKey: kms.IKey;
  /**
   * List of Iceberg tables to create in the namespace.
   */
  readonly tables: TableDefinition[];
}

/**
 * CDK Stack that creates a namespace and one or more Iceberg tables
 * inside an existing S3 Table Bucket.
 *
 * A single table-manager Lambda and CloudFormation provider are shared
 * across all tables.  Each table is managed as its own custom resource
 * so they can be independently created / updated / deleted.
 */
export class TableNamespaceStack extends cdk.Stack {
  public readonly tableBucket: s3tables.ITableBucket;
  public readonly namespaceName: string;
  public readonly namespace: s3tables.INamespace;
  // Map from table name to the {@link IcebergTable} construct.
  public readonly tables: ReadonlyMap<string, IcebergTable>;

  constructor(scope: Construct, id: string, props: TableNamespaceStackProps) {
    super(scope, id, props);

    this.tableBucket = props.tableBucket;
    this.namespaceName = props.namespaceName;

    this.namespace = new s3tables.Namespace(this, 'Namespace', {
      namespaceName: props.namespaceName,
      tableBucket: props.tableBucket,
    });

    const provider = new TableManagerProvider(this, 'TableManager', {
      tableBucket: props.tableBucket,
      encryptionKey: props.encryptionKey,
    });

    const tableMap = new Map<string, IcebergTable>();

    for (const def of props.tables) {
      const table = new IcebergTable(this, `Table_${def.tableName}`, {
        serviceToken: provider.serviceToken,
        tableBucket: props.tableBucket,
        namespace: this.namespace,
        tableName: def.tableName,
        schema: def.schema,
      });
      tableMap.set(def.tableName, table);
    }

    this.tables = tableMap;
  }
}
