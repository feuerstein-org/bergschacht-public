import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';
import * as sns from 'aws-cdk-lib/aws-sns';
import { FoerderturmStack } from '../../lib/infrastructure/foerderturm-stack';
import type { FoerderturmLifecycleConfig } from '../../lib/infrastructure/foerderturm-lifecycle';
import type { BronzeTableNamespace } from '../../lib/infrastructure/table-access';

const TEST_IMAGE_ARTIFACT = {
  repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
  imageTag: 'foerderturm-foerderturm-0.1.0',
  version: '0.1.0',
  commitSha: 'abcdef1234567',
};

const TEST_TAILSCALE_IMAGE_ARTIFACT = {
  repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
  imageTag: 'foerderturm-foerderturm-tailscale-0.1.0',
  version: '0.1.0',
  commitSha: 'abcdef1234567',
};

/** Run-worker images, keyed by the `worker` run-tag value. */
const TEST_RUNWORKER_IMAGES = {
  massive: {
    repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
    imageTag: 'foerderturm-connector-massive-worker-0.3.0',
    version: '0.3.0',
    commitSha: 'abcdef1234567',
  },
  sharadar: {
    repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
    imageTag: 'foerderturm-connector-sharadar-worker-0.2.0',
    version: '0.2.0',
    commitSha: 'abcdef1234567',
  },
  example: {
    repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/feuerstein',
    imageTag: 'foerderturm-connector-example-worker-0.3.0',
    version: '0.3.0',
    commitSha: 'abcdef1234567',
  },
};

const BRONZE_BUCKET_ARN = 'arn:aws:s3tables:us-east-1:123456789012:bucket/example-erzlager-test';
const MASSIVE_API_KEY_PARAM = '/foerderturm-test/massive/api-key';

/** Run-worker profiles: image, secrets, per-worker env, and Fargate size. */
const TEST_WORKERS = {
  massive: {
    image: TEST_RUNWORKER_IMAGES.massive,
    ssmSecureParams: { MASSIVE_API_KEY_SSM_PARAMETER: MASSIVE_API_KEY_PARAM },
    environmentVars: { OTEL_PYTHON_DISABLED_INSTRUMENTATIONS: 'urllib3' },
  },
  // Sharadar's corporate-actions ingest is memory-hungry, so give it a bigger default size.
  sharadar: { image: TEST_RUNWORKER_IMAGES.sharadar, cpu: 2048, memoryMiB: 8192 },
  example: { image: TEST_RUNWORKER_IMAGES.example },
};

/** Match the synthesized container Image (an `Fn::Join` token) by its image tag. */
const imageWithTag = (tag: string): unknown => ({
  'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp(tag)])]),
});

/** Build a bronze S3 Tables namespace fixture (imported by ARN, so grants are literal). */
function bronzeFixture(app: cdk.App): BronzeTableNamespace {
  const fixtures = new cdk.Stack(app, 'Fixtures');
  const tableBucket = s3tables.TableBucket.fromTableBucketArn(
    fixtures,
    'BronzeBucket',
    BRONZE_BUCKET_ARN
  );
  return {
    namespaceName: 'bronze',
    tableBucket,
    tables: new Map([
      ['security_master', { tableArn: `${BRONZE_BUCKET_ARN}/table/00000000-0000-0000-0000-sm` }],
      ['fact_daily_ohlcv', { tableArn: `${BRONZE_BUCKET_ARN}/table/00000000-0000-0000-0000-oh` }],
    ]),
  };
}

/** Imported alert topic from a separate stack, so the lifecycle alarms have a target to point at. */
function alertTopicFixture(app: cdk.App): sns.ITopic {
  const fixtures = new cdk.Stack(app, 'AlertFixtures');
  return sns.Topic.fromTopicArn(
    fixtures,
    'AlertTopic',
    'arn:aws:sns:us-east-1:123456789012:PagerDutyAlertsTest'
  );
}

/** Instantiate a `FoerderturmStack` with shared test image artifacts, manual-only lifecycle by default. */
function createTestStack(
  opts: {
    readonly lifecycle?: FoerderturmLifecycleConfig;
  } = {}
): FoerderturmStack {
  const app = new cdk.App();
  return new FoerderturmStack(app, 'TestFoerderturm', {
    environment: 'test',
    dagsterImageArtifact: TEST_IMAGE_ARTIFACT,
    tailscaleImageArtifact: TEST_TAILSCALE_IMAGE_ARTIFACT,
    bronze: bronzeFixture(app),
    workers: TEST_WORKERS,
    tailscaleHostname: 'foerderturm-test',
    lifecycle: opts.lifecycle ?? {},
    alertTopic: alertTopicFixture(app),
  });
}

