import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { FoerderturmStack } from '../../lib/infrastructure/foerderturm-stack';

const TEST_IMAGE_ARTIFACT = {
  repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
  imageTag: 'foerderturm-foerderturm-0.1.0',
  version: '0.1.0',
  commitSha: 'abcdef1234567',
};

const TEST_LITESTREAM_IMAGE_ARTIFACT = {
  repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
  imageTag: 'foerderturm-foerderturm-litestream-0.1.0',
  version: '0.1.0',
  commitSha: 'abcdef1234567',
};

const TEST_TAILSCALE_IMAGE_ARTIFACT = {
  repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
  imageTag: 'foerderturm-foerderturm-tailscale-0.1.0',
  version: '0.1.0',
  commitSha: 'abcdef1234567',
};

/** Match the synthesized container Image (an `Fn::Join` token) by its image tag. */
const imageWithTag = (tag: string): unknown => ({
  'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(tag)])]),
});

/** Instantiate a `FoerderturmStack` with shared test image artifacts. */
function createTestStack(opts: { desiredCount?: number }): FoerderturmStack {
  const app = new cdk.App();
  return new FoerderturmStack(app, 'TestFoerderturm', {
    environment: 'test',
    dagsterImageArtifact: TEST_IMAGE_ARTIFACT,
    litestreamImageArtifact: TEST_LITESTREAM_IMAGE_ARTIFACT,
    tailscaleImageArtifact: TEST_TAILSCALE_IMAGE_ARTIFACT,
    desiredCount: opts.desiredCount ?? 1,
    tailscaleHostname: 'foerderturm-test',
  });
}

