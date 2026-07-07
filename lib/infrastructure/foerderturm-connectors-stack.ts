import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { connectorFunctionName } from '../config/constants';
import { type ContainerArtifact, getLambdaDockerImageCode } from '../config/version-manifest';

/**
 * All ADOT Python auto-instrumentations shipped in the pinned distro (foerderturm's connector
 * Dockerfiles pin aws-otel-python-instrumentation v0.17.1). ADOT disables every instrumentation by
 * default. To enable use {@link enabledInstrumentations}
 * @see https://github.com/aws-observability/aws-otel-python-instrumentation/blob/v0.17.1/lambda-layer/src/otel-instrument
 */
// prettier-ignore
const ADOT_PYTHON_DISABLED_INSTRUMENTATIONS: readonly string[] = [
  'aio-pika', 'aiohttp-client', 'aiohttp-server', 'aiopg', 'asgi', 'asyncio', 'asyncpg', 'boto', 'boto3', 'cassandra', 'celery', 'confluent_kafka', 'dbapi',
  'django', 'elasticsearch', 'falcon', 'fastapi', 'flask', 'grpc_client', 'grpc_server', 'grpc_aio_client', 'grpc_aio_server', 'httpx', 'jinja2', 'kafka', 'logging',
  'mysql', 'mysqlclient', 'pika', 'psycopg', 'psycopg2', 'pymemcache', 'pymongo', 'pymysql', 'pyramid', 'redis', 'remoulade', 'requests', 'sklearn',
  'sqlalchemy', 'sqlite3', 'starlette', 'system_metrics', 'threading', 'tornado', 'tortoiseorm', 'wsgi', 'openai_agents', 'aws_openai_agents', 'aws_crewai', 'aws_langchain', 'aws_mcp', 'aws_llama-index',
];

/**
 * The S3 Tables namespace a connector writes to: the bucket plus the tables to scope the grant to.
 * {@link TableNamespaceStack} satisfies this structurally, so callers just pass the namespace stack.
 */
export interface ConnectorTableNamespace {
  /** Namespace name. */
  readonly namespaceName: string;
  /** Table bucket the namespace lives in. */
  readonly tableBucket: s3tables.ITableBucket;
  /** The namespace's tables, keyed by name; only their ARNs are read here. */
  readonly tables: ReadonlyMap<string, { readonly tableArn: string }>;
}

/** A single connector to deploy as a container-image Lambda. */
export interface ConnectorDefinition {
  /** Vendor this connector processes */
  readonly vendor: string;
  /** Container image artifact resolved from the version manifest (the connector's ECR image). */
  readonly imageArtifact: ContainerArtifact;
  /**
   * Function timeout.
   * @default 15 min - the Lambda maximum; matches the orchestrator's 900s Pipes read timeout so a
   *   long-running partition Lambda isn't cut off client-side.
   */
  readonly timeout?: cdk.Duration;
  /**
   * Memory in MiB (also scales CPU).
   * @default 1024
   */
  readonly memoryMiB?: number;
  /**
   * Extra non-secret environment variables merged onto the function (e.g. `TABLE_BUCKET_ARN`).
   * Merged last, so a connector can override the ADOT defaults if it ever needs to.
   * @default {} - only the shared ADOT/telemetry vars are set.
   */
  readonly environmentVars?: Record<string, string>;
  /**
   * ADOT auto-instrumentations to ENABLE for this connector; every other entry in
   * {@link ADOT_PYTHON_DISABLED_INSTRUMENTATIONS} is disabled. Names are validated at synth time.
   * @default {} - everything besides what ADOT sets is disabled
   */
  readonly enabledInstrumentations?: readonly string[];
  /**
   * S3 Tables namespace this connector writes bronze data to
   * When provided gives the connector access the the namespace.
   * @default undefined - no S3 Tables access.
   */
  readonly tableNamespace?: ConnectorTableNamespace;
  /**
   * Bucket of staged source files the connector reads (e.g. the Sharadar backfill partitions, owned
   * by the orchestrator stack). When set, the function role is granted read on the whole bucket -
   * the Lambda gets the exact source path in the Pipes event, so no prefix scoping is needed here.
   * @default undefined - no staging-bucket read access.
   */
  readonly stagingBucket?: s3.IBucket;
}

export interface FoerderturmConnectorsStackProps extends cdk.StackProps {
  /** Connectors to deploy. Each becomes one container-image Lambda. */
  readonly connectors: ConnectorDefinition[];
  /** The environment this is being deployed in - used in resources names. E.g. `dev` or `prod` */
  readonly environment: string;
  /**
   * Dagster Pipes message bucket, owned by the orchestrator stack and passed by reference. Each
   * connector Lambda is granted write access so it can publish Pipes message chunks the
   * orchestrator reads back.
   */
  readonly pipesMessagesBucket: s3.IBucket;
}

/**
 * Data-plane stack for foerderturm's vendor connectors. Each connector is an independent
 * container-image Lambda (required due to dependencies exceeding zip limit) invoked by
 * the Dagster orchestrator via Pipes. Zip Function and ECS image support can be added later if needed.
 *
 * Functions get deterministic names (`foerderturm-connector-<vendor>-<env>`) so the orchestrator can
 * grant invoke on a name prefix and pass the name as a plain-string env var.
 *
 * Each connector image bakes in the ADOT distro; the functions enable its auto-instrumentation and
 * Application Signals via env vars and carry the managed execution-role policy it needs.
 */
export class FoerderturmConnectorsStack extends cdk.Stack {
  /** Deployed connector functions, keyed by vendor. */
  public readonly functions = new Map<string, lambda.IFunction>();

