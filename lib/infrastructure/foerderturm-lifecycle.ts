import * as cdk from 'aws-cdk-lib/core';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as cloudwatchActions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as scheduler from 'aws-cdk-lib/aws-scheduler';
import * as schedulerTargets from 'aws-cdk-lib/aws-scheduler-targets';
import * as sns from 'aws-cdk-lib/aws-sns';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

// TODO: Is this whole thing a good idea? We can also have Dagster kick off it's own shutdown.

const UNSET = 'none';
const LEASE_PK = 'lease';
const EPOCH = '1970-01-01T00:00:00.000Z';

// Read a DynamoDB attribute out of a `getItem` result, falling back when it (or the whole item) is absent.
const attr = (path: string, fallback: string): string =>
  `{% $exists(${path}) ? ${path} : '${fallback}' %}`;

// Milliseconds between two ISO-8601 instants, as a JSONata fragment.
const minutesSince = (isoExpr: string): string =>
  `($toMillis($now()) - $toMillis(${isoExpr})) / 60000`;

// Error name DynamoDB reports when a `ConditionExpression` evaluates false, naming from AWS SDK for Java 2.x.
const CONDITION_FAILED = 'DynamoDb.ConditionalCheckFailedException';

// Used by express functions to avoid duplicates
const EXECUTION_EXISTS = 'StepFunctions.ExecutionAlreadyExistsException';

// Retry everything except timeout, generally we use REQUEST_RESPONSE which means any transient errors are
// are failures to make the initial API call.
const TRANSIENT_RETRY: sfn.RetryProps = {
  errors: [sfn.Errors.TASKS_FAILED],
  interval: cdk.Duration.seconds(2),
  maxAttempts: 3,
  backoffRate: 2,
  jitterStrategy: sfn.JitterType.FULL,
};

// Per-environment tuning for the foerderturm lifecycle.
export interface FoerderturmLifecycleConfig {
  /**
   * Daily automatic start. Omit for manual-only environments (dev)
   * @example { cron: 'cron(30 5 ? * MON-FRI *)' }
   */
  readonly startSchedule?: {
    /**
     * EventBridge Scheduler cron expression, always evaluated in **UTC**.
     */
    readonly cron: string;
  };
  /**
   * Minimum session length in minutes, this is to allow for RDS and the orchestrator to start.
   * @example 60
   * @default 60
   */
  readonly minSessionMinutes?: number;
  /**
   * When workers are running how many minutes to push back the shutdown. This is to allow the orchestrator to start
   * a new job without getting shut down because it took 5 minutes to do so.
   * @example 15
   * @default 15
   */
  readonly idleGraceMinutes?: number;
  /**
   * Protection window a start gets when the caller passes no `holdMinutes` - i.e. a human running
   * `foerderturm-start` to work in the environment. The daily schedule passes `0` explicitly and
   * relies on {@link minSessionMinutes} instead.
   * @example 120
   * @default 120
   */
  readonly manualHoldMinutes?: number;
  /**
   * How often the reaper runs and evaluates.
   * @example 5
   * @default 5
   */
  readonly reaperIntervalMinutes?: number;
  /**
   * Maximum amount of minutes a stop can be in progress, if this is exceeded somehting is wrong - e.g. RDS not shutting down.
   * @example 120
   * @default 120
   */
  readonly stopTimeoutMinutes?: number;
}

export interface FoerderturmLifecycleProps {
  /**
   * Environment name suffixed onto every resource name (state machines, lease table, schedules).
   * @example 'stage'
   */
  readonly environment: string;
  /**
   * The orchestrator service that gets scaled between 0 and 1 (`desiredCount`)
   */
  readonly service: ecs.IFargateService;
  /**
   * Cluster hosting the orchestrator task, used to confirm the task has drained before RDS is stopped.
   */
  readonly cluster: ecs.ICluster;
  /**
   * Cluster the Dagster run workers execute in. Task count here is the idle signal - 0 means no work is being done.
   */
  readonly workersCluster: ecs.ICluster;
  /** RDS Postgres instance started before, and stopped after, the orchestrator. */
  readonly database: rds.IDatabaseInstance;
  /**
   * Topic alarmed onto when a lifecycle state machine fails, times out, or is aborted.
   * @example snsPagerDuty.topic
   */
  readonly alertTopic: sns.ITopic;
  /** Per-environment tuning; pass `{}` for the defaults. */
  readonly config: FoerderturmLifecycleConfig;
}

