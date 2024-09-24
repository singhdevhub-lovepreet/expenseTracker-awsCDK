import * as cdk from 'aws-cdk-lib';
import { CfnEIP, CfnInternetGateway, CfnNatGateway, CfnRoute, CfnVPCGatewayAttachment, SubnetType, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';

export class ExpenseTrackerServicesDeployStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create VPC
    const vpc = new Vpc(this, "myVPC", {
      vpcName: "expenseTracker",
      cidr: "10.0.0.0/16",
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public-subnet-1',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'public-subnet-2',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private-subnet-1',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 24,
          name: 'private-subnet-2',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        }
      ]
    });

    // Internet Gateway for public subnets
    const internetGateway = new CfnInternetGateway(this, 'InternetGateway');
    new CfnVPCGatewayAttachment(this, 'MyUniqueVPCGatewayAttachment', {
      vpcId: vpc.vpcId,
      internetGatewayId: internetGateway.ref,
    });

    // NAT Gateways
    const natGatewayOne = new CfnNatGateway(this, 'NatGatewayOne', {
      subnetId: vpc.publicSubnets[0].subnetId,
      allocationId: new CfnEIP(this, 'EIPForNatGatewayOne').ref, // Correct use of EIP reference
    });

    const natGatewayTwo = new CfnNatGateway(this, 'NatGatewayTwo', {
      subnetId: vpc.publicSubnets[1].subnetId,
      allocationId: new CfnEIP(this, 'EIPForNatGatewayTwo').ref,
    });

    // Route for private subnets to NAT Gateways
    vpc.privateSubnets.forEach((subnet, index) => {
      new CfnRoute(this, `PrivateRouteToNatGateway-${index}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        natGatewayId: index === 0 ? natGatewayOne.ref : natGatewayTwo.ref,
      });
    });

    // Route for public subnets to Internet Gateway
    vpc.publicSubnets.forEach((subnet, index) => {
      new CfnRoute(this, `PublicRouteToInternetGateway-${index}`, {
        routeTableId: subnet.routeTable.routeTableId,
        destinationCidrBlock: '0.0.0.0/0',
        gatewayId: internetGateway.ref,
      });
    });

    new cdk.CfnOutput(this, 'VPCIdOutput', {
      value: vpc.vpcId,
      exportName: 'VpcId'
    })

    vpc.publicSubnets.forEach((subnet, index)=> {
      new cdk.CfnOutput(this, `PublicSubnetOutput-${index}`, {
        value: subnet.subnetId,
        exportName: `PublicSubnet-${index}`
      });
    })

    vpc.privateSubnets.forEach((subnet, index)=> {
      new cdk.CfnOutput(this, `PrivateSubnetOutput-${index}`, {
        value: subnet.subnetId,
        exportName: `PrivateSubnet-${index}`
      });
    }) 
  }
}
