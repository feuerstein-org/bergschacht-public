import * as cdk from 'aws-cdk-lib/core';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Construct } from 'constructs';

export interface SharedKmsKeyStackProps extends cdk.StackProps {
  /**
   * Description for the KMS key
   * @default 'Shared KMS key for encryption'
   */
  readonly kmsDescription?: string;
  /**
   * AWS account IDs that should be granted decrypt permissions
   * @default - No additional accounts granted decrypt access
   */
  readonly allowedDecryptAccountIds?: string[];
  /**
   * Alias name for the KMS key (without the 'alias/' prefix)
   * @default - No alias is created
   */
  readonly keyAlias?: string;
}

/**
 * CDK Stack that creates a shared KMS key for encrypting resources across accounts.
 * This key can be used by ECR, S3, and other AWS services for encryption.
 */
export class SharedKmsKeyStack extends cdk.Stack {
  public readonly key: kms.IKey;

  constructor(scope: Construct, id: string, props: SharedKmsKeyStackProps = {}) {
    super(scope, id, props);

    // Create the shared KMS key
    this.key = new kms.Key(this, 'SharedEncryptionKey', {
      description: props.kmsDescription ?? 'Shared KMS key for encryption',
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Create alias for the key if provided
    let keyAlias: kms.Alias | undefined;
    if (props.keyAlias) {
      keyAlias = new kms.Alias(this, 'KeyAlias', {
        aliasName: `alias/${props.keyAlias}`,
        targetKey: this.key,
      });
    }

    // Grant decrypt permission to specified accounts
    if (props.allowedDecryptAccountIds && props.allowedDecryptAccountIds.length > 0) {
      this.key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowDecryptFromAccounts',
          effect: iam.Effect.ALLOW,
          principals: props.allowedDecryptAccountIds.map(
            (accountId) => new iam.AccountPrincipal(accountId)
          ),
          actions: ['kms:Decrypt', 'kms:DescribeKey'],
          resources: ['*'],
        })
      );

      // Give Lambda permissions to pull the image
      this.key.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowDecryptFromCrossAccountLambda',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
          actions: ['kms:Decrypt', 'kms:DescribeKey'],
          resources: ['*'],
          conditions: {
            StringLike: {
              'aws:sourceArn': props.allowedDecryptAccountIds.map(
                (accountId) => `arn:aws:lambda:*:${accountId}:function:*`
              ),
            },
          },
        })
      );
    }

    // Export key ID and ARN as CloudFormation outputs
    new cdk.CfnOutput(this, 'KeyId', {
      value: this.key.keyId,
      description: 'KMS Key ID',
      exportName: `${this.stackName}-KeyId`,
    });

    new cdk.CfnOutput(this, 'KeyArn', {
      value: this.key.keyArn,
      description: 'KMS Key ARN',
      exportName: `${this.stackName}-KeyArn`,
    });

    if (keyAlias) {
      new cdk.CfnOutput(this, 'KeyAliasName', {
        value: keyAlias.aliasName,
        description: 'KMS Key Alias Name',
        exportName: `${this.stackName}-KeyAliasName`,
      });
    }
  }
}