/**
 * Starts and stops the foerderturm orchestrator and its RDS Postgres, so neither runs around the
 * clock.
 *
 * Three state machines coordinate through one DynamoDB **lease** item.
 *
 * - **start** starts RDS, then scales the service to 1, waits for a running task then
 *   writes the lease as `up`. An EventBridge Scheduler cron or an operator starts this machine.
 * - **reaper** (runs every few minutes) decides. It reads RDS, ECS and the lease, and delegates to
 *   the stop machine when every check says idle - and again on every later tick while a teardown is
 *   still in progress.
 * - **stop** marks the lease `stopping`, scales the service to 0, and stops RDS if *both* clusters
 *   have already drained. Run workers outlive the daemon and still write to Postgres, so RDS is
 *   never stopped under them.
 *
 * **`holdUntil`: two things write it: the start machine stamps `minSessionMinutes` once the task is running, and
 * every reaper tick that sees a non-empty workers cluster pushes it to `now + idleGraceMinutes`.
 * If hold expires and no workers are running stop machine is started.
 *
 * Stop machine (unlike start machine) is short lived and is retriggered by the reaper. It simply shuts
 * down running resources one by one until they're dead. If it takes too long (stopTimeoutMinutes) reaper
 * raises an alarm. Start machine on the other hand is self contained and tries to bring everything up for
 * 30 minutes.
 *
 * **Re-check this whenever either schedule changes.** `minSessionMinutes` alone **must exceed the
 * gap from the start cron to both the first Dagster tick of the day and the close of the RDS backup
 * window.** It is the entire floor on a session: on a day where the workers cluster is empty at
 * every tick, the hold is never extended and the environment is reaped the minute it expires.
 *
 *     cron 10:30 UTC -> 11:00 UTC tick             =   30 min gap
 *     cron 10:30 UTC -> 11:20 UTC backup close     =   50 min gap
 *     minSessionMinutes 60                         =   60 min protection
 *
 * Note: keep in mind the maintenance window which RDS uses to upgrade the DB etc, see foerderturm-stack.ts
 * for details. If you want to manually do maintenance updates place the cron to start _outside_ the
 * maintenance window, however if maintenance tasks are not done for a long time AWS will force them on the next startup.
 * To avoid this foerderturm stack creates a DatabaseMaintenanceEvents subscriptino and routes it to the same topic.
 * On the contrary the backup window should be within your cron window since it causes no downtime.
 *
 * The two windows are hardcoded in foerderturm-stack.ts
 */
export class FoerderturmLifecycle extends Construct {
  /** Single-item table holding the lease. CDK owns the table; only the machines write the item. */
  public readonly leaseTable: dynamodb.ITableV2;
  /** Starts RDS, then scales the orchestrator to one task. */
  public readonly startStateMachine: sfn.IStateMachine;
  /** Drains the orchestrator and run workers, then stops RDS. Re-checks the lease first. */
  public readonly stopStateMachine: sfn.IStateMachine;
  /** Evaluates idleness on a schedule and delegates to {@link stopStateMachine}. */
  public readonly reaperStateMachine: sfn.IStateMachine;

  private readonly environment: string;
  private readonly orchestratorServiceName: string;
  private readonly orchestratorClusterName: string;
  private readonly orchestratorServiceArn: string;
  private readonly workersClusterName: string;
  private readonly dbIdentifier: string;
  private readonly dbArn: string;