describe('FoerderturmStack', () => {
  let stack: FoerderturmStack;
  let template: Template;

  beforeEach(() => {
    stack = createTestStack({});
    template = Template.fromStack(stack);
  });

  test('creates a VPC with public subnets only and no NAT gateways', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    template.allResources('AWS::EC2::Subnet', {
      Properties: Match.objectLike({ MapPublicIpOnLaunch: true }),
    });
  });

  test('creates a Litestream S3 bucket with KMS encryption and versioning', () => {
    // litestream + pipes-messages + tailscale-state file system bucket
    template.resourceCountIs('AWS::S3::Bucket', 3);
    template.hasResourceProperties('AWS::S3::Bucket', {
      VersioningConfiguration: { Status: 'Enabled' },
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            BucketKeyEnabled: true,
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'aws:kms' },
          }),
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
    });
  });

  test('creates a transient Pipes messages bucket with S3-managed encryption and a 1-day expiry', () => {
    template.hasResourceProperties('AWS::S3::Bucket', {
      BucketEncryption: {
        ServerSideEncryptionConfiguration: [
          Match.objectLike({
            ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' },
          }),
        ],
      },
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        BlockPublicPolicy: true,
        IgnorePublicAcls: true,
        RestrictPublicBuckets: true,
      },
      LifecycleConfiguration: {
        Rules: Match.arrayWith([
          Match.objectLike({
            Id: 'ExpirePipesMessages',
            Status: 'Enabled',
            ExpirationInDays: 1,
          }),
          Match.objectLike({
            Id: 'AbortIncompleteMultipartUpload',
            Status: 'Enabled',
            AbortIncompleteMultipartUpload: { DaysAfterInitiation: 1 },
          }),
        ]),
      },
    });
  });

  test('references the Tailscale OAuth SSM SecureString parameter on the tailscale container', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'tailscale',
          Secrets: Match.arrayWith([
            Match.objectLike({
              Name: 'TS_AUTHKEY',
              ValueFrom: {
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([
                    Match.stringLikeRegexp('/foerderturm-test/tailscale/oauth-client'),
                  ]),
                ]),
              },
            }),
          ]),
        }),
      ]),
    });
  });

  test('creates a CloudWatch log group with 30-day retention', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/ecs/foerderturm-test',
      RetentionInDays: 30,
    });
  });

  test('creates a Fargate task definition with the dagster-home volume and all six containers', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '2048',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'X86_64',
        OperatingSystemFamily: 'LINUX',
      },
      Volumes: Match.arrayWith([Match.objectLike({ Name: 'dagster-home' })]),
      ContainerDefinitions: Match.arrayWith([
        // (1) litestream-restore: init, non-essential. Uses the ECR-baked Litestream image
        Match.objectLike({
          Name: 'litestream-restore',
          Image: imageWithTag(TEST_LITESTREAM_IMAGE_ARTIFACT.imageTag),
          Essential: false,
          EntryPoint: ['/bin/sh', '-c'],
          Command: [
            Match.stringLikeRegexp(
              'litestream restore .*runs\\.db.*event_log\\.db.*schedules\\.db.*chown -R 1000:1000'
            ),
          ],
          Environment: Match.arrayWith([Match.objectLike({ Name: 'LITESTREAM_BUCKET' })]),
          MountPoints: Match.arrayWith([
            Match.objectLike({ SourceVolume: 'dagster-home', ContainerPath: '/app/dagster_home' }),
          ]),
        }),
        // (2) dagster-init: init, non-essential, runs alembic migrate to avoid webserver/daemon race.
        Match.objectLike({
          Name: 'dagster-init',
          Image: imageWithTag(TEST_IMAGE_ARTIFACT.imageTag),
          Essential: false,
          EntryPoint: ['/bin/sh', '-c'],
          Command: [Match.stringLikeRegexp('exec dagster instance migrate')],
          DependsOn: Match.arrayWith([
            Match.objectLike({ ContainerName: 'litestream-restore', Condition: 'SUCCESS' }),
          ]),
        }),
        // (3) dagster-webserver: serves :3000, depends on dagster-init SUCCESS. No shell wrapper.
        Match.objectLike({
          Name: 'dagster-webserver',
          Image: imageWithTag(TEST_IMAGE_ARTIFACT.imageTag),
          Essential: true,
          Command: [
            'dagster-webserver',
            '--host',
            '0.0.0.0',
            '--port',
            '3000',
            '--module-name',
            'foerderturm',
          ],
          PortMappings: Match.arrayWith([
            Match.objectLike({ ContainerPort: 3000, Protocol: 'tcp' }),
          ]),
          MountPoints: Match.arrayWith([
            Match.objectLike({ SourceVolume: 'dagster-home', ContainerPath: '/app/dagster_home' }),
          ]),
          DependsOn: Match.arrayWith([
            Match.objectLike({ ContainerName: 'dagster-init', Condition: 'SUCCESS' }),
          ]),
        }),
        // (4) dagster-daemon: daemon command, depends on dagster-init SUCCESS.
        Match.objectLike({
          Name: 'dagster-daemon',
          Image: imageWithTag(TEST_IMAGE_ARTIFACT.imageTag),
          Essential: true,
          Command: ['dagster-daemon', 'run', '--module-name', 'foerderturm'],
          DependsOn: Match.arrayWith([
            Match.objectLike({ ContainerName: 'dagster-init', Condition: 'SUCCESS' }),
          ]),
        }),
        // (5) litestream sidecar
        Match.objectLike({
          Name: 'litestream',
          Image: imageWithTag(TEST_LITESTREAM_IMAGE_ARTIFACT.imageTag),
          Essential: true,
          Command: ['replicate', '-config', '/etc/litestream.yml'],
          Environment: Match.arrayWith([Match.objectLike({ Name: 'LITESTREAM_BUCKET' })]),
          DependsOn: Match.arrayWith([
            Match.objectLike({ ContainerName: 'dagster-init', Condition: 'SUCCESS' }),
          ]),
        }),
        // (6) tailscale sidecar
        Match.objectLike({
          Name: 'tailscale',
          Image: imageWithTag(TEST_TAILSCALE_IMAGE_ARTIFACT.imageTag),
          Essential: true,
          Environment: Match.arrayWith([
            { Name: 'TS_HOSTNAME', Value: 'foerderturm-test' },
            { Name: 'TS_USERSPACE', Value: 'true' },
            Match.objectLike({ Name: 'TS_EXTRA_ARGS' }),
            { Name: 'TS_SERVE_CONFIG', Value: '/etc/tailscale/serve.json' },
            { Name: 'TS_STATE_DIR', Value: '/var/lib/tailscale' },
            { Name: 'TS_AUTH_ONCE', Value: 'true' },
          ]),
          Secrets: Match.arrayWith([Match.objectLike({ Name: 'TS_AUTHKEY' })]),
        }),
      ]),
    });
  });

  test('names the ECS cluster and service', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'foerderturm-test',
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'foerderturm-test',
    });
  });

  test('injects the Pipes bucket name and connector Lambda name into the dagster containers', () => {
    const pipesEnv = Match.arrayWith([
      Match.objectLike({ Name: 'PIPES_MESSAGES_BUCKET' }),
      { Name: 'CONNECTOR_EXAMPLE_LAMBDA_NAME', Value: 'foerderturm-connector-example-test' },
    ]);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'dagster-webserver', Environment: pipesEnv }),
        Match.objectLike({ Name: 'dagster-daemon', Environment: pipesEnv }),
      ]),
    });
  });

  test('grants the task role invoke scoped to the connector Lambda name prefix', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: 'lambda:InvokeFunction',
            Resource: {
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('function:foerderturm-connector-\\*')]),
              ]),
            },
          }),
        ]),
      },
    });
  });

  test('grants the task role read access to the Pipes messages bucket', () => {
    // grantRead emits exactly these three actions, which distinguishes it from the litestream
    // grantReadWrite (which also includes Put*/Delete*).
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: ['s3:GetObject*', 's3:GetBucket*', 's3:List*'],
          }),
        ]),
      },
    });
  });

  test('grants the task role read/write access to exactly one litestream bucket', () => {
    template.resourcePropertiesCountIs(
      'AWS::IAM::Policy',
      {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: Match.arrayWith(['s3:PutObject']),
            }),
          ]),
        },
      },
      1
    );
  });

  test('creates an ECS service with the requested desiredCount and stop-then-start deployment', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
      DesiredCount: 1,
      LaunchType: 'FARGATE',
      DeploymentConfiguration: {
        MinimumHealthyPercent: 0,
        MaximumPercent: 100,
      },
      NetworkConfiguration: {
        AwsvpcConfiguration: Match.objectLike({
          AssignPublicIp: 'ENABLED',
        }),
      },
      EnableExecuteCommand: true,
    });
  });

  test('grants the task execution role cross-account ECR pull scoped to the source repository', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Effect: 'Allow',
            Action: Match.arrayWith([
              'ecr:BatchCheckLayerAvailability',
              'ecr:GetDownloadUrlForLayer',
              'ecr:BatchGetImage',
            ]),
            Resource: 'arn:aws:ecr:us-east-1:123456789012:repository/feuerstein',
          }),
        ]),
      },
    });
  });

  test('creates CloudFormation outputs', () => {
    template.hasOutput('ServiceName', {});
    template.hasOutput('ClusterName', {});
    template.hasOutput('LitestreamBucketName', {});
    template.hasOutput('PipesMessagesBucketName', {});
    template.hasOutput('TailscaleSecretName', {});
    template.hasOutput('TailscaleStateFileSystemId', {});
    template.hasOutput('TailscaleHostname', {});
  });

  describe('Tailscale statedir persistence (S3 Files)', () => {
    test('creates a versioned, S3-managed-encrypted file system bucket', () => {
      template.hasResource('AWS::S3::Bucket', {
        DeletionPolicy: 'Retain',
        Properties: Match.objectLike({
          VersioningConfiguration: { Status: 'Enabled' },
          BucketEncryption: {
            ServerSideEncryptionConfiguration: [
              Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
            ],
          },
        }),
      });
    });

    test('creates an S3 Files file system bound to the bucket and a service role', () => {
      template.resourceCountIs('AWS::S3Files::FileSystem', 1);
      template.hasResourceProperties('AWS::S3Files::FileSystem', {
        AcceptBucketWarning: true,
        // The CFN schema requires the bucket ARN (not the name) — must render as GetAtt …Arn.
        Bucket: { 'Fn::GetAtt': [Match.stringLikeRegexp('TailscaleStateBucket'), 'Arn'] },
        RoleArn: { 'Fn::GetAtt': [Match.stringLikeRegexp('TailscaleStateFsRole'), 'Arn'] },
      });
    });

    test('the file system service role trusts the S3 Files (EFS) service principal', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        AssumeRolePolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: 'sts:AssumeRole',
              Principal: { Service: 'elasticfilesystem.amazonaws.com' },
            }),
          ]),
        },
      });
    });

    test('grants the file system service role bucket-sync + EventBridge permissions', () => {
      // S3 Files (as the service) must list the bucket, read/write its objects, and manage the
      // EventBridge rules it uses to detect bucket changes.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Sid: 'S3BucketPermissions',
              Effect: 'Allow',
              Action: ['s3:ListBucket', 's3:ListBucketVersions'],
              Condition: { StringEquals: { 'aws:ResourceAccount': Match.anyValue() } },
            }),
            Match.objectLike({
              Sid: 'S3ObjectPermissions',
              Effect: 'Allow',
              Action: [
                's3:AbortMultipartUpload',
                's3:DeleteObject*',
                's3:GetObject*',
                's3:List*',
                's3:PutObject*',
              ],
            }),
            Match.objectLike({
              Sid: 'EventBridgeManage',
              Effect: 'Allow',
              Action: [
                'events:DeleteRule',
                'events:DisableRule',
                'events:EnableRule',
                'events:PutRule',
                'events:PutTargets',
                'events:RemoveTargets',
              ],
              Condition: {
                StringEquals: { 'events:ManagedBy': 'elasticfilesystem.amazonaws.com' },
              },
            }),
            Match.objectLike({
              Sid: 'EventBridgeRead',
              Effect: 'Allow',
              Action: [
                'events:DescribeRule',
                'events:ListRuleNamesByTarget',
                'events:ListRules',
                'events:ListTargetsByRule',
              ],
            }),
          ]),
        },
      });
    });

    test('creates a mount target per public subnet', () => {
      // The env-less test stack resolves to 2 dummy AZs -> 2 public subnets -> 2 mount targets.
      template.resourceCountIs('AWS::S3Files::MountTarget', 2);
    });

    test('mounts the file system volume into the tailscale container at the statedir', () => {
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        Volumes: Match.arrayWith([
          Match.objectLike({
            Name: 'tailscale-state',
            S3FilesVolumeConfiguration: Match.objectLike({
              FileSystemArn: Match.anyValue(),
              RootDirectory: '/',
            }),
          }),
        ]),
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({
            Name: 'tailscale',
            Environment: Match.arrayWith([{ Name: 'TS_STATE_DIR', Value: '/var/lib/tailscale' }]),
            MountPoints: Match.arrayWith([
              Match.objectLike({
                SourceVolume: 'tailscale-state',
                ContainerPath: '/var/lib/tailscale',
                ReadOnly: false,
              }),
            ]),
          }),
        ]),
      });
    });

    test('grants the task role the S3 Files client managed policy', () => {
      template.hasResourceProperties('AWS::IAM::Role', {
        ManagedPolicyArns: Match.arrayWith([
          {
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('AmazonS3FilesClientFullAccess')]),
            ]),
          },
        ]),
      });
    });

    test('opens NFS (2049) from the task to the mount-target security group', () => {
      template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
        IpProtocol: 'tcp',
        FromPort: 2049,
        ToPort: 2049,
      });
    });
  });

  test('exports key constructs for use by other stacks', () => {
    expect(stack.service).toBeDefined();
    expect(stack.cluster).toBeDefined();
    expect(stack.vpc).toBeDefined();
    expect(stack.litestreamBucket).toBeDefined();
    expect(stack.pipesMessagesBucket).toBeDefined();
    expect(stack.tailscaleSecret).toBeDefined();
  });

  describe('with desiredCount=0 (stopped)', () => {
    test('the service is deployed with zero tasks', () => {
      const stoppedStack = createTestStack({
        desiredCount: 0,
      });
      const stoppedTemplate = Template.fromStack(stoppedStack);
      stoppedTemplate.hasResourceProperties('AWS::ECS::Service', {
        DesiredCount: 0,
      });
    });
  });
});
