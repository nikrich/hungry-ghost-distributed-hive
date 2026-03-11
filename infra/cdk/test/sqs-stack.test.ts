import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { SqsStack } from '../lib/sqs-stack';

describe('SqsStack', () => {
  const app = new cdk.App();
  const stack = new SqsStack(app, 'TestSqs');
  const template = Template.fromStack(stack);

  describe('Main Queue', () => {
    it('creates distributed-hive-runs queue', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'distributed-hive-runs',
      });
    });

    it('configures 900-second visibility timeout', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'distributed-hive-runs',
        VisibilityTimeout: 900,
      });
    });

    it('configures 14-day retention period', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'distributed-hive-runs',
        MessageRetentionPeriod: 1209600,
      });
    });

    it('configures DLQ with max receive count of 3', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'distributed-hive-runs',
        RedrivePolicy: {
          maxReceiveCount: 3,
        },
      });
    });
  });

  describe('Dead-Letter Queue', () => {
    it('creates DLQ with correct name', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'distributed-hive-runs-dlq',
      });
    });

    it('configures 14-day retention on DLQ', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        QueueName: 'distributed-hive-runs-dlq',
        MessageRetentionPeriod: 1209600,
      });
    });
  });

  describe('Outputs', () => {
    it('exports queue URL and ARN', () => {
      template.hasOutput('QueueUrl', {});
      template.hasOutput('QueueArn', {});
    });

    it('exports DLQ URL and ARN', () => {
      template.hasOutput('DlqUrl', {});
      template.hasOutput('DlqArn', {});
    });
  });
});