  constructor(scope: Construct, id: string, props: FoerderturmLifecycleProps) {
    super(scope, id);

    const environment = props.environment;
    const minSessionMinutes = props.config.minSessionMinutes ?? 60;
    const idleGraceMinutes = props.config.idleGraceMinutes ?? 15;
    const manualHoldMinutes = props.config.manualHoldMinutes ?? 120;
    const reaperIntervalMinutes = props.config.reaperIntervalMinutes ?? 5;
    const stopTimeoutMinutes = props.config.stopTimeoutMinutes ?? 120;

    this.environment = environment;
    this.orchestratorServiceName = props.service.serviceName;
    this.orchestratorServiceArn = props.service.serviceArn;
    this.orchestratorClusterName = props.cluster.clusterName;
    this.workersClusterName = props.workersCluster.clusterName;
    this.dbIdentifier = props.database.instanceIdentifier;
    this.dbArn = props.database.instanceArn;

    // NOTE: emits two warnings here - known CDK bug, https://github.com/aws/aws-cdk/issues/37221
    this.leaseTable = new dynamodb.TableV2(this, 'LeaseTable', {
      tableName: `foerderturm-${environment}-lifecycle`,
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
    });

    // `/aws/vendedlogs/` is the prefix Step Functions' managed log delivery expects.
    const logGroup = new logs.LogGroup(this, 'LogGroup', {
      logGroupName: `/aws/vendedlogs/states/foerderturm-${environment}-lifecycle`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });
    const logs_: sfn.LogOptions = {
      destination: logGroup,
      level: sfn.LogLevel.ALL,
      includeExecutionData: true,
    };

    // Stop is built first: the reaper needs its ARN to delegate to it.
    this.stopStateMachine = this.buildStopMachine(logs_);
    this.startStateMachine = this.buildStartMachine(logs_, manualHoldMinutes, minSessionMinutes);
    this.reaperStateMachine = this.buildReaperMachine(
      logs_,
      idleGraceMinutes,
      stopTimeoutMinutes,
      this.stopStateMachine
    );

    // ---- Schedules for start running on provided cron and reaper every 5 minutes ----
    if (props.config.startSchedule) {
      new scheduler.Schedule(this, 'DailyStart', {
        scheduleName: `foerderturm-${environment}-daily-start`,
        description: `Start the foerderturm-${environment} orchestrator + RDS for the day`,
        schedule: scheduler.ScheduleExpression.expression(
          props.config.startSchedule.cron,
          cdk.TimeZone.ETC_UTC
        ),
        target: new schedulerTargets.StepFunctionsStartExecution(this.startStateMachine, {
          // No extra hold minutes like a manual start would need (set by default in start machine)
          input: scheduler.ScheduleTargetInput.fromObject({ holdMinutes: 0 }),
        }),
      });
    }

    new scheduler.Schedule(this, 'Reaper', {
      scheduleName: `foerderturm-${environment}-reaper`,
      description: `Evaluate whether foerderturm-${environment} can be shut down`,
      schedule: scheduler.ScheduleExpression.rate(cdk.Duration.minutes(reaperIntervalMinutes)),
      target: new schedulerTargets.StepFunctionsStartExecution(this.reaperStateMachine, {
        input: scheduler.ScheduleTargetInput.fromObject({}),
      }),
    });

    // ---- Alarms on failures and timeouts ----
    const period = cdk.Duration.minutes(1);
    const machines: ReadonlyArray<{
      readonly key: string;
      readonly machine: sfn.IStateMachine;
    }> = [
      {
        key: 'start',
        machine: this.startStateMachine,
      },
      {
        key: 'stop',
        machine: this.stopStateMachine,
      },
      {
        key: 'reaper',
        machine: this.reaperStateMachine,
      },
    ];

    for (const { key, machine } of machines) {
      new cloudwatch.Alarm(this, `${key}FailureAlarm`, {
        alarmName: `foerderturm-${environment}-lifecycle-${key}-failed`,
        alarmDescription:
          `A foerderturm-${environment} lifecycle ${key} execution failed or timed out: ` +
          `Check the execution history, then the lease item. See runbook for details.`,
        metric: new cloudwatch.MathExpression({
          expression: 'SUM([failed,timedOut])',
          usingMetrics: {
            failed: machine.metricFailed({ statistic: 'Sum', period }),
            timedOut: machine.metricTimedOut({ statistic: 'Sum', period }),
          },
          period,
          label: `foerderturm-${environment} ${key} failures`,
        }),
        threshold: 1,
        evaluationPeriods: 1,
        comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
      }).addAlarmAction(new cloudwatchActions.SnsAction(props.alertTopic));
    }
    this.addNagSuppressions();
  }

  // Shared state builders

