import * as cdk from 'aws-cdk-lib/core';
import { Template, Match } from 'aws-cdk-lib/assertions';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as sns from 'aws-cdk-lib/aws-sns';
import {
  FoerderturmLifecycle,
  type FoerderturmLifecycleConfig,
} from '../../lib/infrastructure/foerderturm-lifecycle.ts';

/** The real stage/prod cron (see environment-stage.ts), in UTC like everything else on this path. */
const DAILY_START = { cron: 'cron(30 10 ? * MON-FRI *)' };

const MACHINES = ['foerderturm-test-start', 'foerderturm-test-stop', 'foerderturm-test-reaper'];

/** The construct's shared transient-failure retrier, as it lands in the synthesized ASL. */
const TRANSIENT_RETRY = {
  ErrorEquals: ['States.TaskFailed'],
  IntervalSeconds: 2,
  MaxAttempts: 3,
  BackoffRate: 2,
  JitterStrategy: 'FULL',
};

/**
 * A stack holding just the lifecycle construct, on top of the minimum real ECS/RDS resources it
 * needs handles to.
 */
function createTestStack(config: FoerderturmLifecycleConfig): cdk.Stack {
  const app = new cdk.App();
  const stack = new cdk.Stack(app, 'TestLifecycle', {
    env: { account: '123456789012', region: 'us-east-1' },
  });

  const vpc = new ec2.Vpc(stack, 'Vpc', {
    natGateways: 0,
    maxAzs: 2,
    subnetConfiguration: [
      { name: 'Public', subnetType: ec2.SubnetType.PUBLIC, cidrMask: 24 },
      { name: 'Database', subnetType: ec2.SubnetType.PRIVATE_ISOLATED, cidrMask: 24 },
    ],
  });
  const cluster = new ecs.Cluster(stack, 'Cluster', { clusterName: 'foerderturm-test', vpc });
  const workersCluster = new ecs.Cluster(stack, 'WorkersCluster', {
    clusterName: 'foerderturm-workers-test',
    vpc,
  });

  const taskDef = new ecs.FargateTaskDefinition(stack, 'TaskDef');
  taskDef.addContainer('app', {
    image: ecs.ContainerImage.fromRegistry('public.ecr.aws/nginx/nginx'),
  });
  const service = new ecs.FargateService(stack, 'Service', {
    serviceName: 'foerderturm-test',
    cluster,
    taskDefinition: taskDef,
  });

  const database = new rds.DatabaseInstance(stack, 'Database', {
    engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_18_3 }),
    vpc,
    vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_ISOLATED },
  });

  new FoerderturmLifecycle(stack, 'Lifecycle', {
    environment: 'test',
    service,
    cluster,
    workersCluster,
    database,
    alertTopic: sns.Topic.fromTopicArn(
      stack,
      'AlertTopic',
      'arn:aws:sns:us-east-1:123456789012:PagerDutyAlertsTest'
    ),
    config,
  });

  return stack;
}

// TODO: Need to add a proper way to test the start, stop and reaper machines.
// Stripping out ASL and checking the statements doesn't make too much sense.
// Need to do testing with inputs and outputs.

/**
 * A parsed Amazon States Language document. ASL is arbitrary JSON and these tests index into it by
 * state name, so `any` is the honest type; it is confined to this alias.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- see above
type AslDoc = Record<string, any>;

/** Parse a state machine's synthesized DefinitionString back into ASL. */
function aslFor(template: Template, machineName: string): AslDoc {
  const machines = template.findResources('AWS::StepFunctions::StateMachine');
  const machine = Object.values(machines).find(
    (m) => m.Properties?.StateMachineName === machineName
  );
  if (!machine) throw new Error(`no state machine named ${machineName}`);
  const definition = machine.Properties.DefinitionString;
  // CFN tokens inside the definition come through as Fn::Join fragments; replace the non-string
  // parts with a placeholder so the surrounding ASL structure stays parseable.
  const parts: unknown[] = definition['Fn::Join']?.[1] ?? [definition];
  return JSON.parse(parts.map((p) => (typeof p === 'string' ? p : 'TOKEN')).join('')) as AslDoc;
}

