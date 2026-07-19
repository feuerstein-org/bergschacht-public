import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import {
  TableNamespaceStack,
  TableDefinition,
} from '../../lib/infrastructure/table-namespace-stack';
import { IcebergSchemaDefinition } from '../../lib/infrastructure/iceberg-schema';
import { _loadManifestFromData } from '../../lib/config/version-manifest';

const testSchema: IcebergSchemaDefinition = {
  columns: [
    { name: 'id', type: 'string', required: true, doc: 'Primary key' },
    { name: 'event_time', type: 'timestamptz', required: true, doc: 'Event timestamp' },
    { name: 'payload', type: 'string', doc: 'JSON payload' },
  ],
  partitionSpec: [{ sourceColumn: 'event_time', transform: 'day', name: 'event_day' }],
  sortOrder: [{ sourceColumn: 'event_time', direction: 'asc', nullOrder: 'nulls-last' }],
};

const secondSchema: IcebergSchemaDefinition = {
  columns: [
    { name: 'user_id', type: 'string', required: true, doc: 'User identifier' },
    { name: 'name', type: 'string', doc: 'User display name' },
  ],
};

const testArtifact = {
  bucket: 'example-lambda-artifacts',
  key: 'bergschacht-custom-resources/lambdas/s3tables-table-manager/v0.1.0.zip',
  objectVersion: 'abc123',
  version: '0.1.0',
  commitSha: 'deadbeef',
};

/**
 * Creates a TableNamespaceStack with the given table definitions for testing.
 * @param tables - Array of table definitions to include in the stack
 * @returns Object containing the stack and its template
 */
function createStack(tables: TableDefinition[]) {
  _loadManifestFromData({
    schemaVersion: '1.0.0',
    repositories: {
      'bergschacht-custom-resources': {
        source: 'feuerstein-org/bergschacht-custom-resources',
        lambdas: {
          's3tables-table-manager': { latest: testArtifact },
        },
      },
    },
  });
  const app = new cdk.App();
  const kmsStack = new cdk.Stack(app, 'DataKey');
  const key = new kms.Key(kmsStack, 'Key');
  const bucketStack = new cdk.Stack(app, 'DataBucket');
  const tableBucket = new s3tables.TableBucket(bucketStack, 'TableBucket', {
    tableBucketName: 'test-table-bucket',
  });
  const stack = new TableNamespaceStack(app, 'TestNamespace', {
    tableBucket,
    namespaceName: 'test_namespace',
    encryptionKey: key,
    tables,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('TableNamespaceStack', () => {
  let template: Template;

  beforeEach(() => {
    ({ template } = createStack([{ tableName: 'test_table', schema: testSchema }]));
  });

  test('creates namespace in table bucket', () => {
    template.hasResourceProperties('AWS::S3Tables::Namespace', {
      Namespace: 'test_namespace',
    });
  });

  test('creates table manager Lambda function', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      Handler: 's3tables_table_manager.handler.handler',
      Runtime: 'python3.14',
      Timeout: 300,
      MemorySize: 256,
    });
  });

  test('creates custom resource for table lifecycle management', () => {
    template.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      Namespace: 'test_namespace',
      TableName: 'test_table',
    });
  });

  test('sets DeletionPolicy=Retain on the custom resource by default', () => {
    template.hasResource('AWS::CloudFormation::CustomResource', {
      DeletionPolicy: 'Retain',
    });
  });

  test('grants CreateTable and DeleteTable to the Lambda role', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: [
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
            Effect: 'Allow',
          }),
        ]),
      },
    });
  });

  test('resource count is correct for single table', () => {
    template.resourceCountIs('AWS::S3Tables::TableBucket', 0);
    template.resourceCountIs('AWS::S3Tables::Namespace', 1);
    template.resourceCountIs('AWS::S3Tables::Table', 0); // the custom resource manages the tables
    template.resourceCountIs('AWS::CloudFormation::CustomResource', 1);
  });

  test('only one Lambda is created when multiple tables are defined', () => {
    const { template: multiTemplate } = createStack([
      { tableName: 'events', schema: testSchema },
      { tableName: 'users', schema: secondSchema },
    ]);

    // One handler Lambda + one provider framework Lambda - but two custom resources
    multiTemplate.resourceCountIs('AWS::Lambda::Function', 2);
    multiTemplate.resourceCountIs('AWS::CloudFormation::CustomResource', 2);
  });

  test('multi-table stack creates custom resources for each table', () => {
    const { template: multiTemplate } = createStack([
      { tableName: 'events', schema: testSchema },
      { tableName: 'users', schema: secondSchema },
    ]);

    multiTemplate.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      TableName: 'events',
      Namespace: 'test_namespace',
    });
    multiTemplate.hasResourceProperties('AWS::CloudFormation::CustomResource', {
      TableName: 'users',
      Namespace: 'test_namespace',
    });
  });

  test('exposes tables map with correct entries', () => {
    const { stack } = createStack([
      { tableName: 'events', schema: testSchema },
      { tableName: 'users', schema: secondSchema },
    ]);

    expect(stack.tables.size).toBe(2);
    expect(stack.tables.has('events')).toBe(true);
    expect(stack.tables.has('users')).toBe(true);
    expect(stack.tables.get('events')!.tableName).toBe('events');
  });
});