  /**
   * `CallAwsService` with this construct's standard retry policy attached.
   *
   * Pass specificRetries to modify the retry behavior:
   * specificRetries: [{ errors: ['DynamoDb.ConditionalCheckFailedException'], maxAttempts: 0 }]
   */
  private callAws(
    id: string,
    props: tasks.CallAwsServiceJsonataProps,
    specificRetries: ReadonlyArray<sfn.RetryProps> = []
  ): tasks.CallAwsService {
    const state = tasks.CallAwsService.jsonata(this, id, props);
    // Need to declare the specific retries before the TRANSIENT_RETRY since otherwise it
    // would swallow every match.
    for (const retry of [...specificRetries, TRANSIENT_RETRY]) {
      state.addRetry(retry);
    }
    return state;
  }

  /**
   * `dynamodb:getItem` on the lease - strongly consistent
   *
   *  Assigns:
   *   - `leaseState` - up, down, starting etc.
   *   - `leaseHoldUntil` - timestamp until when the lease is set to hold
   *   - `leaseStoppingSince` - when the teardown now in progress first claimed the lease
   *   - anything passed in `extraAssign`
   */
  private readLease(id: string, extraAssign: Record<string, string> = {}): tasks.CallAwsService {
    return this.callAws(id, {
      service: 'dynamodb',
      action: 'getItem',
      parameters: {
        TableName: this.leaseTable.tableName,
        Key: { pk: { S: LEASE_PK } },
        ConsistentRead: true,
      },
      iamResources: [this.leaseTable.tableArn],
      assign: {
        leaseState: attr('$states.result.Item.leaseState.S', 'down'),
        leaseHoldUntil: attr('$states.result.Item.holdUntil.S', EPOCH),
        leaseStoppingSince: attr('$states.result.Item.stoppingSince.S', UNSET),
        ...extraAssign,
      },
    });
  }

  /**
   * `dynamodb:updateItem` on the lease - strongly consistent
   *
   * Takes the SET and REMOVE clauses separately rather than a whole expression so `lastExecution`
   * can be appended to every write (step functions execution arn).
   */
  private writeLease(
    id: string,
    update: {
      /** SET clause without the keyword, e.g. `leaseState = :up`. */
      readonly set: string;
      /** REMOVE clause without the keyword, e.g. `holdUntil, stoppingSince`. */
      readonly remove?: string;
      /** Condition to check before writing lease. */
      readonly condition: string;
      /**
       * DDB expects expression attribute values for everything used in your condition, set and remove clause.
       * @see https://docs.aws.amazon.com/amazondynamodb/latest/developerguide/Expressions.ExpressionAttributeValues.html
       */
      readonly values: Record<string, unknown>;
    }
  ): tasks.CallAwsService {
    const expression =
      `SET ${update.set}, lastExecution = :execution` +
      (update.remove ? ` REMOVE ${update.remove}` : '');

    return this.callAws(
      id,
      {
        service: 'dynamodb',
        action: 'updateItem',
        parameters: {
          TableName: this.leaseTable.tableName,
          Key: { pk: { S: LEASE_PK } },
          UpdateExpression: expression,
          ...(update.condition ? { ConditionExpression: update.condition } : {}),
          ExpressionAttributeValues: {
            ...(update.values ?? {}),
            ':execution': { S: '{% $states.context.Execution.Id %}' },
          },
        },
        iamResources: [this.leaseTable.tableArn],
      },
      // If the condition fails it means that the lease was modified and we're no longer up to date of whats going on
      update.condition ? [{ errors: [CONDITION_FAILED], maxAttempts: 0 }] : []
    );
  }

  /**
   * `rds:describeDBInstances`
   *
   * Assigns `dbStatus` - status of RDS
   */
  private describeDb(id: string): tasks.CallAwsService {
    return this.callAws(id, {
      service: 'rds',
      action: 'describeDBInstances',
      parameters: { DbInstanceIdentifier: this.dbIdentifier },
      iamResources: ['*'],
      assign: { dbStatus: '{% $states.result.DbInstances[0].DbInstanceStatus %}' },
    });
  }

