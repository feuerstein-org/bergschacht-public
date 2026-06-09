import * as cdk from 'aws-cdk-lib/core';
import * as s3 from 'aws-cdk-lib/aws-s3';
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
