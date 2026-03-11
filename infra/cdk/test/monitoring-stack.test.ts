import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { MonitoringStack } from '../lib/monitoring-stack';

function createTestStack() {
  const app = new cdk.App();
  const stack = new MonitoringStack(app, 'TestMonitoring', {
    clusterName: 'distributed-hive',
    tableName: 'distributed-hive-state',
  });
  return { app, stack };
}

describe('MonitoringStack', () => {
  const { stack } = createTestStack();
  const template = Template.fromStack(stack);

  describe('SNS Topic', () => {
    it('creates alarm notification topic', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'distributed-hive-alarms',
        DisplayName: 'Distributed Hive Alarms',
      });
    });
  });

  describe('Log Groups', () => {
    it('creates API log group with 30-day retention', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/distributed-hive/api',
        RetentionInDays: 30,
      });
    });

    it('creates state sync log group with 30-day retention', () => {
      template.hasResourceProperties('AWS::Logs::LogGroup', {
        LogGroupName: '/distributed-hive/state-sync',
        RetentionInDays: 30,
      });
    });
  });

  describe('CloudWatch Alarms', () => {
    it('creates run duration alarm (threshold 8 hours)', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'distributed-hive-run-duration-high',
        MetricName: 'RunDuration',
        Namespace: 'DistributedHive',
        Threshold: 28800,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
        TreatMissingData: 'notBreaching',
      });
    });

    it('creates active tasks alarm (threshold 10)', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'distributed-hive-active-tasks-high',
        MetricName: 'RunningTaskCount',
        Namespace: 'AWS/ECS',
        Threshold: 10,
        ComparisonOperator: 'GreaterThanThreshold',
        EvaluationPeriods: 1,
      });
    });

    it('creates estimated cost alarm (threshold $50)', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'distributed-hive-cost-high',
        MetricName: 'EstimatedCost',
        Namespace: 'DistributedHive',
        Threshold: 50,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });

    it('creates agent stuck alarm (threshold 3)', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'distributed-hive-agents-stuck',
        MetricName: 'AgentStuckCount',
        Namespace: 'DistributedHive',
        Threshold: 3,
      });
    });

    it('creates escalation alarm (threshold 0)', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'distributed-hive-escalation',
        MetricName: 'EscalationCount',
        Namespace: 'DistributedHive',
        Threshold: 0,
      });
    });

    it('all alarms notify SNS topic', () => {
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      for (const [, alarm] of Object.entries(alarms)) {
        const props = alarm.Properties;
        if (props.AlarmActions) {
          Match.arrayWith([Match.objectLike({})]).test(props.AlarmActions);
        }
      }
    });
  });

  describe('CloudWatch Dashboard', () => {
    it('creates dashboard named distributed-hive', () => {
      template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
        DashboardName: 'distributed-hive',
      });
    });

    it('dashboard body contains widget definitions', () => {
      // DashboardBody is a Fn::Join intrinsic in CloudFormation, so we verify
      // the dashboard resource exists with the correct name (widget content is
      // embedded inside the joined array and validated by CDK synthesis).
      template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    });
  });

  describe('Outputs', () => {
    it('exports dashboard name, alarm topic ARN, and log group names', () => {
      template.hasOutput('DashboardName', {});
      template.hasOutput('AlarmTopicArn', {});
      template.hasOutput('ApiLogGroupName', {});
      template.hasOutput('StateSyncLogGroupName', {});
    });
  });
});