  /**
   * `ecs:describeServices`
   *
   * Assigns:
   *  - desiredCount - current desired count
   *  - runningCount - current running count
   */
  private describeService(id: string): tasks.CallAwsService {
    return this.callAws(id, {
      service: 'ecs',
      action: 'describeServices',
      parameters: {
        Cluster: this.orchestratorClusterName,
        Services: [this.orchestratorServiceName],
      },
      iamResources: [this.orchestratorServiceArn],
      assign: {
        desiredCount: '{% $states.result.Services[0].DesiredCount %}',
        runningCount: '{% $states.result.Services[0].RunningCount %}',
      },
    });
  }

  /** `ecs:updateService` to the given desired count. */
  private scaleService(id: string, desiredCount: number): tasks.CallAwsService {
    return this.callAws(id, {
      service: 'ecs',
      action: 'updateService',
      parameters: {
        Cluster: this.orchestratorClusterName,
        Service: this.orchestratorServiceName,
        DesiredCount: desiredCount,
      },
      iamResources: [this.orchestratorServiceArn],
    });
  }

  /**
   * `ecs:ListTasks` on one cluster, assigning the task count to `variable`.
   *
   * Checks for not only currently running workers but also workers currently starting up.
   */
  private countTasks(id: string, clusterName: string, variable: string): tasks.CallAwsService {
    return this.callAws(id, {
      service: 'ecs',
      action: 'listTasks',
      parameters: { Cluster: clusterName, DesiredStatus: 'RUNNING' },
      iamResources: ['*'],
      assign: { [variable]: '{% $count($states.result.TaskArns) %}' },
    });
  }

  // -------------------------------------------------------------------------
  // start
  // -------------------------------------------------------------------------

