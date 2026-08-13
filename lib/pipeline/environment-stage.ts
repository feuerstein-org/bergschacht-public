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

    const snsPagerDuty = new SnsPagerDutyStack(this, 'SnsPagerDuty', {
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
    // Storage (S3 Tables) and the foerderturm orchestrator are not
    // deployed to prod yet. Prod only gets SnsPagerDuty + the data
    // encryption key above.
    // ---------------------------------------------------------------
    if (props.accountId !== prodAccount) {
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
      const bronze = new TableNamespaceStack(this, 'S3TablesBronzeNamespace', {
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

      // foerderturm Dagster orchestrator. The service's desired count is NOT set here - it is owned
      // at runtime by FoerderturmLifecycle (see the note on the ECS service in FoerderturmStack).
      const dailyStart = { cron: 'cron(30 10 ? * MON-FRI *)' };
      const scheduledLifecycle = { startSchedule: dailyStart, minSessionMinutes: 60 };
      const foerderturmConfig = {
        [devAccount]: { tailscaleHostname: 'foerderturm-dev', lifecycle: {} },
        [stageAccount]: {
          tailscaleHostname: 'foerderturm-stage',
          lifecycle: scheduledLifecycle,
        },
        [prodAccount]: {
          tailscaleHostname: 'foerderturm-prod',
          lifecycle: scheduledLifecycle,
        },
      }[props.accountId];

      if (foerderturmConfig) {
        const foerderturmImage = (artifactName: string): ContainerArtifact =>
          getImageArtifact('foerderturm', artifactName);

        // SSM SecureString holding the Massive API key; create it manually before deploying.
        // The Massive worker (running in-op in its run-worker task) resolves it at runtime.
        const massiveApiKeyParam = `/foerderturm-${props.environment}/massive/api-key`;

        // foerderturm Dagster orchestrator. Every run executes in-op inside its worker's own
        // run-worker image (migration plan Phase 5) launched by the EcsRunLauncher - there is no
        // separate connectors (Lambda/Pipes) data-plane stack anymore; the per-worker task role
        // carries the bronze/staging/SSM data-plane grants.
        new FoerderturmStack(this, 'Foerderturm', {
          environment: props.environment,
          dagsterImageArtifact: foerderturmImage('dagster'),
          tailscaleImageArtifact: foerderturmImage('tailscale'),
          bronze,
          workers: {
            massive: {
              image: foerderturmImage('connector-massive-worker'),
              ssmSecureParams: { MASSIVE_API_KEY_SSM_PARAMETER: massiveApiKeyParam },
            },
            sharadar: { image: foerderturmImage('connector-sharadar-worker') },
            example: { image: foerderturmImage('connector-example-worker') },
          },
          tailscaleHostname: foerderturmConfig.tailscaleHostname,
          lifecycle: foerderturmConfig.lifecycle,
          alertTopic: snsPagerDuty.topic,
          env: { account: props.accountId, region: props.awsRegion },
        });
      }
    }
  }
}
