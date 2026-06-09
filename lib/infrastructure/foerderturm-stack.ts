import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { ContainerArtifact, getContainerImage } from '../config/version-manifest';
import { connectorFunctionName, connectorFunctionPrefix } from '../config/constants';

/** Default Tailscale ACL tag the sidecar advertises. Must exist in the tailnet admin policy. */
const DEFAULT_TAILSCALE_TAG = 'tag:foerderturm';

/** Path the Litestream image bakes its config to (set in foerderturm's litestream.Dockerfile). */
const LITESTREAM_CONFIG_PATH = '/etc/litestream.yml';

/** Path the Tailscale image bakes its serve config to (set in foerderturm's tailscale.Dockerfile). */
const TAILSCALE_SERVE_CONFIG_PATH = '/etc/tailscale/serve.json';

/** Volume name for the task-scoped SQLite directory shared by the Dagster + Litestream containers. */
const DAGSTER_HOME_VOLUME = 'dagster-home';
const DAGSTER_HOME_PATH = '/app/dagster_home';

export interface FoerderturmStackProps extends cdk.StackProps {
  /**
   * Environment name (e.g. 'dev', 'stage', 'prod') suffixed onto account-scoped resource names
   * (ECS cluster, service, log group) and the connector Lambda names this stack invokes, so
   * they're disambiguated in the console/CLI even though each environment is a separate account.
   * @example 'prod'
   */
  readonly environment: string;
  /**
   * Dagster container image artifact resolved from the version manifest.
   * Used for the dagster-init, dagster-webserver, and dagster-daemon containers.
   * @example getImageArtifact('foerderturm', 'foerderturm')
   */
  readonly dagsterImageArtifact: ContainerArtifact;
  /**
   * Litestream container image artifact resolved from the version manifest.
   * @example getImageArtifact('foerderturm', 'foerderturm-litestream')
   */
  readonly litestreamImageArtifact: ContainerArtifact;
  /**
   * Tailscale container image artifact resolved from the version manifest. Same ECR repo as
   * the Dagster/Litestream images, baked with `/etc/tailscale/serve.json` so we don't need
   * to inject the serve config from this stack.
   * @example getImageArtifact('foerderturm', 'foerderturm-tailscale')
   */
  readonly tailscaleImageArtifact: ContainerArtifact;
  /**
   * Number of Fargate tasks to run 0 or 1. Set to 0 in dev/staging to reduce costs.
   * Each task has its own ephemeral copy of the SQLite stores; running two would diverge
   * @example 1
   */
  readonly desiredCount: number;
  /**
   * Tailnet MagicDNS hostname this task registers as.
   * Resulting URL: https://<hostname>.<tailnet>.ts.net/
   * @example 'foerderturm-prod'
   */
  readonly tailscaleHostname: string;
  /**
   * Tailscale ACL tag the sidecar will advertise. The OAuth client must be authorized to issue
   * auth keys for this tag (configured in the Tailscale admin console).
   * @example 'tag:foerderturm'
   * @default 'tag:foerderturm'
   */
  readonly tailscaleTag?: string;
  /**
   * Task vCPU units. 256 = 0.25, 512 = 0.5, 1024 = 1, etc.
   * @example 512
   * @default 512
   */
  readonly cpu?: number;
  /**
   * Task memory in MiB. Must be a valid Fargate cpu/memory combination.
   * @example 2048
   * @default 2048
   */
  readonly memoryMiB?: number;
}