  private buildStartMachine(
    logOptions: sfn.LogOptions,
    manualHoldMinutes: number,
    minSessionMinutes: number
  ): sfn.StateMachine {
    // Execution input: { holdMinutes?: number }, defaulting to the manual window.
    // The daily schedule passes `holdMinutes: 0` which means only `minSessionMinutes` will count.
    const readLease = this.readLease('StartReadLease', {
      holdMinutes: `{% $exists($states.input.holdMinutes) ? $states.input.holdMinutes : ${manualHoldMinutes} %}`,
    });

    // Never shorten an existing hold
    const computeHold = sfn.Pass.jsonata(this, 'StartComputeHold', {
      assign: {
        holdUntil:
          '{% ($requested := $fromMillis($toMillis($now()) + $holdMinutes * 60000); ' +
          '$requested > $leaseHoldUntil ? $requested : $leaseHoldUntil) %}',
      },
    });

    // Refuse to start on top of a teardown.
    const startBlocked = sfn.Fail.jsonata(this, 'StartBlockedByStop', {
      error: 'LeaseStopping',
      cause:
        'A stop is draining the environment (lease = stopping). Wait for it to finish, then start again.',
    });
    const markStarting = this.writeLease('StartMarkStarting', {
      set: `leaseState = :starting, holdUntil = :hold`,
      condition: `attribute_not_exists(leaseState) OR leaseState <> :stopping`,
      values: {
        ':starting': { S: 'starting' },
        ':hold': { S: '{% $holdUntil %}' },
        ':stopping': { S: 'stopping' },
      },
    });
    markStarting.addCatch(startBlocked, { errors: [CONDITION_FAILED] });

    const describeDb = this.describeDb('StartDescribeDb');
    const waitForDb = sfn.Wait.jsonata(this, 'StartWaitForDb', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(30)),
    });
    const startDb = this.callAws('StartDb', {
      service: 'rds',
      action: 'startDBInstance',
      parameters: { DbInstanceIdentifier: this.dbIdentifier },
      iamResources: [this.dbArn],
    });
    // This step only runs when DB is "stopped", if our StartDb call fails keep retrying until timeout (alarm)
    startDb.addCatch(waitForDb, { errors: ['Rds.InvalidDbInstanceStateException'] });

    const scaleUp = this.scaleService('StartScaleUp', 1);
    const describeService = this.describeService('StartDescribeService');
    const waitForService = sfn.Wait.jsonata(this, 'StartWaitForService', {
      time: sfn.WaitTime.duration(cdk.Duration.seconds(20)),
    });

    const startLostRace = sfn.Fail.jsonata(this, 'StartLostRace', {
      error: 'LeaseNoLongerStarting',
      cause:
        'Something took the lease off `starting` while this start was booting. Check the lease, then start again.',
    });

    // Conditional so this cannot stamp `up` over a lease that is no longer the one this execution claimed.
    const markUp = this.writeLease('StartMarkUp', {
      set: `leaseState = :up, holdUntil = :hold`,
      condition: 'leaseState = :starting',
      values: {
        ':up': { S: 'up' },
        ':starting': { S: 'starting' },
        ':hold': {
          S:
            `{% ($boot := $fromMillis($toMillis($now()) + ${minSessionMinutes} * 60000); ` +
            '$boot > $holdUntil ? $boot : $holdUntil) %}',
        },
      },
    });
    markUp.addCatch(startLostRace, { errors: [CONDITION_FAILED] });

    const dbReady = sfn.Choice.jsonata(this, 'StartIsDbReady')
      .when(sfn.Condition.jsonata("{% $dbStatus = 'available' %}"), scaleUp)
      .when(sfn.Condition.jsonata("{% $dbStatus = 'stopped' %}"), startDb)
      // starting / backing-up / modifying / configuring-* - just keep waiting.
      .otherwise(waitForDb);

    const serviceReady = sfn.Choice.jsonata(this, 'StartIsServiceReady')
      .when(sfn.Condition.jsonata('{% $runningCount >= 1 %}'), markUp)
      .otherwise(waitForService);

    describeDb.next(dbReady);
    startDb.next(waitForDb);
    waitForDb.next(describeDb);
    scaleUp.next(describeService);
    waitForService.next(describeService);
    describeService.next(serviceReady);
    markUp.next(sfn.Succeed.jsonata(this, 'StartDone'));

    const definition = readLease.next(computeHold).next(markStarting).next(describeDb);

    return new sfn.StateMachine(this, 'StartMachine', {
      stateMachineName: `foerderturm-${this.environment}-start`,
      comment: 'Start the foerderturm orchestrator: RDS first, then scale the service to one task',
      queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(30),
      tracingEnabled: true,
      logs: logOptions,
    });
  }

  // -------------------------------------------------------------------------
  // stop
  // -------------------------------------------------------------------------

  private buildStopMachine(logOptions: sfn.LogOptions): sfn.StateMachine {
    const aborted = sfn.Succeed.jsonata(this, 'StopAborted', {
      comment: 'A start holds the lease, or another execution already finished this teardown',
    });

    const scaleDown = this.scaleService('StopScaleDown', 0);

    const countWorkerTasks = this.countTasks(
      'StopCountWorkerTasks',
      this.workersClusterName,
      'workerTasks'
    );
    const countOrchestratorTasks = this.countTasks(
      'StopCountOrchestratorTasks',
      this.orchestratorClusterName,
      'orchestratorTasks'
    );

    // Leave the state on "stopping" on purpose so the reaper can pick it up
    const draining = sfn.Succeed.jsonata(this, 'StopDraining', {
      comment:
        'Orchestrator scaled to zero; tasks are still draining, so RDS was left up. The reaper ' +
        'resumes this on its next tick.',
    });
    const dbBusy = sfn.Succeed.jsonata(this, 'StopDbBusy', {
      comment:
        'RDS would not accept StopDBInstance yet - a backup or maintenance window holds it. The ' +
        'reaper resumes this on its next tick.',
    });

    const describeDb = this.describeDb('StopDescribeDb');
    const stopDb = this.callAws('StopDb', {
      service: 'rds',
      action: 'stopDBInstance',
      parameters: { DbInstanceIdentifier: this.dbIdentifier },
      iamResources: [this.dbArn],
    });
    // DB might be unstoppable, e.g. maintenance period, backup etc., in that case let reaper start the new try
    stopDb.addCatch(dbBusy, { errors: ['Rds.InvalidDbInstanceStateException'] });

    const markStopping = this.writeLease('StopMarkStopping', {
      set: 'leaseState = :stopping, stoppingSince = if_not_exists(stoppingSince, :now)',
      // Fail if suddenly start machine claimed the lease.
      condition: 'attribute_not_exists(leaseState) OR leaseState <> :starting',
      values: {
        ':stopping': { S: 'stopping' },
        ':starting': { S: 'starting' },
        ':now': { S: '{% $now() %}' },
      },
    });
    markStopping.addCatch(aborted, { errors: [CONDITION_FAILED] });

    const markDown = this.writeLease('StopMarkDown', {
      set: 'leaseState = :down',
      remove: 'holdUntil, stoppingSince',
      condition: 'leaseState = :stopping',
      values: { ':down': { S: 'down' }, ':stopping': { S: 'stopping' } },
    });
    markDown.addCatch(aborted, { errors: [CONDITION_FAILED] });

    const drained = sfn.Choice.jsonata(this, 'StopIsDrained')
      .when(sfn.Condition.jsonata('{% $workerTasks = 0 and $orchestratorTasks = 0 %}'), describeDb)
      .otherwise(draining);

    const dbNeedsStopping = sfn.Choice.jsonata(this, 'StopIsDbRunning')
      .when(
        sfn.Condition.jsonata("{% $dbStatus = 'stopped' or $dbStatus = 'stopping' %}"),
        markDown
      )
      // 'available' or in maintenance etc.
      .otherwise(stopDb);

    markStopping.next(scaleDown);
    scaleDown.next(countWorkerTasks);
    countWorkerTasks.next(countOrchestratorTasks);
    countOrchestratorTasks.next(drained);
    describeDb.next(dbNeedsStopping);
    stopDb.next(markDown);
    markDown.next(sfn.Succeed.jsonata(this, 'StopDone'));

    const definition = markStopping;

    return new sfn.StateMachine(this, 'StopMachine', {
      stateMachineName: `foerderturm-${this.environment}-stop`,
      comment: 'Scale the foerderturm orchestrator to zero and stop RDS once both clusters drain',
      queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      timeout: cdk.Duration.minutes(10),
      tracingEnabled: true,
      logs: logOptions,
    });
  }

  // -------------------------------------------------------------------------
  // reaper
  // -------------------------------------------------------------------------

  private buildReaperMachine(
    logOptions: sfn.LogOptions,
    idleGraceMinutes: number,
    stopTimeoutMinutes: number,
    stopMachine: sfn.IStateMachine
  ): sfn.StateMachine {
    const describeService = this.describeService('ReaperDescribeService');
    const describeDb = this.describeDb('ReaperDescribeDb');
    const readLease = this.readLease('ReaperReadLease');

    const nothingToDo = sfn.Succeed.jsonata(this, 'ReaperNothingToDo', {
      comment: 'Everything is already down, or a start is in flight',
    });
    const stillBusy = sfn.Succeed.jsonata(this, 'ReaperStillBusy', {
      comment: 'A hold is active in the lease, reaping not required',
    });

    // Catch express function duplicate executions
    const alreadyRunning = sfn.Succeed.jsonata(this, 'ReaperStopAlreadyStarted', {
      comment: 'This tick had already started its stop execution - the retry was a duplicate',
    });

    const triggerStop = tasks.StepFunctionsStartExecution.jsonata(this, 'ReaperTriggerStop', {
      stateMachine: stopMachine,
      integrationPattern: sfn.IntegrationPattern.REQUEST_RESPONSE,
      input: sfn.TaskInput.fromObject({}),
      // Truncated because execution names are capped at 80 chars
      name: `{% $substring($states.context.Execution.Name, 0, 80) %}`,
    });
    // Duplicate express execution
    triggerStop.addRetry({ errors: [EXECUTION_EXISTS], maxAttempts: 0 });
    triggerStop.addRetry(TRANSIENT_RETRY);
    triggerStop.addCatch(alreadyRunning, { errors: [EXECUTION_EXISTS] });

    const countWorkerTasks = this.countTasks(
      'ReaperCountWorkerTasks',
      this.workersClusterName,
      'workerTasks'
    );

    // We only get here with an expired hold, see ReaperDecide, ReaperNothingToDo
    // condition if something updated the lease
    const extendHold = this.writeLease('ReaperExtendHold', {
      set: 'holdUntil = :hold',
      condition: 'attribute_not_exists(holdUntil) OR holdUntil < :hold',
      values: {
        ':hold': {
          S: `{% $fromMillis($toMillis($now()) + ${idleGraceMinutes} * 60000) %}`,
        },
      },
    });
    extendHold.addCatch(stillBusy, { errors: [CONDITION_FAILED] });
    extendHold.next(stillBusy);

    // We get here when a stop was initiated but took too long and we force a timeout.
    const stopStalled = sfn.Fail.jsonata(this, 'ReaperStopStalled', {
      error: 'StopStalled',
      cause: `The lease has read 'stopping' for over ${stopTimeoutMinutes} minutes and timed out, inspect stop machine and check the runbook.`,
    });
    const stopInFlight = sfn.Choice.jsonata(this, 'ReaperIsStopStalled')
      .when(
        sfn.Condition.jsonata(
          `{% $leaseStoppingSince != '${UNSET}' and ` +
            `${minutesSince('$leaseStoppingSince')} >= ${stopTimeoutMinutes} %}`
        ),
        stopStalled
      )
      // It shouldn't be UNSET but if it is (manual edit) then just resume stopping.
      .otherwise(triggerStop);

    // This runs after the lease is updated so we act on up to date information
    const decide = sfn.Choice.jsonata(this, 'ReaperDecide')
      // A start machine is mid-flight; leave it alone.
      .when(sfn.Condition.jsonata("{% $leaseState = 'starting' %}"), nothingToDo)
      .when(sfn.Condition.jsonata("{% $leaseState = 'stopping' %}"), stopInFlight)
      // Nothing is running so nothing to do, if DB is starting (e.g. forced start by AWS) it will be reaped
      // later
      .when(
        sfn.Condition.jsonata(
          "{% $desiredCount = 0 and ($dbStatus = 'stopped' or $dbStatus = 'stopping' or $dbStatus = 'starting') %}"
        ),
        nothingToDo
      )
      // Hold is active, do nothing
      .when(
        sfn.Condition.jsonata('{% $toMillis($leaseHoldUntil) > $toMillis($now()) %}'),
        stillBusy
      )
      // Something is running with no lease claiming it. RDS force-starts an instance stopped for
      // 7 days, and a half-failed teardown looks the same, trigger stop.
      .when(sfn.Condition.jsonata("{% $leaseState != 'up' %}"), triggerStop)
      // The lease claims a live session but the service is scaled to zero - a partially-failed
      // start, or someone scaled it down by hand. Tear the rest down.
      .when(sfn.Condition.jsonata('{% $desiredCount = 0 %}'), triggerStop)
      // Count workers and extend hold or trigger idle stop if no workers are present
      // (this only runs if the above check for hold is false)
      .otherwise(countWorkerTasks);

    const workersRunning = sfn.Choice.jsonata(this, 'ReaperAreWorkersRunning')
      .when(sfn.Condition.jsonata('{% $workerTasks > 0 %}'), extendHold)
      .otherwise(triggerStop);

    describeService.next(describeDb);
    describeDb.next(readLease);
    readLease.next(decide);
    countWorkerTasks.next(workersRunning);

    return new sfn.StateMachine(this, 'ReaperMachine', {
      stateMachineName: `foerderturm-${this.environment}-reaper`,
      comment: 'Decide whether the foerderturm orchestrator + RDS can be shut down',
      queryLanguage: sfn.QueryLanguage.JSONATA,
      definitionBody: sfn.DefinitionBody.fromChainable(describeService),
      stateMachineType: sfn.StateMachineType.EXPRESS,
      timeout: cdk.Duration.minutes(5),
      tracingEnabled: true,
      logs: logOptions,
    });
  }

  private addNagSuppressions(): void {
    NagSuppressions.addResourceSuppressions(this.leaseTable, [
      {
        id: 'AwsSolutions-DDB3',
        reason: 'PITR not required for a single item DB',
      },
    ]);

    for (const machine of [
      this.startStateMachine,
      this.stopStateMachine,
      this.reaperStateMachine,
    ]) {
      NagSuppressions.addResourceSuppressions(
        machine,
        [
          {
            id: 'AwsSolutions-IAM5',
            reason: 'ListTasks, describeDBInstances etc. requires "*" permissions',
          },
        ],
        true
      );
    }
  }
}
