import * as cdk from 'aws-cdk-lib/core';
import * as ecr from 'aws-cdk-lib/aws-ecr';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as events from 'aws-cdk-lib/aws-events';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface EcrStackProps extends cdk.StackProps {
  /**
   * The name of the ECR repository
   * @example 'feuerstein'
   */
  readonly repositoryName: string;
  /**
   * SNS topic to send image scan finding notifications on CRITICAL or HIGH severity findings
   * @default - No notifications sent
   */
  readonly notificationTopic?: sns.ITopic;
  /**
   * List of AWS account IDs that should be allowed to pull images from this repository
   * @default - No cross-account access granted
   */
  readonly allowedPullAccountIds?: string[];
  /**
   * Wildcard pattern for mutable image tags. When provided, tags matching this pattern
   * will be excluded from immutability enforcement.
   * @example '*latest'
   * @default - No exclusion filter, all tags are immutable
   */
  readonly mutableTagWildcard?: string;
  /**
   * ARN of the KMS key for encrypting repository images.
   * The key is imported internally via Key.fromKeyArn.
   */
  readonly encryptionKeyArn: string;
}

/**
 * CDK Stack that creates an ECR repository for storing images.
 */
export class EcrStack extends cdk.Stack {
  public readonly repository: ecr.IRepository;
  public readonly encryptionKey: kms.IKey;

  constructor(scope: Construct, id: string, props: EcrStackProps) {
    super(scope, id, props);

    this.encryptionKey = kms.Key.fromKeyArn(this, 'EncryptionKey', props.encryptionKeyArn);

    // Create ECR repository
    this.repository = new ecr.Repository(this, 'Repository', {
      repositoryName: props.repositoryName,
      imageScanOnPush: true,
      encryption: ecr.RepositoryEncryption.KMS,
      encryptionKey: this.encryptionKey,
      imageTagMutability: props.mutableTagWildcard
        ? ecr.TagMutability.IMMUTABLE_WITH_EXCLUSION
        : ecr.TagMutability.IMMUTABLE,
      ...(props.mutableTagWildcard && {
        imageTagMutabilityExclusionFilters: [
          ecr.ImageTagMutabilityExclusionFilter.wildcard(props.mutableTagWildcard),
        ],
      }),
      lifecycleRules: [
        {
          description: 'Recycle older images',
          maxImageCount: 30,
          rulePriority: 1,
        },
      ],
    });

    // Grant cross-account pull permissions if specified
    if (props.allowedPullAccountIds && props.allowedPullAccountIds.length > 0) {
      this.repository.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountPull',
          effect: iam.Effect.ALLOW,
          principals: props.allowedPullAccountIds.map(
            (accountId) => new iam.AccountPrincipal(accountId)
          ),
          actions: [
            'ecr:GetDownloadUrlForLayer',
            'ecr:BatchGetImage',
            'ecr:BatchCheckLayerAvailability',
          ],
        })
      );

      // Give Lambda permissions to pull the image
      this.repository.addToResourcePolicy(
        new iam.PolicyStatement({
          sid: 'AllowCrossAccountLambdaPull',
          effect: iam.Effect.ALLOW,
          principals: [new iam.ServicePrincipal('lambda.amazonaws.com')],
          actions: ['ecr:GetDownloadUrlForLayer', 'ecr:BatchGetImage'],
          conditions: {
            StringLike: {
              'aws:sourceArn': props.allowedPullAccountIds.map(
                (accountId) => `arn:aws:lambda:${this.region}:${accountId}:function:*`
              ),
            },
          },
        })
      );
    }

    new cdk.CfnOutput(this, 'RepositoryUri', {
      value: this.repository.repositoryUri,
      description: 'ECR Repository URI',
    });

    new cdk.CfnOutput(this, 'RepositoryArn', {
      value: this.repository.repositoryArn,
      description: 'ECR Repository ARN',
    });

    // Create EventBridge rule for ECR image scan findings if notification topic is provided
    if (props.notificationTopic) {
      const rule = new events.Rule(this, 'ImageScanFindingRule', {
        description: `Notify on ECR image scan findings for ${props.repositoryName}`,
        eventPattern: {
          source: ['aws.ecr'],
          detailType: ['ECR Image Scan'],
          detail: {
            'repository-name': [props.repositoryName],
            'scan-status': ['COMPLETE'],
            'finding-severity-counts': {
              $or: [{ CRITICAL: [{ exists: true }] }, { HIGH: [{ exists: true }] }],
            },
          },
        },
      });

      rule.addTarget(
        new targets.SnsTopic(props.notificationTopic, {
          message: events.RuleTargetInput.fromObject({
            description: `ECR image scan completed for ${props.repositoryName} with vulnerabilities detected`,
            event: events.EventField.fromPath('$'),
          }),
        })
      );

      new cdk.CfnOutput(this, 'ScanNotificationRuleArn', {
        value: rule.ruleArn,
        description: 'EventBridge rule ARN for ECR scan notifications',
      });
    }
  }
}