describe('FoerderturmLifecycle', () => {
  let template: Template;

  beforeEach(() => {
    template = Template.fromStack(createTestStack({ startSchedule: DAILY_START }));
  });

  test('creates the three lifecycle state machines', () => {
    template.resourceCountIs('AWS::StepFunctions::StateMachine', 3);
    for (const name of ['foerderturm-test-start', 'foerderturm-test-stop']) {
      template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
        StateMachineName: name,
        StateMachineType: Match.absent(),
        TracingConfiguration: { Enabled: true },
      });
    }
    template.hasResourceProperties('AWS::StepFunctions::StateMachine', {
      StateMachineName: 'foerderturm-test-reaper',
      StateMachineType: 'EXPRESS',
    });
  });

  test('logs every execution, since the Express reaper keeps no console history', () => {
    template.hasResourceProperties('AWS::Logs::LogGroup', {
      LogGroupName: '/aws/vendedlogs/states/foerderturm-test-lifecycle',
      RetentionInDays: 30,
    });
    for (const machine of Object.values(
      template.findResources('AWS::StepFunctions::StateMachine')
    )) {
      expect(machine.Properties.LoggingConfiguration.Level).toBe('ALL');
    }
  });

  describe('schedules', () => {
    test('starts daily, always in UTC and starts reaper', () => {
      // UTC is load-bearing: RDS accepts preferredBackupWindow only in UTC
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: 'foerderturm-test-daily-start',
        ScheduleExpression: 'cron(30 10 ? * MON-FRI *)',
        ScheduleExpressionTimezone: 'Etc/UTC',
      });
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: 'foerderturm-test-reaper',
        ScheduleExpression: 'rate(5 minutes)',
      });
    });

    test('omits the daily start when none is configured (manual-only, e.g. dev)', () => {
      const manualOnly = Template.fromStack(createTestStack({}));
      manualOnly.resourceCountIs('AWS::Scheduler::Schedule', 1);
      manualOnly.hasResourceProperties('AWS::Scheduler::Schedule', {
        Name: 'foerderturm-test-reaper',
      });
      // Still fully operable by hand.
      manualOnly.resourceCountIs('AWS::StepFunctions::StateMachine', 3);
    });
  });

  test('alarms once per machine, named so the page says which one broke', () => {
    template.resourceCountIs('AWS::CloudWatch::Alarm', 3);
    for (const key of ['start', 'stop', 'reaper']) {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: `foerderturm-test-lifecycle-${key}-failed`,
        Threshold: 1,
        EvaluationPeriods: 1,
        ComparisonOperator: 'GreaterThanOrEqualToThreshold',
        TreatMissingData: 'notBreaching',
        AlarmActions: ['arn:aws:sns:us-east-1:123456789012:PagerDutyAlertsTest'],
        Metrics: Match.arrayWith([
          Match.objectLike({ Expression: 'SUM([failed,timedOut])' }),
          Match.objectLike({ MetricStat: Match.objectLike({ Period: 60 }) }),
        ]),
      });
    }
  });

  describe('every AWS call', () => {
    /** Every task across all three machines, labelled so a failure names the offender. */
    const everyTask = (): Array<[string, AslDoc]> =>
      MACHINES.flatMap((machine) =>
        Object.entries(aslFor(template, machine).States as Record<string, AslDoc>)
          .filter(([, state]) => state.Type === 'Task')
          .map(([name, state]) => [`${machine}/${name}`, state] as [string, AslDoc])
      );

    test('retries transient failures', () => {
      // Step Functions declares no retrier unless you write one. The wildcard is always last:
      // retriers are scanned in order, and anything more specific has to get its match first.
      for (const [label, state] of everyTask()) {
        expect(state.Retry?.at(-1), label).toEqual(TRANSIENT_RETRY);
      }
    });

    test('stamps every lease write with the execution that made it', () => {
      const writes = everyTask().filter(([, s]) =>
        (s.Resource as string | undefined)?.includes('dynamodb:updateItem')
      );
      expect(writes.length).toBeGreaterThan(0);
      for (const [label, state] of writes) {
        expect(state.Arguments.UpdateExpression, label).toContain('lastExecution = :execution');
        expect(state.Arguments.ExpressionAttributeValues[':execution'], label).toEqual({
          S: '{% $states.context.Execution.Id %}',
        });
      }
    });

    test('reads the lease strongly consistent, with every attribute defaulted', () => {
      // stop machine never reads the lease
      for (const [machine, id] of [
        ['foerderturm-test-start', 'StartReadLease'],
        ['foerderturm-test-reaper', 'ReaperReadLease'],
      ]) {
        const state = aslFor(template, machine!).States[id!];
        expect(state.Resource, id).toContain('aws-sdk:dynamodb:getItem');
        expect(state.Arguments.ConsistentRead, id).toBe(true);
        expect(Object.keys(state.Assign), id).toEqual(
          expect.arrayContaining(['leaseState', 'leaseHoldUntil', 'leaseStoppingSince'])
        );
      }
    });
  });

  describe('IAM', () => {
    test('scopes every mutating call to a single resource', () => {
      const statements = Object.values(template.findResources('AWS::IAM::Policy')).flatMap(
        (p) => p.Properties.PolicyDocument.Statement as { Action: unknown; Resource: unknown }[]
      );
      const actionsOf = (s: { Action: unknown }): string[] =>
        Array.isArray(s.Action) ? (s.Action as string[]) : [s.Action as string];

      for (const action of [
        'ecs:updateService',
        'rds:startDBInstance',
        'rds:stopDBInstance',
        'dynamodb:updateItem',
      ]) {
        const matching = statements.filter((s) => actionsOf(s).includes(action));
        expect(matching.length, action).toBeGreaterThan(0);
        for (const statement of matching) {
          expect(statement.Resource, action).not.toBe('*');
          expect(statement.Resource, action).not.toContainEqual('*');
        }
      }
    });

    test('lets only the reaper start the stop machine', () => {
      const starters = Object.values(template.findResources('AWS::IAM::Policy')).filter((p) =>
        (p.Properties.PolicyDocument.Statement as { Action: unknown }[]).some((s) =>
          (Array.isArray(s.Action) ? s.Action : [s.Action]).includes('states:StartExecution')
        )
      );
      // The reaper's role plus the two EventBridge Scheduler roles (start + reaper schedules).
      expect(starters).toHaveLength(3);
    });
  });
});
