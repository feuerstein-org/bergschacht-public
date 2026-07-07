import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import { Template, Match, Capture } from 'aws-cdk-lib/assertions';
import {
  FoerderturmConnectorsStack,
  ConnectorDefinition,
} from '../../lib/infrastructure/foerderturm-connectors-stack';

const TEST_CONNECTOR_IMAGE_ARTIFACT = {
  repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
  imageTag: 'foerderturm-connector-example-lambda-container-0.1.0',
  version: '0.1.0',
  commitSha: 'abcdef1234567',
};

/**
 * Instantiate a `FoerderturmConnectorsStack`. The Pipes bucket is owned by the orchestrator stack
 * in production, so it's created in a separate stack here and passed by reference.
 */
function createTestStack(connectors: ConnectorDefinition[]): {
  stack: FoerderturmConnectorsStack;
  template: Template;
} {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const bucketStack = new cdk.Stack(app, 'TestBucket', { env });
  const pipesMessagesBucket = new s3.Bucket(bucketStack, 'PipesBucket');
  const stack = new FoerderturmConnectorsStack(app, 'TestConnectors', {
    environment: 'test',
    connectors,
    pipesMessagesBucket,
    env,
  });
  return { stack, template: Template.fromStack(stack) };
}

const EXAMPLE: ConnectorDefinition = {
  vendor: 'example',
  imageArtifact: TEST_CONNECTOR_IMAGE_ARTIFACT,
  enabledInstrumentations: ['threading'],
};

describe('FoerderturmConnectorsStack', () => {
  let stack: FoerderturmConnectorsStack;
  let template: Template;

  beforeEach(() => {
    ({ stack, template } = createTestStack([EXAMPLE]));
  });

  test('deploys one container-image Lambda per connector with a deterministic name', () => {
    template.resourceCountIs('AWS::Lambda::Function', 1);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'foerderturm-connector-example-test',
      PackageType: 'Image',
      Architectures: ['x86_64'],
      MemorySize: 1024,
      Timeout: 900,
      Code: {
        ImageUri: {
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp(TEST_CONNECTOR_IMAGE_ARTIFACT.imageTag)]),
          ]),
        },
      },
    });
  });

  test('activates the baked-in ADOT App Signals instrumentation via env vars', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      TracingConfig: { Mode: 'Active' },
      Environment: {
        Variables: Match.objectLike({
          AWS_LAMBDA_EXEC_WRAPPER: '/opt/otel-instrument',
          OTEL_AWS_APPLICATION_SIGNALS_ENABLED: 'true',
          OTEL_SERVICE_NAME: 'foerderturm-connector-example',
          OTEL_METRICS_EXPORTER: 'awsemf',
          OTEL_RESOURCE_ATTRIBUTES:
            'service.version=0.1.0,service.namespace=foerderturm,deployment.environment.name=test',
        }),
      },
    });
  });

  test('enables threading instrumentation by omitting it from the ADOT disabled list', () => {
    // Make sure that the needed instrumentation is enabled.
    const disabled = new Capture();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: disabled }),
      },
    });
    const disabledList = disabled.asString().split(',');
    expect(disabledList).not.toContain('threading');
    expect(disabledList).toContain('logging');
  });

  test('attaches the managed Application Signals execution-role policy', () => {
    template.hasResourceProperties('AWS::IAM::Role', {
      ManagedPolicyArns: Match.arrayWith([
        Match.objectLike({
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([
              Match.stringLikeRegexp('CloudWatchLambdaApplicationSignalsExecutionRolePolicy'),
            ]),
          ]),
        }),
      ]),
    });
  });

  test('grants the connector write access to the Pipes messages bucket', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['s3:PutObject']),
          }),
        ]),
      },
    });
  });

  test('emits a function-name output and exposes the function on the construct', () => {
    template.hasOutput('ConnectorExampleFunctionName', {});
    expect(stack.functions.get('example')).toBeDefined();
  });

  test('deploys an independent Lambda per connector for multiple connectors', () => {
    const { stack: multi, template: multiTemplate } = createTestStack([
      EXAMPLE,
      { vendor: 'other-vendor', imageArtifact: TEST_CONNECTOR_IMAGE_ARTIFACT },
    ]);
    multiTemplate.resourceCountIs('AWS::Lambda::Function', 2);
    multiTemplate.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'foerderturm-connector-other-vendor-test',
    });
    // PascalCase construct id derives the output name from the hyphenated vendor.
    multiTemplate.hasOutput('ConnectorOtherVendorFunctionName', {});
    expect(multi.functions.get('other-vendor')).toBeDefined();
  });
});

