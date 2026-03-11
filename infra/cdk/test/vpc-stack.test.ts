import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { describe, expect, it } from 'vitest';
import { VpcStack } from '../lib/vpc-stack';

describe('VpcStack', () => {
  const app = new cdk.App();
  const stack = new VpcStack(app, 'TestVpc');
  const template = Template.fromStack(stack);

  it('creates a VPC with CIDR 10.0.0.0/16', () => {
    template.hasResourceProperties('AWS::EC2::VPC', {
      CidrBlock: '10.0.0.0/16',
    });
  });

  it('creates public and private subnets', () => {
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: true,
    });
    template.hasResourceProperties('AWS::EC2::Subnet', {
      MapPublicIpOnLaunch: false,
    });
  });

  it('creates a NAT Gateway', () => {
    template.resourceCountIs('AWS::EC2::NatGateway', 1);
  });

  it('creates sg-fargate with HTTPS and SSH outbound rules', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Fargate tasks',
      SecurityGroupEgress: [
        {
          CidrIp: '0.0.0.0/0',
          Description: 'Allow HTTPS outbound',
          FromPort: 443,
          IpProtocol: 'tcp',
          ToPort: 443,
        },
        {
          CidrIp: '0.0.0.0/0',
          Description: 'Allow git SSH outbound',
          FromPort: 22,
          IpProtocol: 'tcp',
          ToPort: 22,
        },
      ],
    });
  });

  it('creates sg-efs with NFS inbound from Fargate', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for EFS mount targets',
    });

    // Verify ingress rule allowing NFS from Fargate SG
    template.hasResourceProperties('AWS::EC2::SecurityGroupIngress', {
      IpProtocol: 'tcp',
      FromPort: 2049,
      ToPort: 2049,
      Description: 'Allow NFS from Fargate tasks',
    });
  });

  it('creates sg-lambda with HTTPS outbound', () => {
    template.hasResourceProperties('AWS::EC2::SecurityGroup', {
      GroupDescription: 'Security group for Lambda functions',
      SecurityGroupEgress: [
        {
          CidrIp: '0.0.0.0/0',
          Description: 'Allow HTTPS outbound for DynamoDB and API Gateway',
          FromPort: 443,
          IpProtocol: 'tcp',
          ToPort: 443,
        },
      ],
    });
  });

  it('exports VPC ID and security group IDs', () => {
    template.hasOutput('VpcId', {});
    template.hasOutput('FargateSecurityGroupId', {});
    template.hasOutput('EfsSecurityGroupId', {});
    template.hasOutput('LambdaSecurityGroupId', {});
  });
});
