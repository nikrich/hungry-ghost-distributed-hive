import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { OpsStack } from '../lib/ops-stack';

function createTestStack() {
  const app = new cdk.App();
  const stack = new OpsStack(app, 'TestOps', {
    env: { account: '123456789012', region: 'af-south-1' },
    clusterArn: 'arn:aws:ecs:af-south-1:123456789012:cluster/distributed-hive',
    tableName: 'distributed-hive-state',
    fileSystemId: 'fs-12345',
    efsAccessPointId: 'fsap-12345',
  });
  return Template.fromStack(stack);
}

describe('OpsStack', () => {
  const template = createTestStack();

  describe('Timeout Enforcer Lambda', () => {
    it('creates timeout enforcer function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'distributed-hive-timeout-enforcer',
        Runtime: 'nodejs20.x',
      });
    });

    it('configures environment with cluster ARN and table name', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'distributed-hive-timeout-enforcer',
        Environment: {
          Variables: Match.objectLike({
            CLUSTER_ARN: 'arn:aws:ecs:af-south-1:123456789012:cluster/distributed-hive',
            DYNAMODB_TABLE: 'distributed-hive-state',
            MAX_RUN_SECONDS: '86400',
          }),
        },
      });
    });

    it('schedules timeout check every 15 minutes', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'distributed-hive-timeout-check',
        ScheduleExpression: 'rate(15 minutes)',
      });
    });
  });

  describe('EFS Cleanup Lambda', () => {
    it('creates cleanup function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'distributed-hive-efs-cleanup',
        Runtime: 'nodejs20.x',
      });
    });

    it('configures environment with table name and max age', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'distributed-hive-efs-cleanup',
        Environment: {
          Variables: Match.objectLike({
            DYNAMODB_TABLE: 'distributed-hive-state',
            MAX_AGE_DAYS: '30',
          }),
        },
      });
    });

    it('schedules daily cleanup at 3 AM UTC', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Name: 'distributed-hive-efs-cleanup',
        ScheduleExpression: 'cron(0 3 * * ? *)',
      });
    });
  });

  describe('Cost Budget Alert', () => {
    it('creates SNS topic for cost alerts', () => {
      template.hasResourceProperties('AWS::SNS::Topic', {
        TopicName: 'distributed-hive-cost-alerts',
      });
    });

    it('creates CloudWatch alarm for estimated charges', () => {
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        AlarmName: 'distributed-hive-monthly-cost',
        Threshold: 100,
        ComparisonOperator: 'GreaterThanThreshold',
      });
    });
  });

  describe('IAM', () => {
    it('grants ECS permissions to timeout enforcer', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['ecs:StopTask']),
            }),
          ]),
        }),
      });
    });

    it('grants DynamoDB permissions to cleanup function', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: Match.arrayWith(['dynamodb:Scan', 'dynamodb:DeleteItem']),
            }),
          ]),
        }),
      });
    });
  });

  describe('Outputs', () => {
    it('exports Lambda ARNs and topic ARN', () => {
      template.hasOutput('TimeoutEnforcerArn', {});
      template.hasOutput('EfsCleanupArn', {});
      template.hasOutput('CostAlarmTopicArn', {});
    });
  });
});