/**
 * Build a stack with a single bronze-writing connector (Sharadar-style): an S3 Tables sink, a
 * staged source bucket to read, extra env vars, and a custom enabled-instrumentation set.
 */
function createBronzeConnectorStack(overrides: Partial<ConnectorDefinition> = {}): {
  stack: FoerderturmConnectorsStack;
  template: Template;
} {
  const app = new cdk.App();
  const env = { account: '123456789012', region: 'us-east-1' };
  const bucketStack = new cdk.Stack(app, 'TestBucket', { env });
  const pipesMessagesBucket = new s3.Bucket(bucketStack, 'PipesBucket');
  const stagingBucket = new s3.Bucket(bucketStack, 'StagingBucket');
  const tableBucket = new s3tables.TableBucket(bucketStack, 'TableBucket', {
    tableBucketName: 'test-erzlager',
  });
  const connectors: ConnectorDefinition[] = [
    {
      vendor: 'sharadar',
      imageArtifact: TEST_CONNECTOR_IMAGE_ARTIFACT,
      tableNamespace: {
        namespaceName: 'bronze',
        tableBucket,
        tables: new Map([
          [
            'tbl-1',
            {
              tableArn: 'arn:aws:s3tables:us-east-1:123456789012:bucket/test-erzlager/table/tbl-1',
            },
          ],
          [
            'tbl-2',
            {
              tableArn: 'arn:aws:s3tables:us-east-1:123456789012:bucket/test-erzlager/table/tbl-2',
            },
          ],
        ]),
      },
      stagingBucket,
      enabledInstrumentations: ['threading', 'boto3'],
      ...overrides,
    },
  ];
  const stack = new FoerderturmConnectorsStack(app, 'TestConnectors', {
    environment: 'test',
    connectors,
    pipesMessagesBucket,
    env,
  });
  return { stack, template: Template.fromStack(stack) };
}

describe('FoerderturmConnectorsStack - bronze-writing connector', () => {
  let template: Template;

  beforeEach(() => {
    ({ template } = createBronzeConnectorStack());
  });

  test('injects TABLE_BUCKET_ARN derived from the namespace bucket', () => {
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'foerderturm-connector-sharadar-test',
      Environment: { Variables: Match.objectLike({ TABLE_BUCKET_ARN: Match.anyValue() }) },
    });
  });

  test('merges extra environmentVars onto the function', () => {
    const { template: withVars } = createBronzeConnectorStack({
      environmentVars: { CUSTOM_FLAG: 'on' },
    });
    withVars.hasResourceProperties('AWS::Lambda::Function', {
      Environment: { Variables: Match.objectLike({ CUSTOM_FLAG: 'on' }) },
    });
  });

  test('enables exactly the requested instrumentations via the disabled complement', () => {
    const disabled = new Capture();
    template.hasResourceProperties('AWS::Lambda::Function', {
      Environment: {
        Variables: Match.objectLike({ OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: disabled }),
      },
    });
    const disabledList = disabled.asString().split(',');
    // Enabled: omitted from the disabled list.
    expect(disabledList).not.toContain('threading');
    expect(disabledList).not.toContain('boto3');
    // Not enabled: still disabled.
    expect(disabledList).toContain('requests');
    expect(disabledList).toContain('logging');
  });

  test('throws at synth on an unknown instrumentation name', () => {
    expect(() =>
      createBronzeConnectorStack({ enabledInstrumentations: ['threading', 'bogus'] })
    ).toThrow(/Unknown ADOT instrumentation/);
  });

  test('grants S3 Tables read/write scoped to the given tables, not all tables', () => {
    // Read/write actions are present...
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith(['s3tables:PutTableData']),
          }),
        ]),
      },
    });
    // ...and resources are scoped to the specific tables, not the `table/*` wildcard.
    const policies = JSON.stringify(Object.values(template.findResources('AWS::IAM::Policy')));
    expect(policies).toContain('/table/tbl-1');
    expect(policies).toContain('/table/tbl-2');
    expect(policies).not.toContain('/table/*');
  });

  test('grants read on the staged source bucket', () => {
    // grantRead emits the GetObject*/List* action set; the bucket ARN is a cross-stack token.
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([Match.stringLikeRegexp('s3:GetObject')]),
          }),
        ]),
      },
    });
  });
});
