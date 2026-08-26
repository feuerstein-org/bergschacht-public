import * as cdk from 'aws-cdk-lib/core';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3files from 'aws-cdk-lib/aws-s3files';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { type ContainerArtifact, getContainerImage } from '../config/version-manifest.ts';
import { FoerderturmLifecycle, type FoerderturmLifecycleConfig } from './foerderturm-lifecycle.ts';
import {
  runWorkerExecRoleName,
  runWorkerPrefix,
  runWorkerTaskFamilyPrefix,
} from '../config/constants.ts';
import { type BronzeTableNamespace, grantTableAccess } from './table-access.ts';

// TODO: Add a metric + alarm later which raises when no work was done that day, currently the lifecycle
// could just kill the orchestrator before ANY work was done (e.g. RDS took too long to start) and we wouldn't acknowledge
// one simple way would be to monitor S3 tables metrics for inserts or just check against Dagster itself (that might
// be harder).

/** Default Tailscale ACL tag the sidecar advertises. Must exist in the tailnet admin policy. */
const DEFAULT_TAILSCALE_TAG = 'tag:foerderturm';

/** Path the Tailscale image bakes its serve config to (set in foerderturm's tailscale.Dockerfile). */
const TAILSCALE_SERVE_CONFIG_PATH = '/etc/tailscale/serve.json';

/** Postgres port the Dagster containers connect to RDS on. */
const POSTGRES_PORT = 5432;

/** Preserve Tailscale state in S3 Files */
const TAILSCALE_STATE_VOLUME = 'tailscale-state';
const TAILSCALE_STATE_PATH = '/var/lib/tailscale';
const NFS_PORT = 2049;

/**
 * One run-worker profile: the image a run executes in, plus the task role, env, and Fargate size
 * that go with it.
 */
export interface RunWorkerConfig {
  /** Immutable run-worker image artifact, resolved from the version manifest. */
  readonly image: ContainerArtifact;
  /**
   * SSM SecureString parameters this worker reads at runtime (it resolves them from SSM itself).
   * Needed permissions are granted automatically.
   * @example { MASSIVE_API_KEY_SSM_PARAMETER: '/foerderturm-prod/massive/api-key' }
   */
  readonly ssmSecureParams?: Record<string, string>;
  /**
   * Extra non-secret env vars forwarded to this worker's run tasks.
   * @default {}
   */
  readonly environmentVars?: Record<string, string>;
  /**
   * Fargate task vCPU units for this worker's run tasks (256 = 0.25 vCPU). Sets the
   * worker's DEFAULT size; a per-run `ecs/cpu` Dagster tag still overrides it per run.
   * @default the launcher's global run_resources.cpu (dagster.yaml)
   */
  readonly cpu?: number;
  /**
   * Fargate task memory (MiB) for this worker's run tasks (e.g. 1024), must form a valid Fargate
   * cpu/memory combination with {@link cpu}. A per-run `ecs/memory` tag overrides it per run.
   * @default the launcher's global run_resources.memory (dagster.yaml)
   */
  readonly memoryMiB?: number;
}

export interface FoerderturmStackProps extends cdk.StackProps {
  /**
   * Environment name (e.g. 'dev', 'stage', 'prod') suffixed onto account-scoped resource names
   * (ECS cluster, service, log group, run-worker roles), so they're disambiguated in the console/CLI.
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
   * Tailscale container image artifact resolved from the version manifest. Same ECR repo as
   * the Dagster image, baked with `/etc/tailscale/serve.json` so we don't need
   * to inject the serve config from this stack.
   * @example getImageArtifact('foerderturm', 'foerderturm-tailscale')
   */
  readonly tailscaleImageArtifact: ContainerArtifact;
  /**
   * Bronze S3 Tables namespace the run workers write to. Every run-worker task role is granted
   * read/write on its tables  and its table-bucket ARN is forwarded to the run workers as TABLE_BUCKET_ARN.
   */
  readonly bronze: BronzeTableNamespace;
  /**
   * Run-worker profiles, keyed by the `worker` run-tag value (e.g. `massive`, `sharadar`,
   * `example`). Serialized to RUN_WORKER_PROFILES so WorkerImageEcsRunLauncher routes each run to
   * its worker's image and overlays that worker's own least-privilege task role + env.
   */
  readonly workers: Record<string, RunWorkerConfig>;
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
  /**
   * Scheduled/on-demand start + idle shutdown for the orchestrator and RDS, so neither runs around
   * the clock. The service's desired count is owned at runtime by the lifecycle state
   * machines, a stack without one has no way to start or stop itself.
   *
   * Pass `{}` for a manual-only environment - the reaper and the stop machine still run, there is
   * just no daily start cron.
   * @example { startSchedule: { cron: 'cron(30 10 ? * MON-FRI *)' }, minSessionMinutes: 60 }
   */
  readonly lifecycle: FoerderturmLifecycleConfig;
  /**
   * Topic alarmed onto when a lifecycle state machine fails or times out.
   * @example snsPagerDuty.topic
   */
  readonly alertTopic: sns.ITopic;
}

