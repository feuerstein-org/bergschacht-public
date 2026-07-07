import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3files from 'aws-cdk-lib/aws-s3files';
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

/** Preserve Tailscale state in S3 Files */
const TAILSCALE_STATE_VOLUME = 'tailscale-state';
const TAILSCALE_STATE_PATH = '/var/lib/tailscale';
const NFS_PORT = 2049;

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
  /**
   * Bucket holding the Sharadar backfill CSV partitions (uploaded out-of-band). Passed to the
   * connectors stack so the Sharadar Lambda can be granted read access.
   */
  public readonly sharadarStagingBucket: s3.IBucket;
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

    // ---- Sharadar staging bucket ----
    // Holds the Sharadar backfill CSV partitions, uploaded out-of-band (see
    // scripts/split_and_upload.py in foerderturm). The Sharadar connector Lambda reads its per-year
    // partitions from here; the orchestrator only builds the `s3://` source globs (no read access).
    this.sharadarStagingBucket = new s3.Bucket(this, 'SharadarStagingBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      // RETAIN: the partitions are uploaded by hand, so don't drop them on a stack replace.
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      lifecycleRules: [
        {
          id: 'AbortIncompleteMultipartUpload',
          abortIncompleteMultipartUploadAfter: cdk.Duration.days(7),
          enabled: true,
        },
      ],
    });

    // ---- Tailscale state file system (Amazon S3 Files) ----
    const tailscaleStateBucket = new s3.Bucket(this, 'TailscaleStateBucket', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      versioned: true, //required by S3 Files
      enforceSSL: true,
      lifecycleRules: [
        {
          id: 'ExpireOldTailscaleStateVersions',
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

    // Role S3 Files assumes to sync the file system to its bucket
    // See reference here: https://docs.aws.amazon.com/AmazonS3/latest/userguide/s3-files-prereq-policies.html#s3-files-prereq-iam-compute-role
    // No L2 construct yet, see here:
    // https://docs.aws.amazon.com/cdk/api/v2/docs/aws-cdk-lib.aws_s3files-readme.html
    const tailscaleStateFsRole = new iam.Role(this, 'TailscaleStateFsRole', {
      assumedBy: new iam.ServicePrincipal('elasticfilesystem.amazonaws.com', {
        conditions: {
          StringEquals: { 'aws:SourceAccount': this.account },
          ArnLike: {
            'aws:SourceArn': `arn:${this.partition}:s3files:${this.region}:${this.account}:file-system/*`,
          },
        },
      }),
      description: `Role Amazon S3 Files assumes to sync the foerderturm-${environment} Tailscale statedir file system to S3`,
    });
    tailscaleStateFsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3BucketPermissions',
        actions: ['s3:ListBucket', 's3:ListBucketVersions'],
        resources: [tailscaleStateBucket.bucketArn],
        conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
      })
    );
    tailscaleStateFsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'S3ObjectPermissions',
        actions: [
          's3:AbortMultipartUpload',
          's3:DeleteObject*',
          's3:GetObject*',
          's3:List*',
          's3:PutObject*',
        ],
        resources: [tailscaleStateBucket.arnForObjects('*')],
        conditions: { StringEquals: { 'aws:ResourceAccount': this.account } },
      })
    );
    // Skipped KMS policy
    tailscaleStateFsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeManage',
        actions: [
          'events:DeleteRule',
          'events:DisableRule',
          'events:EnableRule',
          'events:PutRule',
          'events:PutTargets',
          'events:RemoveTargets',
        ],
        resources: [`arn:${this.partition}:events:*:*:rule/DO-NOT-DELETE-S3-Files*`],
        conditions: { StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' } },
      })
    );
    tailscaleStateFsRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'EventBridgeRead',
        actions: [
          'events:DescribeRule',
          'events:ListRuleNamesByTarget',
          'events:ListRules',
          'events:ListTargetsByRule',
        ],
        resources: [`arn:${this.partition}:events:*:*:rule/*`],
      })
    );

    const tailscaleStateFs = new s3files.CfnFileSystem(this, 'TailscaleStateFileSystem', {
      bucket: tailscaleStateBucket.bucketArn,
      roleArn: tailscaleStateFsRole.roleArn,
      // The bucket is dedicated to S3 Files; acknowledge S3 Files taking it over.
      acceptBucketWarning: true,
      // Name tag so this deployment's file system is identifiable in the console (fs-… otherwise).
      tags: [{ key: 'Name', value: `foerderturm-${environment}-tailscale-state` }],
    });

    const tailscaleStateFsSg = new ec2.SecurityGroup(this, 'TailscaleStateFsSg', {
      vpc: this.vpc,
      allowAllOutbound: false,
      description: `foerderturm-${environment}: S3 Files mount targets for the Tailscale statedir`,
    });
    // One mount target per AZ the task can land in (service runs across all public subnets).
    this.vpc.publicSubnets.forEach((subnet, i) => {
      new s3files.CfnMountTarget(this, `TailscaleStateMountTarget${i}`, {
        fileSystemId: tailscaleStateFs.attrFileSystemId,
        subnetId: subnet.subnetId,
        securityGroups: [tailscaleStateFsSg.securityGroupId],
      });
    });

    // ---- Tailscale OAuth client secret (SSM SecureString, created out-of-band) ----
    this.tailscaleSecret = ssm.StringParameter.fromSecureStringParameterAttributes(
      this,
      'TailscaleOAuthSecret',
      { parameterName: `/foerderturm-${environment}/tailscale/oauth-client` }
    );

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
      LITESTREAM_SYNC_INTERVAL: '60', // sync SQLite db every 60 seconds
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
      CONNECTOR_SHARADAR_LAMBDA_NAME: connectorFunctionName('sharadar', environment),
      // Dedicated bucket, so partitions are staged at the root (`<bucket>/sep/...`, `<bucket>/tickers/...`).
      SHARADAR_STAGING_BUCKET: this.sharadarStagingBucket.bucketName,
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
    const tailscale = taskDef.addContainer('tailscale', {
      containerName: 'tailscale',
      image: getContainerImage(this, 'TailscaleRepo', props.tailscaleImageArtifact),
      essential: true,
      environment: {
        TS_HOSTNAME: props.tailscaleHostname,
        TS_USERSPACE: 'true',
        TS_EXTRA_ARGS: `--advertise-tags=${tailscaleTag} --ssh=false`,
        TS_SERVE_CONFIG: TAILSCALE_SERVE_CONFIG_PATH,
        TS_STATE_DIR: TAILSCALE_STATE_PATH,
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
    tailscale.addMountPoints({
      sourceVolume: TAILSCALE_STATE_VOLUME,
      containerPath: TAILSCALE_STATE_PATH,
      readOnly: false,
    });

    // Register the S3 Files volume. CDK has no L2 for s3filesVolumeConfiguration yet, so we declare
    // the volume name through the L2 (keeps mount-point validation happy + fixes its array index)
    // and inject the S3 Files config via an escape hatch. dagster-home is Volumes[0]; this is [1].
    taskDef.addVolume({ name: TAILSCALE_STATE_VOLUME });
    const cfnTaskDef = taskDef.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDef.addPropertyOverride('Volumes.1.S3FilesVolumeConfiguration', {
      FileSystemArn: tailscaleStateFs.attrFileSystemArn,
      RootDirectory: '/',
    });

    // ---- Task role permissions ----
    this.litestreamBucket.grantReadWrite(taskDef.taskRole);
    this.pipesMessagesBucket.grantRead(taskDef.taskRole);

    // Give permissions to access S3 Files.
    taskDef.taskRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonS3FilesClientFullAccess')
    );

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

    // TODO: potentially add metrics/canaries to make sure this service is up?

    // ---- ECS service ----
    // assignPublicIp=true since we run in public subnets with no NAT (egress via IGW).
    // minimumHealthyPercent=0 + maximumPercent=100 = stop-then-start, required by SQLite's
    // single-writer constraint (no two tasks can hold the DB open simultaneously).
    const service = new ecs.FargateService(this, 'Service', {
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
    this.service = service;

    // Let the Fargate task reach the S3 Files mount targets over NFS.
    tailscaleStateFsSg.connections.allowFrom(
      service,
      ec2.Port.tcp(NFS_PORT),
      `NFS from the foerderturm-${environment} Fargate task to the Tailscale state file system`
    );

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
    new cdk.CfnOutput(this, 'SharadarStagingBucketName', {
      value: this.sharadarStagingBucket.bucketName,
      description:
        'S3 bucket to upload the Sharadar backfill CSV partitions into (sep/, tickers/).',
    });
    new cdk.CfnOutput(this, 'TailscaleSecretName', {
      value: this.tailscaleSecret.parameterName,
      description:
        'SSM SecureString parameter that must hold the Tailscale OAuth client secret (tskey-client-...). Create out-of-band.',
    });
    new cdk.CfnOutput(this, 'TailscaleStateFileSystemId', {
      value: tailscaleStateFs.attrFileSystemId,
      description:
        'S3 Files file system backing the Tailscale statedir (node identity + MagicDNS cert).',
    });
    new cdk.CfnOutput(this, 'TailscaleHostname', {
      value: props.tailscaleHostname,
      description: 'MagicDNS hostname; full URL is https://<this>.<tailnet>.ts.net/',
    });

    this.addNagSuppressions(taskDef, tailscaleStateBucket, tailscaleStateFsRole);
  }

  private addNagSuppressions(
    taskDef: ecs.FargateTaskDefinition,
    tailscaleStateBucket: s3.Bucket,
    tailscaleStateFsRole: iam.Role
  ): void {
    NagSuppressions.addResourceSuppressions(this.vpc, [
      {
        id: 'AwsSolutions-VPC7',
        reason: 'Flow logs disabled - no real traffic, only dagster.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(this.sharadarStagingBucket, [
      {
        id: 'AwsSolutions-S1',
        reason:
          'Holds re-uploadable Sharadar source CSVs for a one-off backfill; access logging not warranted.',
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

    NagSuppressions.addResourceSuppressions(tailscaleStateBucket, [
      {
        id: 'AwsSolutions-S1',
        reason: 'Backs the Tailscale S3 Files statedir, access logging not warranted.',
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
            'ecr:GetAuthorizationToken requires resource:*; ' +
            'lambda:InvokeFunction scoped to the foerderturm-connector-* name prefix so connectors ' +
            'can be added/removed without re-deploying this stack; S3 read on the Pipes bucket objects path.',
        },
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AmazonS3FilesClientFullAccess is the AWS-managed client policy for S3 Files ' +
            '(mount/read/write incl. ClientRootAccess); used by the task to mount the Tailscale statedir.',
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

    NagSuppressions.addResourceSuppressions(
      tailscaleStateFsRole,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 Files service role per AWS prerequisite policy: EventBridge needs rule/* (read) and ' +
            'rule/DO-NOT-DELETE-S3-Files* (gated by events:ManagedBy); S3 object actions are scoped ' +
            'to the dedicated state bucket.',
        },
      ],
      true
    );
  }
}
