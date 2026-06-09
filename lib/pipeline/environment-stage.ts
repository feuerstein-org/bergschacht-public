import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { TableNamespaceStack } from '../infrastructure/table-namespace-stack';
import { TableBucketStack } from '../infrastructure/table-bucket-stack';
import { SharedKmsKeyStack } from '../infrastructure/shared-kms-key-stack';
import { SnsPagerDutyStack } from '../infrastructure/sns-pager-duty';
import { BRONZE_TABLES } from '../infrastructure/schemas';
import { FoerderturmStack } from '../infrastructure/foerderturm-stack';
import {
  type ConnectorDefinition,
  FoerderturmConnectorsStack,
} from '../infrastructure/foerderturm-connectors-stack';
import { devAccount, stageAccount, prodAccount } from '../config/constants';
import { type ContainerArtifact, getImageArtifact } from '../config/version-manifest';

export interface EnvironmentStageProps extends cdk.StageProps {
  /**
   * Environment name (e.g. 'dev', 'stage', 'prod')
   */
  readonly environment: string;
  /**
   * The target account ID for this environment
   */
  readonly accountId: string;
  /**
   * AWS region for deployment
   */
  readonly awsRegion: string;
  /**
   * Email address for PagerDuty alerts
   */
  readonly pagerDutyEmail: string;
}

/**
 * Stage containing application workload stacks for a given environment.
 * These are stacks that consume the version manifest (ECS services, Lambda functions, etc.)
 * and change frequently with every application deployment.
 *
 * Used by both the Production Pipeline (prod) and the Development Pipeline (dev branches).
 * Infrastructure stacks (ReadOnlyRole, KMS, ECR, etc.) live in CicdStage.
 */
export class EnvironmentStage extends cdk.Stage {
  constructor(scope: Construct, id: string, props: EnvironmentStageProps) {
    super(scope, id, props);

    cdk.Aspects.of(this).add(new AwsSolutionsChecks({ verbose: true }));

    new SnsPagerDutyStack(this, 'SnsPagerDuty', {
      topicName: `PagerDutyAlerts${id}`,
      emailAddress: props.pagerDutyEmail,
      env: { account: props.accountId, region: props.awsRegion },
    });

    const keyAlias = `feuerstein-data-key-${id}`.toLowerCase();

    const dataEncryptionKey = new SharedKmsKeyStack(this, 'DataEncryptionKey', {
      kmsDescription: 'KMS key for data encryption (S3 Tables, analytics, etc.)',
      keyAlias,
      additionalResourcePolicy: [
        // https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-tables-kms-permissions.html
        new iam.PolicyStatement({
          sid: 'AllowS3TablesServiceAccess',
          effect: iam.Effect.ALLOW,
          principals: [
            new iam.ServicePrincipal('maintenance.s3tables.amazonaws.com'),
            new iam.ServicePrincipal('metadata.s3.amazonaws.com'),
          ],
          actions: ['kms:GenerateDataKey', 'kms:Decrypt'],
          resources: ['*'],
          conditions: {
            StringEquals: {
              'aws:SourceAccount': props.accountId,
            },
          },
        }),
      ],
      env: { account: props.accountId, region: props.awsRegion },
    });

    // ---------------------------------------------------------------
    // Shared erzlager table bucket
    // ---------------------------------------------------------------
    const erzlager = new TableBucketStack(this, 'S3TablesErzlager', {
      tableBucketName: `example-erzlager-${id}`.toLowerCase(),
      encryptionKey: dataEncryptionKey.key,
      env: { account: props.accountId, region: props.awsRegion },
    });

    // ---------------------------------------------------------------
    // Bronze namespace - raw, append-only vendor data
    // ---------------------------------------------------------------
    new TableNamespaceStack(this, 'S3TablesBronzeNamespace', {
      tableBucket: erzlager.tableBucket,
      namespaceName: 'bronze',
      encryptionKey: dataEncryptionKey.key,
      tables: BRONZE_TABLES,
      env: { account: props.accountId, region: props.awsRegion },
    });

    // ---------------------------------------------------------------
    // Gold namespace - single authoritative golden copy
    // ---------------------------------------------------------------
    // new TableNamespaceStack(this, 'S3TablesGoldNamespace', {
    //   tableBucket: erzlager.tableBucket,
    //   namespaceName: 'gold',
    //   encryptionKey: dataEncryptionKey.key,
    //   tables: GOLD_TABLES,
    //   env: { account: props.accountId, region: props.awsRegion },
    // });

    // TODO: Eventually add ServiceEncryptionKey which not encrypt data related to services.
    // Currently not done to reduce complexity & KMS cost

    // foerderturm Dagster orchestrator. desiredCount=0 keeps dev/staging off by default
    const foerderturmConfig = {
      [devAccount]: { desiredCount: 0, tailscaleHostname: 'foerderturm-dev' },
      [stageAccount]: { desiredCount: 0, tailscaleHostname: 'foerderturm-stage' },
      [prodAccount]: { desiredCount: 0, tailscaleHostname: 'foerderturm-prod' }, // TODO: Set to 1 when production is fully running
    }[props.accountId];

    if (foerderturmConfig) {
      // TODO: (foerderturm 2.0): Remove this prod pin once 2.0 is validated on dev.
      const foerderturmImage = (artifactName: string): ContainerArtifact => {
        const artifact = getImageArtifact('foerderturm', artifactName);
        if (props.accountId !== prodAccount) return artifact;
        const pinnedVersion = '0.1.5';
        return {
          ...artifact,
          imageTag: `foerderturm-${artifactName}-${pinnedVersion}`,
          version: pinnedVersion,
        };
      };

      const foerderturm = new FoerderturmStack(this, 'Foerderturm', {
        environment: props.environment,
        dagsterImageArtifact: foerderturmImage('dagster'),
        litestreamImageArtifact: foerderturmImage('litestream'),
        tailscaleImageArtifact: foerderturmImage('tailscale'),
        desiredCount: foerderturmConfig.desiredCount,
        tailscaleHostname: foerderturmConfig.tailscaleHostname,
        env: { account: props.accountId, region: props.awsRegion },
      });

      // Connector Lambdas (data plane).
      const connectors: ConnectorDefinition[] = [
        {
          vendor: 'example',
          imageArtifact: foerderturmImage('connector-example-lambda-container'),
        },
      ];
      new FoerderturmConnectorsStack(this, 'FoerderturmConnectors', {
        environment: props.environment,
        connectors,
        pipesMessagesBucket: foerderturm.pipesMessagesBucket,
        env: { account: props.accountId, region: props.awsRegion },
      });
    }
  }
}
