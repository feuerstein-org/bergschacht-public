import * as cdk from 'aws-cdk-lib/core';
import { AwsSolutionsChecks } from 'cdk-nag';
import { Construct } from 'constructs';
import { SnsPagerDutyStack } from '../infrastructure/sns-pager-duty';
import { FoerderturmStack } from '../infrastructure/foerderturm-stack';
import {
  type ConnectorDefinition,
  FoerderturmConnectorsStack,
} from '../infrastructure/foerderturm-connectors-stack';
import { devAccount, stageAccount, prodAccount } from '../config/constants';
import { getImageArtifact } from '../config/version-manifest';

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

    // TODO: Eventually add ServiceEncryptionKey which not encrypt data related to services.
    // Currently not done to reduce complexity & KMS cost

    // foerderturm Dagster orchestrator. desiredCount=0 keeps dev/staging off by default
    const foerderturmConfig = {
      [devAccount]: { desiredCount: 0, tailscaleHostname: 'foerderturm-dev' },
      [stageAccount]: { desiredCount: 0, tailscaleHostname: 'foerderturm-stage' },
      [prodAccount]: { desiredCount: 0, tailscaleHostname: 'foerderturm-prod' }, // TODO: Set to 1 when production is fully running
    }[props.accountId];

    if (foerderturmConfig) {
      const foerderturm = new FoerderturmStack(this, 'Foerderturm', {
        environment: props.environment,
        dagsterImageArtifact: getImageArtifact('foerderturm', 'dagster'),
        litestreamImageArtifact: getImageArtifact('foerderturm', 'litestream'),
        tailscaleImageArtifact: getImageArtifact('foerderturm', 'tailscale'),
        desiredCount: foerderturmConfig.desiredCount,
        tailscaleHostname: foerderturmConfig.tailscaleHostname,
        env: { account: props.accountId, region: props.awsRegion },
      });

      // Connector Lambdas (data plane).
      const connectors: ConnectorDefinition[] = [
        {
          vendor: 'example',
          imageArtifact: getImageArtifact('foerderturm', 'connector-example-lambda-container'),
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