/**
 * Fargate-hosted Dagster orchestrator (foerderturm) with Litestream-backed SQLite
 * durability and a Tailscale sidecar for ingress.
 *
 * Architecture:
 * - Minimal per-env VPC, public subnets only (no NAT)
 * - One Fargate task, six containers; the four SQLite-touching ones share a task-scoped
 *   `dagster-home` volume mounted at /app/dagster_home:
 *     1. litestream-restore (init) - restores SQLite stores from S3 and chowns the volume to uid 1000.
 *     2. dagster-init (init) - runs `dagster instance migrate` so webserver+daemon don't race
 *        on alembic CREATE TABLE on first boot. Depends on (1) SUCCESS.
 *     3. dagster-webserver - Dagster UI + GraphQL on :3000. Depends on (2) SUCCESS.
 *     4. dagster-daemon - schedules, sensors, run queue. Depends on (2) SUCCESS.
 *     5. litestream - streaming WAL replication to S3. Depends on (2) SUCCESS (so the schema is
 *        fully migrated before Litestream attaches and forces WAL mode).
 *     6. tailscale - tagged node serving HTTPS:443 -> http://127.0.0.1:3000 via MagicDNS.
 * - The reason we need a separate litestream-restore and normal litestream conatiner is that
 *   normally litestream executes the application using exec but we have 2 (webserver and daemon)
 *   so we need to first restore the DB, then start dagster init to bootstrap if needed, then litestream
 *   and then the actual applications
 *
 * Operator setup (out of scope for CDK):
 * - Create the `tag:foerderturm` tag and an OAuth client in the Tailscale admin console
 *   with `auth_keys` scope authorized for that tag.
 * - In each env account, create an SSM SecureString parameter at
 *   `/foerderturm-<env>/tailscale/oauth-client` (e.g. `/foerderturm-prod/tailscale/oauth-client`)
 *   holding the OAuth client secret
 *   (`tskey-client-...`). CloudFormation cannot create SecureString parameters, so this
 *   must be done out-of-band (e.g. `aws ssm put-parameter --type SecureString`) before
 *   the task starts. OAuth is required for tailscale to mint auth keys to allow out container
 *   to connect to the tailnet (give Auth Keys permissions to the oauth key you create)
 */