describe('FoerderturmStack', () => {
  let stack: FoerderturmStack;
  let template: Template;

  beforeEach(() => {
    stack = createTestStack({});
    template = Template.fromStack(stack);
  });

  test('creates a VPC with public + isolated-DB subnets and no NAT gateways', () => {
    template.resourceCountIs('AWS::EC2::VPC', 1);
    template.resourceCountIs('AWS::EC2::NatGateway', 0);
    // Public subnets (orchestrator + run-worker tasks) map public IPs; the PRIVATE_ISOLATED DB
    // subnets do not. No NAT either way (isolated subnets need none).
    const subnets = template.findResources('AWS::EC2::Subnet');
    const mapsPublicIp = Object.values(subnets).map(
      (s) => s.Properties.MapPublicIpOnLaunch === true
    );
    expect(mapsPublicIp.filter((v) => v).length).toBe(2);
    expect(mapsPublicIp.filter((v) => !v).length).toBe(2);
  });

  test('creates a single-AZ encrypted db.t4g.micro Postgres instance with a generated secret', () => {
    template.resourceCountIs('AWS::RDS::DBInstance', 1);
    template.hasResourceProperties('AWS::RDS::DBInstance', {
      Engine: 'postgres',
      EngineVersion: '18.3',
      DBInstanceClass: 'db.t4g.micro',
      MultiAZ: false,
      AllocatedStorage: '20',
      StorageType: 'gp3',
      StorageEncrypted: true,
      DBName: 'dagster',
      PubliclyAccessible: false,
      MasterUsername: 'dagster',
      MasterUserPassword: {
        'Fn::Join': Match.arrayWith([Match.arrayWith([Match.stringLikeRegexp('SecretString')])]),
      },
    });
    template.hasResourceProperties('AWS::SecretsManager::Secret', {
      Name: 'foerderturm-test/dagster/db',
    });
  });

  test('allows Postgres (5432) ingress from the orchestrator and run-worker task SGs', () => {
    const ingress5432 = template.findResources('AWS::EC2::SecurityGroupIngress', {
      Properties: Match.objectLike({ IpProtocol: 'tcp', FromPort: 5432, ToPort: 5432 }),
    });
    expect(Object.keys(ingress5432).length).toBe(2);
  });

  test('injects the Postgres credentials into the dagster containers as secrets', () => {
    const pgSecrets = Match.arrayWith([
      Match.objectLike({ Name: 'DAGSTER_PG_HOST' }),
      Match.objectLike({ Name: 'DAGSTER_PG_PORT' }),
      Match.objectLike({ Name: 'DAGSTER_PG_USERNAME' }),
      Match.objectLike({ Name: 'DAGSTER_PG_PASSWORD' }),
      Match.objectLike({ Name: 'DAGSTER_PG_DB' }),
    ]);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'dagster-init', Secrets: pgSecrets }),
        Match.objectLike({ Name: 'dagster-webserver', Secrets: pgSecrets }),
        Match.objectLike({ Name: 'dagster-daemon', Secrets: pgSecrets }),
      ]),
    });
  });

  test('creates a retained Sharadar staging bucket and exposes it on the construct', () => {
    template.hasResource('AWS::S3::Bucket', {
      DeletionPolicy: 'Retain',
      Properties: Match.objectLike({
        BucketEncryption: {
          ServerSideEncryptionConfiguration: [
            Match.objectLike({ ServerSideEncryptionByDefault: { SSEAlgorithm: 'AES256' } }),
          ],
        },
        PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true }),
      }),
    });
    template.hasOutput('SharadarStagingBucketName', {});
    expect(stack.sharadarStagingBucket).toBeDefined();
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

  test('creates a Fargate task definition with the three dagster containers + tailscale', () => {
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      Cpu: '512',
      Memory: '2048',
      RequiresCompatibilities: ['FARGATE'],
      RuntimePlatform: {
        CpuArchitecture: 'X86_64',
        OperatingSystemFamily: 'LINUX',
      },
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Name: 'dagster-init',
          Image: imageWithTag(TEST_IMAGE_ARTIFACT.imageTag),
          Essential: false,
          Command: ['dagster', 'instance', 'migrate'],
        }),
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
          DependsOn: Match.arrayWith([
            Match.objectLike({ ContainerName: 'dagster-init', Condition: 'SUCCESS' }),
          ]),
        }),
        Match.objectLike({
          Name: 'dagster-daemon',
          Image: imageWithTag(TEST_IMAGE_ARTIFACT.imageTag),
          Essential: true,
          Command: ['dagster-daemon', 'run', '--module-name', 'foerderturm'],
          DependsOn: Match.arrayWith([
            Match.objectLike({ ContainerName: 'dagster-init', Condition: 'SUCCESS' }),
          ]),
        }),
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

  test('names the ECS clusters and service', () => {
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'foerderturm-test',
    });
    template.hasResourceProperties('AWS::ECS::Cluster', {
      ClusterName: 'foerderturm-workers-test',
    });
    template.hasResourceProperties('AWS::ECS::Service', {
      ServiceName: 'foerderturm-test',
    });
  });

  test('injects the SHARED run-worker runtime config into the dagster containers', () => {
    // Only the truly shared config is a standalone container env var now: the S3 Tables warehouse ARN and the per-env OTEL attributes.
    const runtimeEnv = Match.arrayWith([
      { Name: 'TABLE_BUCKET_ARN', Value: BRONZE_BUCKET_ARN },
      {
        Name: 'OTEL_RESOURCE_ATTRIBUTES',
        Value: 'service.namespace=foerderturm,deployment.environment.name=test',
      },
    ]);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({ Name: 'dagster-webserver', Environment: runtimeEnv }),
        Match.objectLike({ Name: 'dagster-daemon', Environment: runtimeEnv }),
      ]),
    });
  });

  test('associates the FARGATE and FARGATE_SPOT capacity providers on the workers cluster only', () => {
    template.resourceCountIs('AWS::ECS::ClusterCapacityProviderAssociations', 1);
    template.hasResourceProperties('AWS::ECS::ClusterCapacityProviderAssociations', {
      CapacityProviders: ['FARGATE', 'FARGATE_SPOT'],
      Cluster: { Ref: Match.stringLikeRegexp('WorkersCluster') },
    });
  });

  test('creates an egress-only security group for the run-worker tasks', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: Match.stringLikeRegexp('run-worker ECS tasks'),
    });
  });

  test('grants the orchestrator DescribeTasks/StopTask/TagResource on the workers cluster tasks', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['ecs:DescribeTasks', 'ecs:StopTask', 'ecs:TagResource'],
            Resource: {
              'Fn::Join': Match.arrayWith([
                Match.arrayWith([Match.stringLikeRegexp('task/foerderturm-workers-test/\\*')]),
              ]),
            },
          }),
        ]),
      },
      Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('TaskDefinitionTaskRole') }]),
    });
  });

  describe('run-worker launcher (EcsRunLauncher, Phase 3/5)', () => {
    test('creates a deterministic run-worker execution role trusting ECS tasks', () => {
      const assumedByEcs = {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: 'sts:AssumeRole',
            Principal: { Service: 'ecs-tasks.amazonaws.com' },
          }),
        ]),
      };
      // Only the execution role has a deterministic name; there is no base task role (dagster.yaml
      // omits task_definition.task_role_arn), and the per-worker task roles use generated names.
      template.hasResourceProperties('AWS::IAM::Role', {
        RoleName: 'foerderturm-runworker-exec-test',
        AssumeRolePolicyDocument: assumedByEcs,
        ManagedPolicyArns: Match.arrayWith([
          {
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('AmazonECSTaskExecutionRolePolicy')]),
            ]),
          },
        ]),
      });
    });

    test('creates a retained run-worker log group with 30-day retention', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/ecs/foerderturm-runworker-test',
        RetentionInDays: 30,
      });
    });

    test('injects the RUN_WORKER_* launcher config, with the per-worker RUN_WORKER_PROFILES map', () => {
      // RUN_WORKER_PROFILES is toJsonString of {name: {image, task_role_arn, env}}; because the
      // role ARNs (and Sharadar's staging bucket name) are CFN tokens the value synthesizes to an
      // Fn::Join, so match its presence rather than a literal string.
      const rwEnv = Match.arrayWith([
        { Name: 'RUN_WORKER_CLUSTER', Value: 'foerderturm-workers-test' },
        Match.objectLike({ Name: 'RUN_WORKER_SUBNETS' }),
        Match.objectLike({ Name: 'RUN_WORKER_SECURITY_GROUP' }),
        Match.objectLike({ Name: 'RUN_WORKER_LOG_GROUP' }),
        Match.objectLike({ Name: 'RUN_WORKER_EXECUTION_ROLE_ARN' }),
        Match.objectLike({ Name: 'RUN_WORKER_DB_SECRET_ARN' }),
        Match.objectLike({ Name: 'RUN_WORKER_PROFILES' }),
      ]);
      template.hasResourceProperties('AWS::ECS::TaskDefinition', {
        ContainerDefinitions: Match.arrayWith([
          Match.objectLike({ Name: 'dagster-webserver', Environment: rwEnv }),
          Match.objectLike({ Name: 'dagster-daemon', Environment: rwEnv }),
        ]),
      });
      // The per-worker images travel inside that JSON: assert each image tag appears in the
      // synthesized Fn::Join fragments for the RUN_WORKER_PROFILES value.
      const taskDefs = template.findResources('AWS::ECS::TaskDefinition');
      const containers = Object.values(taskDefs)[0]!.Properties.ContainerDefinitions as {
        Name: string;
        Environment?: { Name: string; Value: unknown }[];
      }[];
      const daemon = containers.find((c) => c.Name === 'dagster-daemon')!;
      const workersVar = (daemon.Environment ?? []).find((e) => e.Name === 'RUN_WORKER_PROFILES');
      const asText = JSON.stringify(workersVar!.Value);
      expect(asText).toContain(TEST_RUNWORKER_IMAGES.massive.imageTag);
      expect(asText).toContain(TEST_RUNWORKER_IMAGES.sharadar.imageTag);
      expect(asText).toContain(TEST_RUNWORKER_IMAGES.example.imageTag);
      expect(asText).toContain('MASSIVE_API_KEY_SSM_PARAMETER');
      // Per-worker env + Fargate size ride in the same JSON.
      expect(asText).toContain('OTEL_PYTHON_DISABLED_INSTRUMENTATIONS');
      expect(asText).toContain('2048'); // sharadar cpu
      expect(asText).toContain('8192'); // sharadar memory
    });

    test('grants the orchestrator RegisterTaskDefinition/DescribeTaskDefinition + RunTask on the run-worker family prefix', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: ['ecs:RegisterTaskDefinition', 'ecs:DescribeTaskDefinition'],
              Resource: '*',
            }),
            Match.objectLike({
              Action: 'ecs:RunTask',
              Resource: {
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp('task-definition/run-worker_\\*')]),
                ]),
              },
              Condition: {
                ArnEquals: {
                  'ecs:cluster': {
                    'Fn::GetAtt': [Match.stringLikeRegexp('WorkersCluster'), 'Arn'],
                  },
                },
              },
            }),
          ]),
        },
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('TaskDefinitionTaskRole') }]),
      });
    });

    test('grants the orchestrator iam:PassRole to the shared exec role + every per-worker role', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'iam:PassRole',
              Resource: Match.arrayWith([
                { 'Fn::GetAtt': [Match.stringLikeRegexp('RunWorkerExecRole'), 'Arn'] },
                // A per-worker task role is passable too (each run gets its worker's own role).
                { 'Fn::GetAtt': [Match.stringLikeRegexp('RunWorkerMassiveTaskRole'), 'Arn'] },
              ]),
              Condition: { StringEquals: { 'iam:PassedToService': 'ecs-tasks.amazonaws.com' } },
            }),
          ]),
        },
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('TaskDefinitionTaskRole') }]),
      });
    });

    test('scopes bronze/staging/Massive-key grants to the per-worker run-worker roles', () => {
      // Bronze S3 Tables write lives on each per-worker role (in-op ingest writes bronze directly);
      // there is no shared/base role carrying it.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({ Action: Match.arrayWith(['s3tables:PutTableData']) }),
          ]),
        },
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('RunWorkerMassiveTaskRole') }]),
      });
      // Massive API-key SSM read is scoped to the MASSIVE worker's own role.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ssm:GetParameter']),
              Resource: {
                'Fn::Join': Match.arrayWith([
                  Match.arrayWith([Match.stringLikeRegexp('foerderturm-test/massive/api-key')]),
                ]),
              },
            }),
          ]),
        },
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('RunWorkerMassiveTaskRole') }]),
      });
      // Sharadar staging-bucket read is scoped to the SHARADAR worker's own role.
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['s3:GetObject*']),
              Resource: Match.arrayWith([
                { 'Fn::GetAtt': [Match.stringLikeRegexp('SharadarStagingBucket'), 'Arn'] },
              ]),
            }),
          ]),
        },
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('RunWorkerSharadarTaskRole') }]),
      });
    });

    test('the Massive worker role does NOT get the Sharadar staging-bucket read (least privilege)', () => {
      // Find the policy attached to the Massive role and assert it has no s3:GetObject on the bucket.
      const policies = template.findResources('AWS::IAM::Policy');
      const massivePolicies = Object.values(policies).filter((p) =>
        JSON.stringify(p.Properties.Roles ?? '').includes('RunWorkerMassiveTaskRole')
      );
      const asText = JSON.stringify(massivePolicies);
      expect(asText).not.toContain('SharadarStagingBucket');
    });

    test('attaches CloudWatchAgentServerPolicy to the per-worker roles', () => {
      // The App Signals sidecar authenticates as the role the run-worker TASK runs under - always a
      // per-worker role (the launcher overlays it). So cwagent belongs on the per-worker roles.
      const roles = template.findResources('AWS::IAM::Role');
      const cwagentRoles = Object.values(roles).filter((r) =>
        JSON.stringify(r.Properties.ManagedPolicyArns ?? '').includes('CloudWatchAgentServerPolicy')
      );
      // massive, sharadar, example - one per worker.
      expect(cwagentRoles).toHaveLength(3);
    });

    test('grants the run-worker execution role read on the Dagster DB secret', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: {
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['secretsmanager:GetSecretValue']),
              Resource: { Ref: Match.stringLikeRegexp('DatabaseSecret') },
            }),
          ]),
        },
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('RunWorkerExecRole') }]),
      });
    });
  });

  test('creates an ECS service with stop-then-start deployment', () => {
    template.hasResourceProperties('AWS::ECS::Service', {
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
    template.hasOutput('DatabaseEndpoint', {});
    template.hasOutput('DatabaseSecretName', {});
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

    test('grants the task role S3 Files client access scoped to the Tailscale state FS', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Effect: 'Allow',
              Action: ['s3files:ClientMount', 's3files:ClientWrite', 's3files:ClientRootAccess'],
              Resource: Match.objectLike({
                'Fn::GetAtt': Match.arrayWith([Match.stringLikeRegexp('TailscaleStateFileSystem')]),
              }),
            }),
          ]),
        }),
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
    expect(stack.database).toBeDefined();
    expect(stack.databaseSecret).toBeDefined();
    expect(stack.tailscaleSecret).toBeDefined();
  });

  test('omits DesiredCount so deploys never fight the lifecycle state machines', () => {
    const services = template.findResources('AWS::ECS::Service');
    expect(Object.keys(services)).toHaveLength(1);
    for (const service of Object.values(services)) {
      expect(service.Properties).not.toHaveProperty('DesiredCount');
    }
  });

  test('subscribes maintenance events to the alert topic', () => {
    template.hasResourceProperties('AWS::RDS::EventSubscription', {
      SourceType: 'db-instance',
      EventCategories: ['maintenance', 'security patching'],
      SnsTopicArn: 'arn:aws:sns:us-east-1:123456789012:PagerDutyAlertsTest',
      Enabled: true,
    });
  });

  describe('lifecycle', () => {
    test('is always created', () => {
      template.resourceCountIs('AWS::StepFunctions::StateMachine', 3);
      template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
    });

    test('adds a start schedule only when one is configured', () => {
      // dev deploys `{}` and comes up only when someone starts it by hand.
      template.resourceCountIs('AWS::Scheduler::Schedule', 1);

      const scheduled = Template.fromStack(
        createTestStack({ lifecycle: { startSchedule: { cron: 'cron(30 10 ? * MON-FRI *)' } } })
      );
      scheduled.resourceCountIs('AWS::Scheduler::Schedule', 2);
      scheduled.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'cron(30 10 ? * MON-FRI *)',
      });
    });
  });
});
