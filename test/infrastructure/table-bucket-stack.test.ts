import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import * as kms from 'aws-cdk-lib/aws-kms';
import { TableBucketStack } from '../../lib/infrastructure/table-bucket-stack.ts';

describe('TableBucketStack', () => {
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const kmsStack = new cdk.Stack(app, 'DataKey');
    const key = new kms.Key(kmsStack, 'Key');
    const stack = new TableBucketStack(app, 'TestTableBucket', {
      tableBucketName: 'test-erzlager',
      encryptionKey: key,
    });
    template = Template.fromStack(stack);
  });

  test('creates S3 Table Bucket with correct name', () => {
    template.hasResourceProperties('AWS::S3Tables::TableBucket', {
      TableBucketName: 'test-erzlager',
    });
  });

  test('enables KMS encryption', () => {
    template.hasResourceProperties('AWS::S3Tables::TableBucket', {
      EncryptionConfiguration: {
        SSEAlgorithm: 'aws:kms',
      },
    });
  });

  test('enables unreferenced file removal', () => {
    template.hasResourceProperties('AWS::S3Tables::TableBucket', {
      UnreferencedFileRemoval: {
        Status: 'Enabled',
        UnreferencedDays: 10,
        NoncurrentDays: 10,
      },
    });
  });

  test('outputs table bucket ARN', () => {
    template.hasOutput('TableBucketArn', {
      Description: 'S3 Table Bucket ARN',
    });
  });

  test('creates exactly one table bucket', () => {
    template.resourceCountIs('AWS::S3Tables::TableBucket', 1);
  });
});
