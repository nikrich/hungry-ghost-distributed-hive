import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as apigatewayv2 from 'aws-cdk-lib/aws-apigatewayv2';
import * as integrations from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { Construct } from 'constructs';

interface RouteConfig {
  method: apigatewayv2.HttpMethod;
  path: string;
  fnName: string;
  handler: string;
}

export interface ApiStackProps extends cdk.StackProps {
  table: dynamodb.ITable;
  queue: sqs.IQueue;
  eventBusName: string;
  /** Path to the pre-bundled Lambda code directory. Defaults to src/api/handlers relative to repo root. */
  lambdaCodePath?: string;
}

export class ApiStack extends cdk.Stack {
  public readonly httpApi: apigatewayv2.HttpApi;
  public readonly webSocketApi: apigatewayv2.WebSocketApi;
  public readonly webSocketStage: apigatewayv2.WebSocketStage;
  public readonly eventBus: events.EventBus;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);

    const codePath = props.lambdaCodePath ?? path.join(__dirname, '..', '..', '..', 'src', 'api', 'handlers');
    const lambdaCode = lambda.Code.fromAsset(codePath);

    // ── HTTP API ──
    this.httpApi = new apigatewayv2.HttpApi(this, 'HttpApi', {
      apiName: 'distributed-hive-api',
      corsPreflight: {
        allowOrigins: ['*'],
        allowMethods: [
          apigatewayv2.CorsHttpMethod.GET,
          apigatewayv2.CorsHttpMethod.POST,
          apigatewayv2.CorsHttpMethod.PUT,
          apigatewayv2.CorsHttpMethod.DELETE,
        ],
        allowHeaders: ['Content-Type', 'Authorization'],
      },
    });

    const routes: RouteConfig[] = [
      { method: apigatewayv2.HttpMethod.POST, path: '/api/runs', fnName: 'createRun', handler: 'createRun.handler' },
      { method: apigatewayv2.HttpMethod.GET, path: '/api/runs', fnName: 'listRuns', handler: 'listRuns.handler' },
      { method: apigatewayv2.HttpMethod.GET, path: '/api/runs/{id}', fnName: 'getRun', handler: 'getRun.handler' },
      { method: apigatewayv2.HttpMethod.DELETE, path: '/api/runs/{id}', fnName: 'cancelRun', handler: 'cancelRun.handler' },
      { method: apigatewayv2.HttpMethod.GET, path: '/api/runs/{id}/stories', fnName: 'getStories', handler: 'getStories.handler' },
      { method: apigatewayv2.HttpMethod.GET, path: '/api/runs/{id}/agents', fnName: 'getAgents', handler: 'getAgents.handler' },
      { method: apigatewayv2.HttpMethod.GET, path: '/api/runs/{id}/logs', fnName: 'getLogs', handler: 'getLogs.handler' },
      { method: apigatewayv2.HttpMethod.GET, path: '/api/runs/{id}/prs', fnName: 'getPRs', handler: 'getPRs.handler' },
      { method: apigatewayv2.HttpMethod.POST, path: '/api/runs/{id}/message', fnName: 'sendMessage', handler: 'sendMessage.handler' },
      { method: apigatewayv2.HttpMethod.GET, path: '/api/settings', fnName: 'getSettings', handler: 'getSettings.handler' },
      { method: apigatewayv2.HttpMethod.PUT, path: '/api/settings', fnName: 'updateSettings', handler: 'updateSettings.handler' },
    ];

    for (const route of routes) {
      const fn = new lambda.Function(this, `Fn-${route.fnName}`, {
        runtime: lambda.Runtime.NODEJS_20_X,
        code: lambdaCode,
        handler: route.handler,
        functionName: `distributed-hive-${route.fnName}`,
        environment: {
          DYNAMODB_TABLE: props.table.tableName,
          SQS_QUEUE_URL: props.queue.queueUrl,
        },
        timeout: cdk.Duration.seconds(30),
        memorySize: 256,
      });

      props.table.grantReadWriteData(fn);
      props.queue.grantSendMessages(fn);

      this.httpApi.addRoutes({
        path: route.path,
        methods: [route.method],
        integration: new integrations.HttpLambdaIntegration(`${route.fnName}-int`, fn),
      });
    }

    // ── WebSocket API ──
    const wsHandlerFn = new lambda.Function(this, 'WsHandlerFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambdaCode,
      handler: 'ws-handler.handler',
      functionName: 'distributed-hive-ws-handler',
      environment: {
        DYNAMODB_TABLE: props.table.tableName,
      },
      timeout: cdk.Duration.seconds(10),
      memorySize: 256,
    });
    props.table.grantReadWriteData(wsHandlerFn);

    this.webSocketApi = new apigatewayv2.WebSocketApi(this, 'WebSocketApi', {
      apiName: 'distributed-hive-ws',
      connectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ws-connect-int', wsHandlerFn),
      },
      disconnectRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ws-disconnect-int', wsHandlerFn),
      },
      defaultRouteOptions: {
        integration: new integrations.WebSocketLambdaIntegration('ws-default-int', wsHandlerFn),
      },
    });

    this.webSocketStage = new apigatewayv2.WebSocketStage(this, 'WebSocketStage', {
      webSocketApi: this.webSocketApi,
      stageName: 'prod',
      autoDeploy: true,
    });

    // ── EventBridge ──
    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName: props.eventBusName,
    });

    // ws-broadcaster Lambda triggered by EventBridge
    const broadcasterFn = new lambda.Function(this, 'BroadcasterFn', {
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambdaCode,
      handler: 'ws-broadcaster.handler',
      functionName: 'distributed-hive-ws-broadcaster',
      environment: {
        DYNAMODB_TABLE: props.table.tableName,
        WEBSOCKET_ENDPOINT: this.webSocketStage.callbackUrl,
      },
      timeout: cdk.Duration.seconds(30),
      memorySize: 256,
    });
    props.table.grantReadData(broadcasterFn);

    // Grant manage connections on the WebSocket API
    broadcasterFn.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['execute-api:ManageConnections'],
        resources: [
          `arn:aws:execute-api:${this.region}:${this.account}:${this.webSocketApi.apiId}/${this.webSocketStage.stageName}/POST/@connections/*`,
        ],
      })
    );

    // EventBridge rule: source = distributed-hive → broadcaster
    new events.Rule(this, 'BroadcastRule', {
      eventBus: this.eventBus,
      ruleName: 'distributed-hive-broadcast',
      eventPattern: {
        source: ['distributed-hive'],
      },
      targets: [new targets.LambdaFunction(broadcasterFn)],
    });

    // Outputs
    new cdk.CfnOutput(this, 'HttpApiUrl', {
      value: this.httpApi.apiEndpoint,
    });
    new cdk.CfnOutput(this, 'WebSocketUrl', {
      value: this.webSocketStage.url,
    });
    new cdk.CfnOutput(this, 'EventBusName', {
      value: this.eventBus.eventBusName,
    });
    new cdk.CfnOutput(this, 'EventBusArn', {
      value: this.eventBus.eventBusArn,
    });
  }
}
