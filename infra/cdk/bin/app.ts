#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib';
import { ApiStack } from '../lib/api-stack';
import { EcsStack } from '../lib/ecs-stack';
import { FrontendStack } from '../lib/frontend-stack';
import { SqsStack } from '../lib/sqs-stack';
import { StorageStack } from '../lib/storage-stack';
import { VpcStack } from '../lib/vpc-stack';

const app = new cdk.App();

const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION ?? 'af-south-1',
};

const vpcStack = new VpcStack(app, 'DistributedHiveVpc', { env });

const storageStack = new StorageStack(app, 'DistributedHiveStorage', {
  env,
  vpc: vpcStack.vpc,
  fargateSecurityGroup: vpcStack.fargateSecurityGroup,
});
storageStack.addDependency(vpcStack);

const sqsStack = new SqsStack(app, 'DistributedHiveSqs', { env });

const apiStack = new ApiStack(app, 'DistributedHiveApi', {
  env,
  table: storageStack.table,
  queue: sqsStack.queue,
  eventBusName: storageStack.eventBusName,
});
apiStack.addDependency(storageStack);
apiStack.addDependency(sqsStack);

const ecsStack = new EcsStack(app, 'DistributedHiveEcs', {
  env,
  vpc: vpcStack.vpc,
  fargateSecurityGroup: vpcStack.fargateSecurityGroup,
  fileSystem: storageStack.fileSystem,
  accessPoint: storageStack.accessPoint,
  table: storageStack.table,
  eventBusName: storageStack.eventBusName,
});
ecsStack.addDependency(storageStack);

const frontendStack = new FrontendStack(app, 'DistributedHiveFrontend', { env });

app.synth();