  private readonly props: FoerderturmConnectorsStackProps;

  constructor(scope: Construct, id: string, props: FoerderturmConnectorsStackProps) {
    super(scope, id, props);
    this.props = props;

    for (const connector of props.connectors) {
      this.functions.set(connector.vendor, this.addConnector(connector));
    }
  }

  private addConnector(def: ConnectorDefinition): lambda.IFunction {
    const { environment, pipesMessagesBucket: pipesBucket } = this.props;
    const functionName = connectorFunctionName(def.vendor, environment);
    const constructId = `Connector${this.pascal(def.vendor)}`;

    const fn = new lambda.DockerImageFunction(this, constructId, {
      functionName,
      code: getLambdaDockerImageCode(this, `${constructId}Image`, def.imageArtifact),
      architecture: lambda.Architecture.X86_64,
      memorySize: def.memoryMiB ?? 1024,
      timeout: def.timeout ?? cdk.Duration.minutes(15),
      tracing: lambda.Tracing.ACTIVE,
      environment: {
        // Activates the ADOT auto-instrumentation baked into the image
        AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
        OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
        OTEL_SERVICE_NAME: `foerderturm-connector-${def.vendor}`,
        OTEL_METRICS_EXPORTER: 'awsemf', // Enable metrics exporter
        OTEL_PYTHON_DISABLED_INSTRUMENTATIONS:
          def.enabledInstrumentations !== undefined
            ? this.enableInstrumentations(def.enabledInstrumentations)
            : '',
        OTEL_RESOURCE_ATTRIBUTES: [
          `service.version=${def.imageArtifact.version}`,
          `service.namespace=foerderturm`,
          `deployment.environment.name=${environment}`,
        ].join(','),
        // S3 Tables warehouse the connector writes to - derived from the same namespace the grant is
        ...(def.tableNamespace && {
          TABLE_BUCKET_ARN: def.tableNamespace.tableBucket.tableBucketArn,
        }),
        // Any extra connector-specific config; merged last so it can override the above.
        ...def.environmentVars,
      },
    });

    // APM policy
    fn.role?.addManagedPolicy(
      iam.ManagedPolicy.fromAwsManagedPolicyName(
        'CloudWatchLambdaApplicationSignalsExecutionRolePolicy'
      )
    );

    // Dagster Pipes message channel: the handler writes message chunks to this bucket.
    pipesBucket.grantPut(fn);

    // Bronze sink: read/write on the namespace's tables (KMS use included).
    if (def.tableNamespace) {
      this.grantTableAccess(fn, def.tableNamespace);
    }

    // Staged source files for sharadar
    def.stagingBucket?.grantRead(fn);

    new cdk.CfnOutput(this, `${constructId}FunctionName`, {
      value: fn.functionName,
      description: `Lambda function name for the ${def.vendor} connector`,
    });

    this.addConnectorNagSuppressions(fn);
    return fn;
  }

  /**
   * Grant read/write on the namespace's tables. S3 Tables has no namespace-level resource, so this
   * scopes per-table: the table id is the segment after `/table/` in each table ARN.
   * Fails if namespace has no tables.
   */
  private grantTableAccess(fn: lambda.IFunction, namespace: ConnectorTableNamespace): void {
    const tableArns = Array.from(namespace.tables.values(), (t) => t.tableArn);
    if (tableArns.length === 0) {
      throw new Error(
        `Provided S3 Tables namespace has no tables to grant access to: ${namespace.namespaceName}`
      );
    }
    for (const arn of tableArns) {
      namespace.tableBucket.grantReadWrite(fn, cdk.Fn.select(1, cdk.Fn.split('/table/', arn)));
    }
  }

  /** `sharadar` -> `Sharadar`, `my-vendor` -> `MyVendor` for construct ids. */
  private pascal(vendor: string): string {
    return vendor
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
  }

  /**
    ADOT disables every instrumentation by default. To enable an instrumentation we need to provide
    a list of everything that is disabled excluding what we want enabled. This funciton generates the env variable values
    to enable the instrumenations you want. Pass the result as the value for `OTEL_PYTHON_DISABLED_INSTRUMENTATIONS`
   */
  private enableInstrumentations(enabled: readonly string[]): string {
    const unknown = enabled.filter((name) => !ADOT_PYTHON_DISABLED_INSTRUMENTATIONS.includes(name));
    if (unknown.length > 0) {
      throw new Error(
        `Unknown ADOT instrumentation(s): ${unknown.join(', ')}. ` +
          `Valid names: ${ADOT_PYTHON_DISABLED_INSTRUMENTATIONS.join(', ')}`
      );
    }
    const enabledSet = new Set(enabled);
    return ADOT_PYTHON_DISABLED_INSTRUMENTATIONS.filter((name) => !enabledSet.has(name)).join(',');
  }

  private addConnectorNagSuppressions(fn: lambda.DockerImageFunction): void {
    NagSuppressions.addResourceSuppressions(
      fn,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWSLambdaBasicExecutionRole is the CDK default for the function log group, and CloudWatchLambdaApplicationSignalsExecutionRolePolicy is the AWS-managed policy required by the ADOT distro to emit Application Signals telemetry.',
        },
        {
          id: 'AwsSolutions-IAM5',
          reason:
            'CloudWatchLambdaApplicationSignalsExecutionRolePolicy and the active-tracing X-Ray policy grant xray/cloudwatch publish actions that do not support resource-level scoping; required for Application Signals export. S3 Tables read/write is scoped to the bronze table bucket but uses the all-tables ("*") form, and the staging-bucket read is scoped to a single bucket (grantRead emits object-key wildcards).',
        },
      ],
      true
    );
  }
}
