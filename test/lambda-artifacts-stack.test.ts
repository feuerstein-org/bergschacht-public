import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { LambdaArtifactsStack } from '../lib/lambda-artifacts-stack';

/**
 * Helper function to create a mock KMS key for testing
 */
function createMockKmsKey(app: cdk.App): kms.IKey {
  const keyStack = new cdk.Stack(app, 'Key');
  return new kms.Key(keyStack, 'TestKey');
}

describe('LambdaArtifactsStack', () => {
  let stack: LambdaArtifactsStack;
  let template: Template;

  beforeEach(() => {
    const app = new cdk.App();
    const encryptionKey = createMockKmsKey(app);
    stack = new LambdaArtifactsStack(app, 'TestLambdaArtifacts', {
      bucketName: 'test-lambda-artifacts',
      encryptionKey,
    });
    template = Template.fromStack(stack);
  });

  test('creates S3 bucket with correct name and properties', () => {
    template.resourceCountIs('AWS::S3::Bucket', 1);
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketName: 'test-lambda-artifacts',
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
      VersioningConfiguration: {
        Status: 'Enabled',
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('configures lifecycle rules', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          {
            Id: 'DeleteOldVersions',
            NoncurrentVersionExpiration: {
              NoncurrentDays: 90,
            },
            Status: 'Enabled',
          },
          {
            Id: 'AbortIncompleteMultipartUpload',
            AbortIncompleteMultipartUpload: {
              DaysAfterInitiation: 7,
            },
            Status: 'Enabled',
          },
        ]),
      },
    });
  });

  test('enforces SSL access', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 's3:*',
            Effect: 'Deny',
            Condition: {
              Bool: {
                'aws:SecureTransport': 'false',
              },
            },
          }),
        ]),
      },
    });
  });

  test('does not configure server access logs when bucket is not provided', () => {
    // The bucket should not have ServerAccessLogsConfiguration when not provided
    const bucketResource = template.findResources('AWS::S3::Bucket');
    const bucketConfig = Object.values(bucketResource)[0] as {
      Properties: { LoggingConfiguration?: unknown };
    };
    expect(bucketConfig.Properties.LoggingConfiguration).toBeUndefined();
  });

  test('does not create cross-account policy when allowedAccountIds is not provided', () => {
    template.hasResourceProperties('AWS::S3::BucketPolicy', {
      PolicyDocument: {
        Statement: Match.not(
          Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:GetObject*', 's3:GetBucket*', 's3:List*']),
              Principal: {
                AWS: Match.objectLike({
                  'Fn::Join': Match.arrayWith([
                    Match.arrayWith([Match.stringLikeRegexp('arn:.*:iam::[0-9]+:root')]),
                  ]),
                }),
              },
            }),
          ])
        ),
      },
    });
  });

  test('creates CloudFormation outputs', () => {
    template.hasOutput('BucketName', {
      Description: 'S3 Bucket name for Lambda artifacts',
    });

    template.hasOutput('BucketArn', {
      Description: 'S3 Bucket ARN for Lambda artifacts',
    });
  });

  test('exports the bucket for use in other stacks', () => {
    expect(stack.bucket).toBeDefined();
  });

  describe('with cross-account access', () => {
    let templateWithCrossAccount: Template;

    beforeEach(() => {
      const app = new cdk.App();
      const encryptionKey = createMockKmsKey(app);
      const stack = new LambdaArtifactsStack(app, 'TestLambdaArtifactsCrossAccount', {
        bucketName: 'test-lambda-artifacts',
        allowedAccountIds: ['111111111111', '222222222222'],
        encryptionKey,
      });
      templateWithCrossAccount = Template.fromStack(stack);
    });

    test('creates cross-account policy for specified accounts', () => {
      templateWithCrossAccount.hasResourceProperties('AWS::S3::BucketPolicy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'AllowCrossAccountRead',
              Effect: 'Allow',
              Principal: {
                AWS: Match.arrayWith([
                  Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                      Match.arrayWith([Match.stringLikeRegexp('.*111111111111')]),
                    ]),
                  }),
                  Match.objectLike({
                    'Fn::Join': Match.arrayWith([
                      Match.arrayWith([Match.stringLikeRegexp('.*222222222222')]),
                    ]),
                  }),
                ]),
              },
              Action: [
                's3:GetObject',
                's3:GetObjectVersion',
                's3:GetBucketLocation',
                's3:ListBucket',
              ],
            }),
          ]),
        },
      });
    });
  });

  describe('with server access logging', () => {
    test('accepts a serverAccessLogsBucket parameter', () => {
      const app = new cdk.App();
      const encryptionKey = createMockKmsKey(app);

      // Create a logging bucket in the same stack
      const stack = new cdk.Stack(app, 'TestLambdaArtifactsWithLogging');
      const loggingBucket = new s3.Bucket(stack, 'LoggingBucket', {
        objectOwnership: s3.ObjectOwnership.BUCKET_OWNER_PREFERRED,
      });

      // Create Lambda artifacts bucket with logging in the same construct scope
      new s3.Bucket(stack, 'LambdaArtifactsBucket', {
        bucketName: 'test-lambda-artifacts-with-logging',
        encryption: s3.BucketEncryption.KMS,
        encryptionKey,
        serverAccessLogsBucket: loggingBucket,
        serverAccessLogsPrefix: 'lambda-artifacts/',
      });

      const template = Template.fromStack(stack);

      // Verify that the logging configuration is present
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketName: 'test-lambda-artifacts-with-logging',
        LoggingConfiguration: {
          DestinationBucketName: {
            Ref: Match.stringLikeRegexp('LoggingBucket.*'),
          },
          LogFilePrefix: 'lambda-artifacts/',
        },
      });
    });
  });
});
