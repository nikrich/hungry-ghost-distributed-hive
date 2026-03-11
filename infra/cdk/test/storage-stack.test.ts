import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, it } from 'vitest';
import { StorageStack } from '../lib/storage-stack';
import { VpcStack } from '../lib/vpc-stack';

describe('StorageStack', () => {
  const app = new cdk.App();
  const vpcStack = new VpcStack(app, 'TestVpc');
  const stack = new StorageStack(app, 'TestStorage', {
    vpc: vpcStack.vpc,
    fargateSecurityGroup: vpcStack.fargateSecurityGroup,
  });
  const template = Template.fromStack(stack);

  describe('DynamoDB Table', () => {
    it('creates distributed-hive-state table', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TableName: 'distributed-hive-state',
      });
    });

    it('configures PK and SK keys', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        KeySchema: [
          { AttributeName: 'PK', KeyType: 'HASH' },
          { AttributeName: 'SK', KeyType: 'RANGE' },
        ],
      });
    });

    it('uses on-demand billing', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        BillingMode: 'PAY_PER_REQUEST',
      });
    });

    it('enables TTL with ttl attribute', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        TimeToLiveSpecification: {
          AttributeName: 'ttl',
          Enabled: true,
        },
      });
    });

    it('enables point-in-time recovery', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        PointInTimeRecoverySpecification: {
          PointInTimeRecoveryEnabled: true,
        },
      });
    });

    it('creates GSI1 (userId-index)', () => {
      template.hasResourceProperties('AWS::DynamoDB::Table', {
        GlobalSecondaryIndexes: [
          {
            IndexName: 'userId-index',
            KeySchema: [
              { AttributeName: 'GSI1PK', KeyType: 'HASH' },
              { AttributeName: 'GSI1SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
          {
            IndexName: 'status-index',
            KeySchema: [
              { AttributeName: 'GSI2PK', KeyType: 'HASH' },
              { AttributeName: 'GSI2SK', KeyType: 'RANGE' },
            ],
            Projection: { ProjectionType: 'ALL' },
          },
        ],
      });
    });

    it('retains table on stack deletion', () => {
      template.hasResource('AWS::DynamoDB::Table', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });
  });

  describe('EFS File System', () => {
    it('creates an encrypted EFS file system', () => {
      template.hasResourceProperties('AWS::EFS::FileSystem', {
        Encrypted: true,
        PerformanceMode: 'generalPurpose',
        ThroughputMode: 'bursting',
      });
    });

    it('configures lifecycle policy for IA transition after 7 days', () => {
      template.hasResourceProperties('AWS::EFS::FileSystem', {
        LifecyclePolicies: [{ TransitionToIA: 'AFTER_7_DAYS' }],
      });
    });

    it('creates an access point with correct POSIX user', () => {
      template.hasResourceProperties('AWS::EFS::AccessPoint', {
        PosixUser: {
          Gid: '1000',
          Uid: '1000',
        },
        RootDirectory: {
          CreationInfo: {
            OwnerGid: '1000',
            OwnerUid: '1000',
            Permissions: '755',
          },
          Path: '/efs',
        },
      });
    });

    it('retains EFS on stack deletion', () => {
      template.hasResource('AWS::EFS::FileSystem', {
        DeletionPolicy: 'Retain',
        UpdateReplacePolicy: 'Retain',
      });
    });
  });

  describe('Outputs', () => {
    it('exports table name and ARN', () => {
      template.hasOutput('TableName', {});
      template.hasOutput('TableArn', {});
    });

    it('exports file system and access point IDs', () => {
      template.hasOutput('FileSystemId', {});
      template.hasOutput('AccessPointId', {});
    });
  });
});