export class FoerderturmStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly cluster: ecs.ICluster;
  public readonly service: ecs.IFargateService;
  public readonly litestreamBucket: s3.IBucket;
  public readonly pipesMessagesBucket: s3.IBucket;
  public readonly tailscaleSecret: ssm.IStringParameter;
  public readonly logGroup: logs.ILogGroup;

  constructor(scope: Construct, id: string, props: FoerderturmStackProps) {
    super(scope, id, props);

    const cpu = props.cpu ?? 512;
    const memoryMiB = props.memoryMiB ?? 2048;
    const tailscaleTag = props.tailscaleTag ?? DEFAULT_TAILSCALE_TAG;
    const environment = props.environment;

    // TODO: Eventually transition to IPv6 only?

    // ---- VPC: minimal, public-only, no NAT ----
    this.vpc = new ec2.Vpc(this, 'Vpc', {
      natGateways: 0,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
      ],
      restrictDefaultSecurityGroup: true,
    });

    // ---- Litestream replication bucket ----
    this.litestreamBucket = new s3.Bucket(this, 'LitestreamBucket', {
      encryption: s3.BucketEncryption.KMS_MANAGED,
      bucketKeyEnabled: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'ExpireOldLitestreamGenerations',
          noncurrentVersionExpiration: cdk.Duration.days(30),
          enabled: true,
        },
        {
          id: 'AbortIncompleteMultipartUpload',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          enabled: true,
        },
      ],
    });

    // ---- Dagster Pipes message bucket ----
    // The connector workers write Pipes message chunks here the daemon/webserver read them back
    this.pipesMessagesBucket = new s3.Bucket(this, 'PipesMessagesBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      lifecycleRules: [
        { id: 'ExpirePipesMessages', expiration: cdk.Duration.days(1), enabled: true },
        {
          id: 'AbortIncompleteMultipartUpload',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(1),
          enabled: true,
        },
      ],
    });

    // ---- Tailscale OAuth client secret (SSM SecureString, created out-of-band) ----
    this.tailscaleSecret = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'TailscaleOAuthSecret',
      { parameterName: `/foerderturm-${environment}/tailscale/oauth-client` }
    );

    // Tailscale creates and manages this SSM parameter itself on first boot.
    const tailscaleStateParamName = `/foerderturm-${environment}/tailscale/state`;
    const tailscaleStateParamArn = cdk.Stack.of(this).formatArn({
      service: 'ssm',
      resource: 'parameter',
      resourceName: tailscaleStateParamName.replace(/^\//, ''),
    });

    // ---- CloudWatch log group ----
    this.logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/ecs/foerderturm-${environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ---- ECS cluster ----
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `foerderturm-${environment}`,
      vpc: this.vpc,
    });

    // ---- Task definition ----
    // Task-scoped `dagster-home` volume is shared between the four SQLite-touching containers
    // (litestream-restore, dagster-webserver, dagster-daemon, litestream sidecar).
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: cpu,
      memoryLimitMiB: memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
      volumes: [{ name: DAGSTER_HOME_VOLUME }],
    });

    const dagsterImage = getContainerImage(this, 'DagsterRepo', props.dagsterImageArtifact);
    const litestreamImage = getContainerImage(
      this,
      'LitestreamRepo',
      props.litestreamImageArtifact
    );

    const litestreamEnv = {
      LITESTREAM_BUCKET: this.litestreamBucket.bucketName,
    };
    const mountDagsterHome = (container: ecs.ContainerDefinition): void => {
      container.addMountPoints({
        sourceVolume: DAGSTER_HOME_VOLUME,
        containerPath: DAGSTER_HOME_PATH,
        readOnly: false,
      });
    };

    // Required to trigger the respective Lambdas
    const pipesEnv: Record<string, string> = {
      PIPES_MESSAGES_BUCKET: this.pipesMessagesBucket.bucketName,
      CONNECTOR_EXAMPLE_LAMBDA_NAME: connectorFunctionName('example', environment),
    };

    // (1) Litestream restore - init container. Restores the three SQLite stores from S3 (no-op
    // when no replica exists, i.e. cold-start with empty DB).
    const litestreamRestoreCommand = [
      `mkdir -p ${DAGSTER_HOME_PATH}/history ${DAGSTER_HOME_PATH}/schedules`,
      `litestream restore -if-replica-exists -config ${LITESTREAM_CONFIG_PATH} ${DAGSTER_HOME_PATH}/history/runs.db`,
      `litestream restore -if-replica-exists -config ${LITESTREAM_CONFIG_PATH} ${DAGSTER_HOME_PATH}/history/event_log.db`,
      `litestream restore -if-replica-exists -config ${LITESTREAM_CONFIG_PATH} ${DAGSTER_HOME_PATH}/schedules/schedules.db`,
      `chown -R 1000:1000 ${DAGSTER_HOME_PATH}`,
    ].join(' && ');
    const litestreamRestore = taskDef.addContainer('litestream-restore', {
      containerName: 'litestream-restore',
      image: litestreamImage,
      essential: false,
      // Override the scratch image's USER nonroot:nonroot - restore needs root
      // to mkdir under the root-owned volume mount and to chown it to uid 1000.
      user: '0:0',
      entryPoint: ['/bin/sh', '-c'],
      command: [litestreamRestoreCommand],
      environment: litestreamEnv,
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'litestream-restore',
        logGroup: this.logGroup,
      }),
    });
    mountDagsterHome(litestreamRestore);

    // (2) Dagster init - one-shot `dagster instance migrate` so the long-running webserver and
    // daemon don't race on first boot (both would otherwise run alembic CREATE TABLE concurrently
    // on a fresh SQLite DB and the loser crashes with "alembic_version already exists").
    const dagsterInitPrep = `mkdir -p "$DAGSTER_HOME"/history "$DAGSTER_HOME"/schedules && cp -n /etc/dagster.yaml "$DAGSTER_HOME"/dagster.yaml`;
    const dagsterInit = taskDef.addContainer('dagster-init', {
      containerName: 'dagster-init',
      image: dagsterImage,
      essential: false,
      entryPoint: ['/bin/sh', '-c'],
      command: [`${dagsterInitPrep} && exec dagster instance migrate`],
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'dagster-init', logGroup: this.logGroup }),
    });
    mountDagsterHome(dagsterInit);
    dagsterInit.addContainerDependencies({
      container: litestreamRestore,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // (3) Dagster webserver - Dagster UI + GraphQL on port 3000 (consumed by the Tailscale sidecar over loopback).
    const dagsterWebserver = taskDef.addContainer('dagster-webserver', {
      containerName: 'dagster-webserver',
      image: dagsterImage,
      essential: true,
      environment: pipesEnv,
      command: [
        'dagster-webserver',
        '--host',
        '0.0.0.0',
        '--port',
        '3000',
        '--module-name',
        'foerderturm',
      ],
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'dagster-webserver',
        logGroup: this.logGroup,
      }),
      portMappings: [{ containerPort: 3000, protocol: ecs.Protocol.TCP }],
    });
    mountDagsterHome(dagsterWebserver);
    dagsterWebserver.addContainerDependencies({
      container: dagsterInit,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // (4) Dagster daemon - schedules, sensors, run queue. Same image, daemon command.
    const dagsterDaemon = taskDef.addContainer('dagster-daemon', {
      containerName: 'dagster-daemon',
      image: dagsterImage,
      essential: true,
      environment: pipesEnv,
      command: ['dagster-daemon', 'run', '--module-name', 'foerderturm'],
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'dagster-daemon', logGroup: this.logGroup }),
    });
    mountDagsterHome(dagsterDaemon);
    dagsterDaemon.addContainerDependencies({
      container: dagsterInit,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // (5) Litestream replicate - long-running sidecar streaming SQLite WAL -> S3.
    const litestreamSidecar = taskDef.addContainer('litestream', {
      containerName: 'litestream',
      image: litestreamImage,
      essential: true,
      user: '1000:1000', // Match appuser set up by litestream-restore
      command: ['replicate', '-config', LITESTREAM_CONFIG_PATH],
      environment: { ...litestreamEnv, LOG_LEVEL: 'warn' }, // Litetream logs on every sync to S3, this isn't needed
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'litestream', logGroup: this.logGroup }),
    });
    mountDagsterHome(litestreamSidecar);
    litestreamSidecar.addContainerDependencies({
      container: dagsterInit,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // (6) Tailscale sidecar: registers as a tagged node and serves HTTPS via MagicDNS.
    taskDef.addContainer('tailscale', {
      containerName: 'tailscale',
      image: getContainerImage(this, 'TailscaleRepo', props.tailscaleImageArtifact),
      essential: true,
      environment: {
        TS_HOSTNAME: props.tailscaleHostname,
        TS_USERSPACE: 'true',
        TS_EXTRA_ARGS: `--advertise-tags=${tailscaleTag} --ssh=false`,
        TS_SERVE_CONFIG: TAILSCALE_SERVE_CONFIG_PATH,
        // Pass SSM parameter in to store state
        TS_TAILSCALED_EXTRA_ARGS: `--state=${tailscaleStateParamArn}`,
        // With persistent state, this means "reuse the saved login from SSM on restart"
        // instead of re-authing each boot (which would churn LE cert issuance).
        TS_AUTH_ONCE: 'true',
      },
      secrets: {
        TS_AUTHKEY: ecs.Secret.fromSsmParameter(this.tailscaleSecret),
      },
      logging: ecs.LogDriver.awsLogs({
        streamPrefix: 'tailscale',
        logGroup: this.logGroup,
      }),
    });

    // ---- Task role permissions ----
    this.litestreamBucket.grantReadWrite(taskDef.taskRole);
    this.pipesMessagesBucket.grantRead(taskDef.taskRole);

    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['lambda:InvokeFunction'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'lambda',
            resource: 'function',
            resourceName: `${connectorFunctionPrefix}*`,
            arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME,
          }),
        ],
      })
    );

    // ---- Task role: Tailscale state parameter (read + create-on-first-boot) ----
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ssm:GetParameter', 'ssm:PutParameter'],
        resources: [tailscaleStateParamArn],
      })
    );
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['kms:Decrypt', 'kms:GenerateDataKey'],
        resources: ['*'],
        conditions: {
          StringEquals: {
            'kms:ViaService': `ssm.${cdk.Stack.of(this).region}.amazonaws.com`,
          },
        },
      })
    );

    // TODO: potentially add metrics/canaries to make sure this service is up?

    // ---- ECS service ----
    // assignPublicIp=true since we run in public subnets with no NAT (egress via IGW).
    // minimumHealthyPercent=0 + maximumPercent=100 = stop-then-start, required by SQLite's
    // single-writer constraint (no two tasks can hold the DB open simultaneously).
    this.service = new ecs.FargateService(this, 'Service', {
      serviceName: `foerderturm-${environment}`,
      cluster: this.cluster,
      taskDefinition: taskDef,
      desiredCount: props.desiredCount,
      assignPublicIp: true,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      minHealthyPercent: 0,
      maxHealthyPercent: 100,
      enableExecuteCommand: true,
      circuitBreaker: { rollback: false },
    });

    // ---- Outputs ----
    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'ECS service name (use with aws ecs update-service to scale)',
    });
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS cluster name',
    });
    new cdk.CfnOutput(this, 'LitestreamBucketName', {
      value: this.litestreamBucket.bucketName,
      description: 'S3 bucket for Dagster SQLite replication via Litestream',
    });
    new cdk.CfnOutput(this, 'PipesMessagesBucketName', {
      value: this.pipesMessagesBucket.bucketName,
      description: 'S3 bucket for Dagster Pipes message chunks written by connector Lambdas',
    });
    new cdk.CfnOutput(this, 'TailscaleSecretName', {
      value: this.tailscaleSecret.parameterName,
      description:
        'SSM SecureString parameter that must hold the Tailscale OAuth client secret (tskey-client-...). Create out-of-band.',
    });
    new cdk.CfnOutput(this, 'TailscaleStateParamName', {
      value: tailscaleStateParamName,
      description: 'SSM parameter where tailscaled persists its state (machine key, certs).',
    });
    new cdk.CfnOutput(this, 'TailscaleHostname', {
      value: props.tailscaleHostname,
      description: 'MagicDNS hostname; full URL is https://<this>.<tailnet>.ts.net/',
    });

    this.addNagSuppressions(taskDef);
  }

  private addNagSuppressions(taskDef: ecs.FargateTaskDefinition): void {
    NagSuppressions.addResourceSuppressions(this.vpc, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'Flow logs disabled - no real traffic, only dagster.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.litestreamBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Only used by Litestream no need to log everything.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.pipesMessagesBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Transient Dagster Pipes message chunks (1-day expiry); access logging not warranted.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.cluster, [
      {
        id: 'AwsSolutions-ECS4',
        reason: 'Container Insights not needed for this single-task Dagster cluster.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      taskDef,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ecr:GetAuthorizationToken requires resource:*; KMS for Tailscale on alias/aws/ssm; ' +
            'lambda:InvokeFunction scoped to the foerderturm-connector-* name prefix so connectors ' +
            'can be added/removed without re-deploying this stack; S3 read on the Pipes bucket objects path.',
        },
        {
          id: 'AwsSolutions-ECS2',
          reason:
            'Env vars on the containers hold non-secret config only (LITESTREAM_BUCKET, TS_HOSTNAME, etc.).',
        },
      ],
      true
    );

    NagSuppressions.addResourceSuppressions(
      this.service,
      [
        {
          id: 'AwsSolutions-EC23',
          reason:
            'Tasks run in public subnets so the Tailscale sidecar can reach the tailnet control plane.',
        },
      ],
      true
    );
  }
}
