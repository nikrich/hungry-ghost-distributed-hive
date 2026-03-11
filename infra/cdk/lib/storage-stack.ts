import * as cdk from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as efs from 'aws-cdk-lib/aws-efs';
import { Construct } from 'constructs';

export interface StorageStackProps extends cdk.StackProps {
  vpc: ec2.IVpc;
  fargateSecurityGroup: ec2.ISecurityGroup;
}

export class StorageStack extends cdk.Stack {
  public readonly table: dynamodb.Table;
  public readonly fileSystem: efs.FileSystem;
  public readonly accessPoint: efs.AccessPoint;
  public readonly eventBusName: string;

  constructor(scope: Construct, id: string, props: StorageStackProps) {
    super(scope, id, props);

    this.eventBusName = 'distributed-hive-events';

    // DynamoDB table: distributed-hive-state
    this.table = new dynamodb.Table(this, 'StateTable', {
      tableName: 'distributed-hive-state',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      timeToLiveAttribute: 'ttl',
      pointInTimeRecovery: true,
    });

    // GSI1: userId-index
    this.table.addGlobalSecondaryIndex({
      indexName: 'userId-index',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // GSI2: status-index
    this.table.addGlobalSecondaryIndex({
      indexName: 'status-index',
      partitionKey: { name: 'GSI2PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI2SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // EFS file system
    this.fileSystem = new efs.FileSystem(this, 'FileSystem', {
      vpc: props.vpc,
      fileSystemName: 'distributed-hive-efs',
      performanceMode: efs.PerformanceMode.GENERAL_PURPOSE,
      throughputMode: efs.ThroughputMode.BURSTING,
      lifecyclePolicy: efs.LifecyclePolicy.AFTER_7_DAYS,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
      securityGroup: props.fargateSecurityGroup,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      encrypted: true,
    });

    // Access point for Fargate tasks
    this.accessPoint = this.fileSystem.addAccessPoint('FargateAccessPoint', {
      path: '/efs',
      createAcl: {
        ownerGid: '1000',
        ownerUid: '1000',
        permissions: '755',
      },
      posixUser: {
        gid: '1000',
        uid: '1000',
      },
    });

    // Outputs
    new cdk.CfnOutput(this, 'TableName', { value: this.table.tableName });
    new cdk.CfnOutput(this, 'TableArn', { value: this.table.tableArn });
    new cdk.CfnOutput(this, 'FileSystemId', { value: this.fileSystem.fileSystemId });
    new cdk.CfnOutput(this, 'AccessPointId', { value: this.accessPoint.accessPointId });
  }
}