/**
 * Fargate-hosted Dagster orchestrator (foerderturm) backed by RDS Postgres, with a
 * Tailscale sidecar for ingress.
 *
 * Architecture:
 * - Minimal per-env VPC, public subnets only (no NAT)
 * - RDS Postgres for Dagster, this is what lets ECS workers write events to shared
 *   storage and survive orchestrator deploys/crashes. Credentials
 *   are in a generated Secrets Manager secret, injected into the Dagster containers as
 *   DAGSTER_PG_{HOST,PORT,USERNAME,PASSWORD,DB}.
 * - One Fargate task, three containers (no shared volume - dagster.yaml is baked into the
 *   image at $DAGSTER_HOME):
 *     1. dagster-init (init) - runs `dagster instance migrate` on every deploy to apply schema upgrades.
 *     2. dagster-webserver - Dagster UI. Depends on (1) SUCCESS.
 *     3. dagster-daemon - schedules, sensors, run queue. Depends on (1) SUCCESS.
 *     4. tailscale - tagged node serving HTTPS:443 -> http://127.0.0.1:3000 via MagicDNS.
 * - {@link FoerderturmLifecycle} (props.lifecycle): Step Functions + EventBridge Scheduler that
 *   start RDS and scale the service to 1 on a schedule or on demand, and shut both down once the
 *   run workers have been idle for a while.
 *
 * Operator prerequisites and manual SecureString setup are documented in
 * README.md#manual-secrets.
 */
