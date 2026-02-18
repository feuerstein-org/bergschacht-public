import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';
import { CentralLoggingBucketStack } from '../lib/central-logging-bucket-stack';

const TEST_KMS_KEY_ARN = 'arn:aws:kms:us-east-1:111111111111:key/test-key-id';

describe('CentralLoggingBucketStack', () => {
  let stack: CentralLoggingBucketStack;
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    stack = new CentralLoggingBucketStack(app, 'TestCentralLoggingBucket', {
      bucketName: 'test-central-logs',
      encryptionKeyArn: TEST_KMS_KEY_ARN,
    });
    template = Template.fromStack(stack);
  });

  test('creates S3 bucket with correct name and properties', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'test-central-logs',
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          {
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: {
              SSEAlgorithm: 'aws:kms',
            },
          },
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      OwnershipControls: {
        Rules: [
          {
            ObjectOwnership: 'BucketOwnerPreferred',
          },
        ],
      },
    });
  });

  test('does not enable versioning', () => {
    // When versioning is false/disabled, CDK doesn't add VersioningConfiguration property
    const json = template.toJSON();
    const bucketProps = json.Resources.CentralLoggingBucketD84ADEE9.Properties;
    // Versioning configuration is simply not present when disabled
    expect(bucketProps.VersioningConfiguration).toBeUndefined();
  });

  test('configures lifecycle rules for log retention', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: [
          {
            Id: 'DeleteOldLogs',
            ExpirationInDays: 90,
            Status: 'Enabled',
          },
          {
            Id: 'TransitionToGlacierIR',
            Status: 'Enabled',
            Transitions: [
              {
                StorageClass: 'GLACIER_IR',
                TransitionInDays: 0,
              },
            ],
          },
          {
            Id: 'AbortIncompleteMultipartUpload',
            AbortIncompleteMultipartUpload: {
              DaysAfterInitiation: 7,
            },
            Status: 'Enabled',
          },
        ],
      },
    });
  });

  test('enforces SSL access and allows S3 logging service', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: [
          {
            Action: 's3:*',
            Effect: 'Deny',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
          },
          {
            Action: 's3:PutObject',
            Effect: 'Allow',
            Principal: {
              Service: 'logging.s3.amazonaws.com',
            },
            Condition: {
              StringEquals: {
                'aws:SourceAccount': {
                  Ref: 'AWS::AccountId',
                },
              },
            },
          },
        ],
      },
    });
  });

  test('does not configure server access logs (to avoid infinite loop)', () => {
    const bucketResource = template.findResources('AWS::S3::Bucket');
    const bucketConfig = Object.values(bucketResource)[0] as {
      Properties: { LoggingConfiguration?: unknown };
    };
    expect(bucketConfig.Properties.LoggingConfiguration).toBeUndefined();
  });

  test('creates CloudFormation outputs', () => {
    template.hasOutput('BucketName', {
      Description: 'S3 Bucket name for centralized access logs',
    });

    template.hasOutput('BucketArn', {
      Description: 'S3 Bucket ARN for centralized access logs',
    });
  });

  test('exports the bucket for use in other stacks', () => {
    expect(stack.bucket).toBeDefined();
  });
});
