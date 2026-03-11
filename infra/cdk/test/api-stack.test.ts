import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { ApiStack } from '../lib/api-stack';
import { SqsStack } from '../lib/sqs-stack';
import { StorageStack } from '../lib/storage-stack';
import { VpcStack } from '../lib/vpc-stack';

function createTestStacks() {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpc');
  const storageStack = new StorageStack(app, 'TestStorage', {
    vpc: vpcStack.vpc,
    fargateSecurityGroup: vpcStack.fargateSecurityGroup,
  });
  const sqsStack = new SqsStack(app, 'TestSqs');
  const apiStack = new ApiStack(app, 'TestApi', {
    table: storageStack.table,
    queue: sqsStack.queue,
    eventBusName: storageStack.eventBusName,
    lambdaCodePath: path.join(__dirname, '..', '..', '..', 'src', 'api', 'handlers'),
  });
  return { app, vpcStack, storageStack, sqsStack, apiStack };
}

describe('ApiStack', () => {
  const { apiStack } = createTestStacks();
  const template = Template.fromStack(apiStack);

  describe('HTTP API', () => {
    it('creates HTTP API named distributed-hive-api', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        Name: 'distributed-hive-api',
        ProtocolType: 'HTTP',
      });
    });

    it('configures CORS', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        CorsConfiguration: Match.objectLike({
          AllowMethods: Match.arrayWith(['GET', 'POST', 'PUT', 'DELETE']),
          AllowHeaders: Match.arrayWith(['Content-Type', 'Authorization']),
        }),
      });
    });

    it('creates routes for all 11 REST endpoints', () => {
      const routes = template.findResources('AWS::ApiGatewayV2::Route');
      const routeCount = Object.keys(routes).length;
      // 11 HTTP routes + 3 WebSocket routes ($connect, $disconnect, $default)
      expect(routeCount).toBeGreaterThanOrEqual(11);
    });
  });

  describe('Lambda Functions', () => {
    it('creates Lambda functions with Node.js 20 runtime', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Runtime: 'nodejs20.x',
      });
    });

    it('configures Lambda environment with DynamoDB table and SQS URL', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        Environment: {
          Variables: Match.objectLike({
            DYNAMODB_TABLE: Match.anyValue(),
            SQS_QUEUE_URL: Match.anyValue(),
          }),
        },
      });
    });

    it('creates all 11 REST handler functions', () => {
      const expectedNames = [
        'createRun', 'listRuns', 'getRun', 'cancelRun',
        'getStories', 'getAgents', 'getLogs', 'getPRs',
        'sendMessage', 'getSettings', 'updateSettings',
      ];
      for (const name of expectedNames) {
        template.hasResourceProperties('AWS::Lambda::Function', {
          FunctionName: `distributed-hive-${name}`,
        });
      }
    });

    it('creates WebSocket handler function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'distributed-hive-ws-handler',
      });
    });

    it('creates broadcaster function', () => {
      template.hasResourceProperties('AWS::Lambda::Function', {
        FunctionName: 'distributed-hive-ws-broadcaster',
      });
    });
  });

  describe('WebSocket API', () => {
    it('creates WebSocket API named distributed-hive-ws', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Api', {
        Name: 'distributed-hive-ws',
        ProtocolType: 'WEBSOCKET',
      });
    });

    it('creates prod stage with auto deploy', () => {
      template.hasResourceProperties('AWS::ApiGatewayV2::Stage', {
        StageName: 'prod',
        AutoDeploy: true,
      });
    });
  });

  describe('EventBridge', () => {
    it('creates distributed-hive-events event bus', () => {
      template.hasResourceProperties('AWS::Events::EventBus', {
        Name: 'distributed-hive-events',
      });
    });

    it('creates broadcast rule matching source distributed-hive', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        EventPattern: {
          source: ['distributed-hive'],
        },
      });
    });

    it('targets broadcaster Lambda from EventBridge rule', () => {
      template.hasResourceProperties('AWS::Events::Rule', {
        Targets: Match.arrayWith([
          Match.objectLike({
            Arn: Match.anyValue(),
          }),
        ]),
      });
    });
  });

  describe('IAM', () => {
    it('grants execute-api:ManageConnections to broadcaster', () => {
      template.hasResourceProperties('AWS::IAM::Policy', {
        PolicyDocument: Match.objectLike({
          Statement: Match.arrayWith([
            Match.objectLike({
              Action: 'execute-api:ManageConnections',
            }),
          ]),
        }),
      });
    });
  });

  describe('Outputs', () => {
    it('exports HTTP API URL', () => {
      template.hasOutput('HttpApiUrl', {});
    });

    it('exports WebSocket URL', () => {
      template.hasOutput('WebSocketUrl', {});
    });

    it('exports EventBridge bus name and ARN', () => {
      template.hasOutput('EventBusName', {});
      template.hasOutput('EventBusArn', {});
    });
  });
});
