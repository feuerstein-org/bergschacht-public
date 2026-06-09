import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as s3 from 'aws-cdk-lib/aws-s3';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';
import { connectorFunctionName } from '../config/constants';
import { type ContainerArtifact, getLambdaDockerImageCode } from '../config/version-manifest';

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
        // Blacklist - by default everything is enabled, remove whatever needs to be enabled
        // Currently enabled: threading
        // Disable all instrumentations by default and only enable when required.
        // ADOT_PYTHON_VERSION (the Dockerfile pins v0.17.1):
        // https://github.com/aws-observability/aws-otel-python-instrumentation/blob/v0.17.1/lambda-layer/src/otel-instrument
        // prettier-ignore
        OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: [
          'aio-pika', 'aiohttp-client', 'aiohttp-server', 'aiopg', 'asgi', 'asyncio', 'asyncpg', 'boto', 'boto3', 'cassandra', 'celery', 'confluent_kafka', 'dbapi',
          'django', 'elasticsearch', 'falcon', 'fastapi', 'flask', 'grpc_client', 'grpc_server', 'grpc_aio_client', 'grpc_aio_server', 'httpx', 'jinja2', 'kafka', 'logging',
          'mysql', 'mysqlclient', 'pika', 'psycopg', 'psycopg2', 'pymemcache', 'pymongo', 'pymysql', 'pyramid', 'redis', 'remoulade', 'requests', 'sklearn',
          'sqlalchemy', 'sqlite3', 'starlette', 'system_metrics', 'tornado', 'tortoiseorm', 'wsgi', 'openai_agents', 'aws_openai_agents', 'aws_crewai', 'aws_langchain', 'aws_mcp', 'aws_llama-index',
        ].join(','),
        OTEL_RESOURCE_ATTRIBUTES: [
          `service.version=${def.imageArtifact.version}`,
          `service.namespace=foerderturm`,
          `deployment.environment.name=${environment}`,
        ].join(','),
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

    new cdk.CfnOutput(this, `${constructId}FunctionName`, {
      value: fn.functionName,
      description: `Lambda function name for the ${def.vendor} connector`,
    });

    this.addConnectorNagSuppressions(fn);
    return fn;
  }

  /** `sharadar` -> `Sharadar`, `my-vendor` -> `MyVendor` for construct ids. */
  private pascal(vendor: string): string {
    return vendor
      .split(/[-_]/)
      .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
      .join('');
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
            'CloudWatchLambdaApplicationSignalsExecutionRolePolicy and the active-tracing X-Ray policy grant xray/cloudwatch publish actions that do not support resource-level scoping; required for Application Signals export.',
        },
      ],
      true
    );
  }
}
