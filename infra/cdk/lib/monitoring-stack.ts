import * as cdk from 'aws-cdk-lib';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as sns from 'aws-cdk-lib/aws-sns';
import { Construct } from 'constructs';

export interface MonitoringStackProps extends cdk.StackProps {
  clusterName: string;
  tableName: string;
}

export class MonitoringStack extends cdk.Stack {
  public readonly dashboard: cloudwatch.Dashboard;
  public readonly alarmTopic: sns.Topic;

  constructor(scope: Construct, id: string, props: MonitoringStackProps) {
    super(scope, id, props);

    // SNS topic for alarm notifications
    this.alarmTopic = new sns.Topic(this, 'AlarmTopic', {
      topicName: 'distributed-hive-alarms',
      displayName: 'Distributed Hive Alarms',
    });

    // Log groups with 30-day retention
    const apiLogGroup = new logs.LogGroup(this, 'ApiLogGroup', {
      logGroupName: '/distributed-hive/api',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    const stateSyncLogGroup = new logs.LogGroup(this, 'StateSyncLogGroup', {
      logGroupName: '/distributed-hive/state-sync',
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
    });

    // Custom metrics namespace
    const namespace = 'DistributedHive';

    // Metrics
    const runDurationMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'RunDuration',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(5),
    });

    const activeTasksMetric = new cloudwatch.Metric({
      namespace: 'AWS/ECS',
      metricName: 'RunningTaskCount',
      dimensionsMap: {
        ClusterName: props.clusterName,
      },
      statistic: 'Maximum',
      period: cdk.Duration.minutes(1),
    });

    const agentStuckCountMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'AgentStuckCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const storiesCompletedMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'StoriesCompleted',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const escalationCountMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'EscalationCount',
      statistic: 'Sum',
      period: cdk.Duration.minutes(5),
    });

    const estimatedCostMetric = new cloudwatch.Metric({
      namespace,
      metricName: 'EstimatedCost',
      statistic: 'Maximum',
      period: cdk.Duration.minutes(5),
    });

    // Alarms
    const runDurationAlarm = new cloudwatch.Alarm(this, 'RunDurationAlarm', {
      alarmName: 'distributed-hive-run-duration-high',
      alarmDescription: 'Run duration exceeds 8 hours',
      metric: runDurationMetric,
      threshold: 8 * 60 * 60, // 8 hours in seconds
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    runDurationAlarm.addAlarmAction(new AlarmSnsAction(this.alarmTopic));

    const activeTasksAlarm = new cloudwatch.Alarm(this, 'ActiveTasksAlarm', {
      alarmName: 'distributed-hive-active-tasks-high',
      alarmDescription: 'Active tasks exceed 10 (cost control)',
      metric: activeTasksMetric,
      threshold: 10,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    activeTasksAlarm.addAlarmAction(new AlarmSnsAction(this.alarmTopic));

    const estimatedCostAlarm = new cloudwatch.Alarm(this, 'EstimatedCostAlarm', {
      alarmName: 'distributed-hive-cost-high',
      alarmDescription: 'Estimated cost exceeds $50 per run',
      metric: estimatedCostMetric,
      threshold: 50,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    estimatedCostAlarm.addAlarmAction(new AlarmSnsAction(this.alarmTopic));

    const agentStuckAlarm = new cloudwatch.Alarm(this, 'AgentStuckAlarm', {
      alarmName: 'distributed-hive-agents-stuck',
      alarmDescription: 'More than 3 agents stuck in a run',
      metric: agentStuckCountMetric,
      threshold: 3,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    agentStuckAlarm.addAlarmAction(new AlarmSnsAction(this.alarmTopic));

    const escalationAlarm = new cloudwatch.Alarm(this, 'EscalationAlarm', {
      alarmName: 'distributed-hive-escalation',
      alarmDescription: 'Human escalation requested',
      metric: escalationCountMetric,
      threshold: 0,
      evaluationPeriods: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: cloudwatch.TreatMissingData.NOT_BREACHING,
    });
    escalationAlarm.addAlarmAction(new AlarmSnsAction(this.alarmTopic));

    // CloudWatch Dashboard
    this.dashboard = new cloudwatch.Dashboard(this, 'Dashboard', {
      dashboardName: 'distributed-hive',
      periodOverride: cloudwatch.PeriodOverride.AUTO,
    });

    this.dashboard.addWidgets(
      new cloudwatch.TextWidget({
        markdown: '# Distributed Hive Monitoring',
        width: 24,
        height: 1,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.AlarmStatusWidget({
        title: 'Alarm Status',
        alarms: [
          runDurationAlarm,
          activeTasksAlarm,
          estimatedCostAlarm,
          agentStuckAlarm,
          escalationAlarm,
        ],
        width: 24,
        height: 3,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Active Tasks',
        left: [activeTasksMetric],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Run Duration (seconds)',
        left: [runDurationMetric],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Estimated Cost ($)',
        left: [estimatedCostMetric],
        width: 8,
        height: 6,
      })
    );

    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'Stories Completed',
        left: [storiesCompletedMetric],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Agent Stuck Count',
        left: [agentStuckCountMetric],
        width: 8,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'Escalation Count',
        left: [escalationCountMetric],
        width: 8,
        height: 6,
      })
    );

    // DynamoDB metrics
    this.dashboard.addWidgets(
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Read Capacity',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedReadCapacityUnits',
            dimensionsMap: { TableName: props.tableName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      }),
      new cloudwatch.GraphWidget({
        title: 'DynamoDB Write Capacity',
        left: [
          new cloudwatch.Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ConsumedWriteCapacityUnits',
            dimensionsMap: { TableName: props.tableName },
            statistic: 'Sum',
            period: cdk.Duration.minutes(5),
          }),
        ],
        width: 12,
        height: 6,
      })
    );

    // Outputs
    new cdk.CfnOutput(this, 'DashboardName', { value: this.dashboard.dashboardName });
    new cdk.CfnOutput(this, 'AlarmTopicArn', { value: this.alarmTopic.topicArn });
    new cdk.CfnOutput(this, 'ApiLogGroupName', { value: apiLogGroup.logGroupName });
    new cdk.CfnOutput(this, 'StateSyncLogGroupName', { value: stateSyncLogGroup.logGroupName });
  }
}

/**
 * Simple alarm action that publishes to SNS.
 */
class AlarmSnsAction implements cloudwatch.IAlarmAction {
  constructor(private readonly topic: sns.ITopic) {}

  bind(_scope: Construct, _alarm: cloudwatch.IAlarm): cloudwatch.AlarmActionConfig {
    return {
      alarmActionArn: this.topic.topicArn,
    };
  }
}
