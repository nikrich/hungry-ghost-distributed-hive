import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as actions from 'aws-cdk-lib/aws-cloudwatch-actions';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface OpsStackProps extends cdk.StackProps {
  clusterArn: string;
  tableName: string;
  fileSystemId: string;
  efsAccessPointId: string;
}

export class OpsStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    // ── Run Timeout Enforcement Lambda ──
    // Runs every 15 minutes, checks for tasks running > 24 hours and stops them
    const timeoutRole = new iam.Role(this, 'TimeoutRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
      ],
    });

    timeoutRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:ListTasks', 'ecs:DescribeTasks', 'ecs:StopTask'],
        resources: ['*'],
        conditions: {
          ArnEquals: { 'ecs:cluster': props.clusterArn },
        },
      })
    );

    timeoutRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['ecs:ListTasks', 'ecs:DescribeTasks'],
        resources: ['*'],
      })
    );

    timeoutRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem', 'dynamodb:Query'],
        resources: [
          cdk.Arn.format(
            { service: 'dynamodb', resource: 'table', resourceName: props.tableName },
            this
          ),
        ],
      })
    );

    const timeoutLogGroup = new logs.LogGroup(this, 'TimeoutLogs', {
      logGroupName: '/lambda/distributed-hive-timeout-enforcer',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const timeoutFn = new lambda.Function(this, 'TimeoutEnforcer', {
      functionName: 'distributed-hive-timeout-enforcer',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { ECSClient, ListTasksCommand, DescribeTasksCommand, StopTaskCommand } = require("@aws-sdk/client-ecs");
const { DynamoDBClient, UpdateItemCommand } = require("@aws-sdk/client-dynamodb");

const MAX_RUN_SECONDS = parseInt(process.env.MAX_RUN_SECONDS || "86400");
const CLUSTER_ARN = process.env.CLUSTER_ARN;
const TABLE_NAME = process.env.DYNAMODB_TABLE;

exports.handler = async () => {
  const ecs = new ECSClient({});
  const dynamo = new DynamoDBClient({});
  const now = Date.now();
  let stoppedCount = 0;

  const listResult = await ecs.send(new ListTasksCommand({ cluster: CLUSTER_ARN }));
  if (!listResult.taskArns || listResult.taskArns.length === 0) {
    return { stoppedCount: 0 };
  }

  const descResult = await ecs.send(new DescribeTasksCommand({
    cluster: CLUSTER_ARN,
    tasks: listResult.taskArns,
  }));

  for (const task of descResult.tasks || []) {
    if (task.lastStatus !== "RUNNING" || !task.startedAt) continue;
    const elapsed = (now - new Date(task.startedAt).getTime()) / 1000;
    if (elapsed > MAX_RUN_SECONDS) {
      console.log("Stopping timed-out task:", task.taskArn, "elapsed:", elapsed);
      await ecs.send(new StopTaskCommand({
        cluster: CLUSTER_ARN,
        task: task.taskArn,
        reason: "Run timeout exceeded (" + MAX_RUN_SECONDS + "s)",
      }));
      stoppedCount++;
    }
  }

  return { stoppedCount };
};
`),
      environment: {
        CLUSTER_ARN: props.clusterArn,
        DYNAMODB_TABLE: props.tableName,
        MAX_RUN_SECONDS: '86400',
      },
      role: timeoutRole,
      timeout: cdk.Duration.seconds(60),
      memorySize: 128,
      logGroup: timeoutLogGroup,
    });

    // Run every 15 minutes
    new events.Rule(this, 'TimeoutSchedule', {
      ruleName: 'distributed-hive-timeout-check',
      schedule: events.Schedule.rate(cdk.Duration.minutes(15)),
      targets: [new targets.LambdaFunction(timeoutFn)],
    });

    // ── EFS Cleanup Lambda ──
    // Runs daily, deletes run data older than 30 days
    const cleanupRole = new iam.Role(this, 'CleanupRole', {
      assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole'),
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaVPCAccessExecutionRole'),
      ],
    });

    cleanupRole.addToPolicy(
      new iam.PolicyStatement({
        actions: [
          'elasticfilesystem:ClientMount',
          'elasticfilesystem:ClientWrite',
          'elasticfilesystem:DescribeMountTargets',
        ],
        resources: [
          cdk.Arn.format(
            {
              service: 'elasticfilesystem',
              resource: 'file-system',
              resourceName: props.fileSystemId,
            },
            this
          ),
        ],
      })
    );

    cleanupRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:Scan', 'dynamodb:DeleteItem'],
        resources: [
          cdk.Arn.format(
            { service: 'dynamodb', resource: 'table', resourceName: props.tableName },
            this
          ),
        ],
      })
    );

    const cleanupLogGroup = new logs.LogGroup(this, 'CleanupLogs', {
      logGroupName: '/lambda/distributed-hive-efs-cleanup',
      retention: logs.RetentionDays.TWO_WEEKS,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const cleanupFn = new lambda.Function(this, 'EfsCleanup', {
      functionName: 'distributed-hive-efs-cleanup',
      runtime: lambda.Runtime.NODEJS_20_X,
      handler: 'index.handler',
      code: lambda.Code.fromInline(`
const { DynamoDBClient, ScanCommand, DeleteItemCommand } = require("@aws-sdk/client-dynamodb");
const { marshall } = require("@aws-sdk/util-dynamodb");

const TABLE_NAME = process.env.DYNAMODB_TABLE;
const MAX_AGE_DAYS = parseInt(process.env.MAX_AGE_DAYS || "30");

exports.handler = async () => {
  const client = new DynamoDBClient({});
  const cutoff = new Date(Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
  let deletedCount = 0;

  // Scan for old META records (completed/failed runs)
  const result = await client.send(new ScanCommand({
    TableName: TABLE_NAME,
    FilterExpression: "SK = :sk AND #s < :cutoff AND (contains(#d.#st, :completed) OR contains(#d.#st, :failed) OR contains(#d.#st, :cancelled))",
    ExpressionAttributeNames: { "#s": "updatedAt", "#d": "data", "#st": "status" },
    ExpressionAttributeValues: marshall({
      ":sk": "META",
      ":cutoff": cutoff,
      ":completed": "completed",
      ":failed": "failed",
      ":cancelled": "cancelled",
    }),
  }));

  for (const item of result.Items || []) {
    const pk = item.PK.S;
    const sk = item.SK.S;
    console.log("Deleting old run item:", pk, sk);
    await client.send(new DeleteItemCommand({
      TableName: TABLE_NAME,
      Key: marshall({ PK: pk, SK: sk }),
    }));
    deletedCount++;
  }

  console.log("Cleanup complete. Deleted:", deletedCount, "items older than", MAX_AGE_DAYS, "days");
  return { deletedCount };
};
`),
      environment: {
        DYNAMODB_TABLE: props.tableName,
        MAX_AGE_DAYS: '30',
        EFS_FILE_SYSTEM_ID: props.fileSystemId,
      },
      role: cleanupRole,
      timeout: cdk.Duration.minutes(5),
      memorySize: 256,
      logGroup: cleanupLogGroup,
    });

    // Run daily at 3:00 AM UTC
    new events.Rule(this, 'CleanupSchedule', {
      ruleName: 'distributed-hive-efs-cleanup',
      schedule: events.Schedule.cron({ minute: '0', hour: '3' }),
      targets: [new targets.LambdaFunction(cleanupFn)],
    });

    // ── Cost Budget Alert ──
    const costAlarmTopic = new sns.Topic(this, 'CostAlarmTopic', {
      topicName: 'distributed-hive-cost-alerts',
    });

    // CloudWatch alarm on estimated charges
    const costAlarm = new cloudwatch.Alarm(this, 'CostAlarm', {
      alarmName: 'distributed-hive-monthly-cost',
      alarmDescription: 'Alert when estimated monthly costs exceed $100',
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Billing',
        metricName: 'EstimatedCharges',
        dimensionsMap: { Currency: 'USD' },
        statistic: 'Maximum',
        period: cdk.Duration.hours(6),
      }),
      threshold: 100,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    costAlarm.addAlarmAction(new actions.SnsAction(costAlarmTopic));

    // Outputs
    new cdk.CfnOutput(this, 'TimeoutEnforcerArn', { value: timeoutFn.functionArn });
    new cdk.CfnOutput(this, 'EfsCleanupArn', { value: cleanupFn.functionArn });
    new cdk.CfnOutput(this, 'CostAlarmTopicArn', { value: costAlarmTopic.topicArn });
  }
}