export class FoerderturmStack extends cdk.Stack {
  public readonly vpc: ec2.IVpc;
  public readonly cluster: ecs.ICluster;
  public readonly workersCluster: ecs.ICluster;
  public readonly service: ecs.IFargateService;
  public readonly database: rds.IDatabaseInstance;
  public readonly databaseSecret: secretsmanager.ISecret;
  // TODO: This needs to be removed once Sharadar is migrated from S3 to API
  public readonly sharadarStagingBucket: s3.IBucket;
  public readonly tailscaleSecret: ssm.IStringParameter;
  public readonly logGroup: logs.ILogGroup;
  /** Egress-only SG the dagster EcsRunLauncher attaches to each run-worker task (also allowed into RDS). */
  public readonly runWorkerSecurityGroup: ec2.ISecurityGroup;
  /** Start/stop state machines and the lease table that own the service's desired count. */
  public readonly lifecycle: FoerderturmLifecycle;

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
        {
          name: 'Database',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 24,
        },
      ],
      restrictDefaultSecurityGroup: true,
    });

    // ---- RDS Postgres (Dagster run/event-log/schedule storage) ----
    // Dedicated SG: ingress from the orchestrator service + run-worker tasks is
    // granted below once those SGs exist. Isolated from the internet.
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DatabaseSg', {
      vpc: this.vpc,
      allowAllOutbound: false,
      description: `foerderturm-${environment}: RDS Postgres access`,
    });

    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({
        version: rds.PostgresEngineVersion.VER_18_3,
      }),
      instanceType: ec2.InstanceType.of(
        ec2.InstanceClass.BURSTABLE4_GRAVITON,
        ec2.InstanceSize.MICRO
      ),
      vpc: this.vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
      publiclyAccessible: false,
      securityGroups: [dbSecurityGroup],
      multiAz: false,
      allocatedStorage: 20,
      storageType: rds.StorageType.GP3,
      storageEncrypted: true,
      databaseName: 'dagster',
      credentials: rds.Credentials.fromGeneratedSecret('dagster', {
        secretName: `foerderturm-${environment}/dagster/db`,
      }),
      backupRetention: cdk.Duration.days(7),
      // Hardcoded, any lifecycle rules should adhere to these, see foerderturm-lifecycle.ts class docstring.
      preferredBackupWindow: '10:50-11:20',
      preferredMaintenanceWindow: 'Sun:03:15-Sun:03:45',
      deleteAutomatedBackups: false,
    });
    this.database = database;
    this.databaseSecret = database.secret!;

    // ---- Sharadar staging bucket ----
    // Holds the Sharadar backfill CSV partitions, uploaded out-of-band (see
    // scripts/split_and_upload.py in foerderturm). The Sharadar run worker reads its per-year
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

    // ---- Tailscale OAuth client secret - see README.md#manual-secrets ----
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

    // ---- ECS cluster (orchestrator) ----
    // Hosts only the single stateful Dagster service task.
    this.cluster = new ecs.Cluster(this, 'Cluster', {
      clusterName: `foerderturm-${environment}`,
      vpc: this.vpc,
    });

    // ---- ECS cluster (workers) ----
    // FARGATE + FARGATE_SPOT capacity providers are associated so run_task
    // can use a capacityProviderStrategy (Spot by default).
    const workersClusterName = `foerderturm-workers-${environment}`;
    this.workersCluster = new ecs.Cluster(this, 'WorkersCluster', {
      clusterName: workersClusterName,
      vpc: this.vpc,
      enableFargateCapacityProviders: true,
    });

    // ---- Run-worker task security group ----
    this.runWorkerSecurityGroup = new ec2.SecurityGroup(this, 'RunWorkerSg', {
      vpc: this.vpc,
      allowAllOutbound: true,
      description: `foerderturm-${environment}: egress-only SG for run-worker ECS tasks`,
    });

    // ---- Run-worker task roles + logs ----
    // Every worker group has its own ECS task, registered dynamically by Dagster itself with these roles
    // (family `run-worker_<worker>_<job>`) on the workers cluster with the run-worker SG.
    const runWorkerLogGroup = new logs.LogGroup(this, 'RunWorkerLogGroup', {
      logGroupName: `/ecs/${runWorkerPrefix}${environment}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // Every worker gets a role with the shared grants (cwagent + bronze) plus only
    // its own worker-specific grants + env. Assembled into `workerSpecs` -> RUN_WORKER_PROFILES.
    const workerTaskRoles: iam.Role[] = [];
    const workerSpecs: Record<
      string,
      {
        image: string;
        task_role_arn: string;
        env: Record<string, string>;
        cpu?: string;
        memory?: string;
      }
    > = {};
    for (const [name, cfg] of Object.entries(props.workers)) {
      const pascal = name.charAt(0).toUpperCase() + name.slice(1);
      const role = new iam.Role(this, `RunWorker${pascal}TaskRole`, {
        assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
        description: `Task role for foerderturm-${environment} ${name} run-worker ECS tasks`,
      });
      role.addManagedPolicy(
        iam.ManagedPolicy.fromAwsManagedPolicyName('CloudWatchAgentServerPolicy')
      );
      grantTableAccess(role, props.bronze);

      const env: Record<string, string> = {};
      // SSM SecureString params this worker reads (e.g. the Massive API key). Grant + forward the
      // parameter NAME (not the value); the worker resolves it from SSM at runtime via this role.
      for (const [envVar, parameterName] of Object.entries(cfg.ssmSecureParams ?? {})) {
        const param = ssm.StringParameter.fromSecureStringParameterAttributes(
          this,
          `${pascal}-${envVar}`,
          { parameterName }
        );
        param.grantRead(role);
        env[envVar] = parameterName;
      }
      // Sharadar's staging bucket is stack-owned (not a prop input), so wire its read + env here.
      // TODO: Once sharadar no longer relies on the bucket, remove this.
      if (name === 'sharadar') {
        this.sharadarStagingBucket.grantRead(role);
        env.SHARADAR_STAGING_BUCKET = this.sharadarStagingBucket.bucketName;
      }
      // Arbitrary per-worker env last, so a worker can override any derived var.
      Object.assign(env, cfg.environmentVars ?? {});
      this.addRunWorkerRoleNagSuppressions(role);

      workerSpecs[name] = {
        image: `${cfg.image.repository}:${cfg.image.imageTag}`,
        task_role_arn: role.roleArn,
        env,
        // Per-worker Fargate size (default; a per-run ecs/cpu|ecs/memory tag overrides it).
        ...(cfg.cpu !== undefined ? { cpu: String(cfg.cpu) } : {}),
        ...(cfg.memoryMiB !== undefined ? { memory: String(cfg.memoryMiB) } : {}),
      };
      workerTaskRoles.push(role);
    }

    const runWorkerExecRole = new iam.Role(this, 'RunWorkerExecRole', {
      roleName: runWorkerExecRoleName(environment),
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      description: `Execution role for foerderturm-${environment} Dagster run-worker ECS tasks`,
    });
    runWorkerExecRole.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy')
    );
    // The execution role injects the DAGSTER_PG_* container secrets (same secret the orchestrator
    // reads), so the run worker reaches the shared Postgres.
    this.databaseSecret.grantRead(runWorkerExecRole);

    // ---- Orchestrator task definition ----
    const taskDef = new ecs.FargateTaskDefinition(this, 'TaskDefinition', {
      cpu: cpu,
      memoryLimitMiB: memoryMiB,
      runtimePlatform: {
        cpuArchitecture: ecs.CpuArchitecture.X86_64,
        operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
      },
    });

    const dagsterImage = getContainerImage(this, 'DagsterRepo', props.dagsterImageArtifact);

    // Postgres connection params, injected from the RDS-generated secret's JSON fields.
    // Consumed by dagster.yaml's `storage.postgres` block
    const dagsterPgSecrets: Record<string, ecs.Secret> = {
      DAGSTER_PG_HOST: ecs.Secret.fromSecretsManager(this.databaseSecret, 'host'),
      DAGSTER_PG_PORT: ecs.Secret.fromSecretsManager(this.databaseSecret, 'port'),
      DAGSTER_PG_USERNAME: ecs.Secret.fromSecretsManager(this.databaseSecret, 'username'),
      DAGSTER_PG_PASSWORD: ecs.Secret.fromSecretsManager(this.databaseSecret, 'password'),
      DAGSTER_PG_DB: ecs.Secret.fromSecretsManager(this.databaseSecret, 'dbname'),
    };

    // SHARED run-worker runtime config, forwarded (via the launcher's `env_vars`) from the
    // daemon/webserver process onto EVERY ECS run-worker task. Worker-SPECIFIC config
    // (e.g. the Massive API-key SSM name) is NOT here - it rides in the RUN_WORKER_PROFILES
    // below (defined in workerSpecs), so each worker gets only its own config.
    const runtimeEnv: Record<string, string> = {
      TABLE_BUCKET_ARN: props.bronze.tableBucket.tableBucketArn,
      // Per-env OpenTelemetry resource attributes forwarded to each run worker
      OTEL_RESOURCE_ATTRIBUTES: `service.namespace=foerderturm,deployment.environment.name=${environment}`,
    };

    // Config for WorkerImageEcsRunLauncher (foerderturm's dagster.yaml run_launcher block).
    // The launcher reads these from the daemon/webserver process env: RUN_WORKER_CLUSTER /
    // RUN_WORKER_LOG_GROUP / RUN_WORKER_*_ROLE_ARN via StringSource, and RUN_WORKER_SUBNETS /
    // RUN_WORKER_SECURITY_GROUP / RUN_WORKER_DB_SECRET_ARN in Python (list/secret shapes config
    // env-interpolation can't express).
    const runLauncherEnv: Record<string, string> = {
      RUN_WORKER_CLUSTER: workersClusterName,
      RUN_WORKER_SUBNETS: this.vpc.publicSubnets.map((subnet) => subnet.subnetId).join(','),
      RUN_WORKER_SECURITY_GROUP: this.runWorkerSecurityGroup.securityGroupId,
      RUN_WORKER_LOG_GROUP: runWorkerLogGroup.logGroupName,
      RUN_WORKER_EXECUTION_ROLE_ARN: runWorkerExecRole.roleArn,
      RUN_WORKER_DB_SECRET_ARN: this.databaseSecret.secretArn,
      // JSON `worker` run-tag value -> {image, task_role_arn, env}. The launcher routes a
      // `worker: <name>` run to its image, overlays its least-privilege task role, and appends
      // its worker-specific env. Built with `toJsonString` because the role ARNs (and Sharadar's
      // staging bucket name) are CFN tokens - it resolves them into the JSON via Fn::Join at synth.
      RUN_WORKER_PROFILES: this.toJsonString(workerSpecs),
    };

    // (1) Initializes Dagster from DB.
    const dagsterInit = taskDef.addContainer('dagster-init', {
      containerName: 'dagster-init',
      image: dagsterImage,
      essential: false,
      command: ['dagster', 'instance', 'migrate'],
      environment: runLauncherEnv,
      secrets: dagsterPgSecrets,
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'dagster-init', logGroup: this.logGroup }),
    });

    // (2) Dagster webserver - Dagster UI + GraphQL on port 3000 (consumed by the Tailscale sidecar over loopback).
    const dagsterWebserver = taskDef.addContainer('dagster-webserver', {
      containerName: 'dagster-webserver',
      image: dagsterImage,
      essential: true,
      environment: { ...runtimeEnv, ...runLauncherEnv },
      secrets: dagsterPgSecrets,
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
    dagsterWebserver.addContainerDependencies({
      container: dagsterInit,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // (3) Dagster daemon - schedules, sensors, run queue. Same image, daemon command.
    const dagsterDaemon = taskDef.addContainer('dagster-daemon', {
      containerName: 'dagster-daemon',
      image: dagsterImage,
      essential: true,
      environment: { ...runtimeEnv, ...runLauncherEnv },
      secrets: dagsterPgSecrets,
      command: ['dagster-daemon', 'run', '--module-name', 'foerderturm'],
      logging: ecs.LogDriver.awsLogs({ streamPrefix: 'dagster-daemon', logGroup: this.logGroup }),
    });
    dagsterDaemon.addContainerDependencies({
      container: dagsterInit,
      condition: ecs.ContainerDependencyCondition.SUCCESS,
    });

    // (4) Tailscale sidecar: registers as a tagged node and serves HTTPS via MagicDNS.
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
    // and inject the S3 Files config via an escape hatch. It is the only volume now → Volumes[0].
    taskDef.addVolume({ name: TAILSCALE_STATE_VOLUME });
    const cfnTaskDef = taskDef.node.defaultChild as ecs.CfnTaskDefinition;
    cfnTaskDef.addPropertyOverride('Volumes.0.S3FilesVolumeConfiguration', {
      FileSystemArn: tailscaleStateFs.attrFileSystemArn,
      RootDirectory: '/',
    });

    // ---- Task role permissions ----
    // S3 Files client access, scoped to the Tailscale statedir file system.
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['s3files:ClientMount', 's3files:ClientWrite', 's3files:ClientRootAccess'],
        resources: [tailscaleStateFs.attrFileSystemArn],
      })
    );

    // Orchestrator (daemon) EcsRunLauncher grants: the launcher registers a run-worker task def per
    // run, runs it on the workers cluster, and passes the two run-worker roles needed (exec & task role).
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // RegisterTaskDefinition and DescribeTaskDefinition have no resource-level scoping (AWS-side).
        actions: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
        resources: ['*'],
      })
    );
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:RunTask'],
        resources: [
          this.formatArn({
            service: 'ecs',
            resource: 'task-definition',
            resourceName: `${runWorkerTaskFamilyPrefix}_*`,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
        conditions: { ArnEquals: { 'ecs:cluster': this.workersCluster.clusterArn } },
      })
    );
    // Poll run-worker health, stop tasks on cancellation, and tag launched tasks.
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:DescribeTasks', 'ecs:StopTask', 'ecs:TagResource'],
        resources: [
          this.formatArn({
            service: 'ecs',
            resource: 'task',
            resourceName: `${workersClusterName}/*`,
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      })
    );
    taskDef.taskRole.addToPrincipalPolicy(
      new iam.PolicyStatement({
        // Pass the shared execution role AND every per-worker task role - the launcher registers
        // each worker's task def with its own role, so the orchestrator must be able to pass them.
        actions: ['iam:PassRole'],
        resources: [runWorkerExecRole.roleArn, ...workerTaskRoles.map((role) => role.roleArn)],
        conditions: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
      })
    );

    // TODO: potentially add metrics/canaries to make sure this service is up?

    // ---- ECS service ----
    // assignPublicIp=true since we run in public subnets with no NAT (egress via IGW).
    // minimumHealthyPercent=0 + maximumPercent=100 = stop-then-start: only one orchestrator
    // task at a time so two daemons don't double-schedule / race the run queue.
    //
    // desiredCount is deliberately NOT set. CDK then omits DesiredCount from the template, and
    // CloudFormation defaults it to 1 on stack *create* while leaving the live value untouched on
    // every *update*. That is what lets FoerderturmLifecycle own the count at runtime.
    const service = new ecs.FargateService(this, 'Service', {
      serviceName: `foerderturm-${environment}`,
      cluster: this.cluster,
      taskDefinition: taskDef,
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

    // Let the orchestrator task reach RDS. The run-worker task SG is also allowed so
    // the out-of-process run workers (EcsRunLauncher, later phases) can write events to Postgres.
    dbSecurityGroup.connections.allowFrom(
      service,
      ec2.Port.tcp(POSTGRES_PORT),
      `Postgres from the foerderturm-${environment} orchestrator task`
    );
    dbSecurityGroup.connections.allowFrom(
      this.runWorkerSecurityGroup,
      ec2.Port.tcp(POSTGRES_PORT),
      `Postgres from foerderturm-${environment} run-worker tasks`
    );

    // ---- Lifecycle: scheduled + on-demand start, idle shutdown ----
    this.lifecycle = new FoerderturmLifecycle(this, 'Lifecycle', {
      environment,
      service: this.service,
      cluster: this.cluster,
      workersCluster: this.workersCluster,
      database: this.database,
      alertTopic: props.alertTopic,
      config: props.lifecycle,
    });

    // Because the instance is stopped most of the time we send a notification any time there's an update available.
    new rds.CfnEventSubscription(this, 'DatabaseMaintenanceEvents', {
      snsTopicArn: props.alertTopic.topicArn,
      sourceType: 'db-instance',
      sourceIds: [this.database.instanceIdentifier],
      eventCategories: ['maintenance', 'security patching'],
      enabled: true,
    });

    new cdk.CfnOutput(this, 'LifecycleStartMachineArn', {
      value: this.lifecycle.startStateMachine.stateMachineArn,
      description: 'Step Functions state machine that starts the orchestrator + RDS',
    });
    new cdk.CfnOutput(this, 'LifecycleStopMachineArn', {
      value: this.lifecycle.stopStateMachine.stateMachineArn,
      description: 'Step Functions state machine that drains and stops the orchestrator + RDS',
    });
    new cdk.CfnOutput(this, 'LifecycleReaperMachineArn', {
      value: this.lifecycle.reaperStateMachine.stateMachineArn,
      description: 'Step Functions state machine that decides whether a shutdown is due',
    });
    new cdk.CfnOutput(this, 'LifecycleLeaseTableName', {
      value: this.lifecycle.leaseTable.tableName,
      description: 'DynamoDB table holding the lifecycle lease item (pk=lease)',
    });

    // ---- Outputs ----
    new cdk.CfnOutput(this, 'ServiceName', {
      value: this.service.serviceName,
      description: 'ECS service name. Scale it via the lifecycle state machines, not by hand.',
    });
    new cdk.CfnOutput(this, 'ClusterName', {
      value: this.cluster.clusterName,
      description: 'ECS cluster name',
    });
    new cdk.CfnOutput(this, 'WorkersClusterName', {
      value: this.workersCluster.clusterName,
      description: 'ECS cluster the Dagster run-worker tasks execute in (EcsRunLauncher)',
    });
    new cdk.CfnOutput(this, 'DatabaseEndpoint', {
      value: this.database.dbInstanceEndpointAddress,
      description: 'RDS Postgres endpoint hosting Dagster run/event-log/schedule storage',
    });
    new cdk.CfnOutput(this, 'DatabaseSecretName', {
      value: this.databaseSecret.secretName,
      description: 'Secrets Manager secret holding the Dagster Postgres credentials',
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

    this.addNagSuppressions(taskDef, tailscaleStateBucket, tailscaleStateFsRole, runWorkerExecRole);
  }

  private addRunWorkerRoleNagSuppressions(role: iam.Role): void {
    NagSuppressions.addResourceSuppressions(
      role,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'CloudWatchAgentServerPolicy is the AWS-managed policy the CloudWatch-agent sidecar ' +
            'requires to publish Application Signals metrics, X-Ray traces, and logs.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'S3 Tables read/write is scoped to the bronze table bucket but uses the per-table grant ' +
            'form; a worker role additionally gets a single-bucket Sharadar staging read (grantRead ' +
            'emits object-key wildcards) and/or a specific-parameter SSM read. These mirror the ' +
            'data-plane access the deleted connector Lambda/ECS roles had.',
        },
      ],
      true
    );
  }

  private addNagSuppressions(
    taskDef: ecs.FargateTaskDefinition,
    tailscaleStateBucket: s3.Bucket,
    tailscaleStateFsRole: iam.Role,
    runWorkerExecRole: iam.Role
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

    NagSuppressions.addResourceSuppressions(this.database, [
      {
        id: 'AwsSolutions-RDS3',
        reason: 'Single-AZ is intentional for this pre-prod db.t4g.micro; HA is a later upgrade.',
      },
      {
        id: 'AwsSolutions-RDS10',
        reason:
          'Deletion protection off: pre-prod, recreate-over-migrate; storage holds only ' +
          'reconstructable Dagster run/event metadata, not source data.',
      },
      {
        id: 'AwsSolutions-RDS11',
        reason:
          'Default Postgres port (5432); the DB is private (SG-scoped, not publicly accessible).',
      },
    ]);

    // The generated DB credentials secret is a child of the DatabaseInstance; applyToChildren
    // reaches it (its node is not exposed at a stable stack-relative path).
    NagSuppressions.addResourceSuppressions(
      this.database,
      [
        {
          id: 'AwsSolutions-SMG4',
          reason:
            'Automatic secret rotation not configured for this pre-prod, single-team Dagster DB; ' +
            'credential rotation is a later hardening step.',
        },
      ],
      true
    );

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

    NagSuppressions.addResourceSuppressions(this.workersCluster, [
      {
        id: 'AwsSolutions-ECS4',
        reason: 'Container Insights not needed for the ephemeral per-run Dagster run-worker tasks.',
      },
    ]);

    NagSuppressions.addResourceSuppressions(
      taskDef,
      [
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ecr:GetAuthorizationToken, ecs:DescribeTaskDefinition and ecs:RegisterTaskDefinition ' +
            'require resource:* (account-level actions with no resource scope); the EcsRunLauncher ' +
            'ecs:RunTask is scoped to the run-worker_* task-definition family prefix on the workers ' +
            'cluster and its iam:PassRole to the named run-worker roles (base + per-worker); ' +
            'ecs:DescribeTasks/StopTask/TagResource are scoped to tasks on the workers cluster.',
        },
        {
          id: 'AwsSolutions-ECS2',
          reason:
            'Plaintext env vars hold non-secret config only (bucket names, TS_HOSTNAME, the table-' +
            'bucket ARN, and the RUN_WORKER_PROFILES JSON carrying per-worker image refs, role ' +
            'ARNs, and the Massive API-key SSM *parameter name* (not the key)); the Postgres ' +
            'credentials are injected via container `secrets` from Secrets Manager, not plaintext env.',
        },
      ],
      true
    );

    // Run-worker task-role suppressions (base + per-worker) are added at construction time via
    // addRunWorkerRoleNagSuppressions.

    // Run-worker execution role: AWS-managed execution policy + the account-level ECR auth action.
    NagSuppressions.addResourceSuppressions(
      runWorkerExecRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AmazonECSTaskExecutionRolePolicy is the standard AWS-managed execution-role policy ' +
            '(ECR pull + CloudWatch Logs) for the run-worker tasks.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'ecr:GetAuthorizationToken must be granted on resource:* (account-level action, no ' +
            'resource scope); the DB-secret read is scoped to the single generated secret ARN.',
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
