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
      createInternetGateway: false, 
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'public-subnet',
          subnetType: SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'private-subnet',
          subnetType: SubnetType.PRIVATE_WITH_EGRESS,
        }
      ]
    });


    const internetGateway = new CfnInternetGateway(this, 'InternetGateway');
    new CfnVPCGatewayAttachment(this, 'MyUniqueVPCGatewayAttachment', {
      vpcId: vpc.vpcId,
      internetGatewayId: internetGateway.ref,
    });

    // NAT Gateways
    const natGatewayOne = new CfnNatGateway(this, 'NatGatewayOne', {
      subnetId: vpc.publicSubnets[0].subnetId,
      allocationId: new CfnEIP(this, 'EIPForNatGatewayOne').attrAllocationId,
    });

    const natGatewayTwo = new CfnNatGateway(this, 'NatGatewayTwo', {
      subnetId: vpc.publicSubnets[1].subnetId,
      allocationId: new CfnEIP(this, 'EIPForNatGatewayTwo').attrAllocationId,
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
        gatewayId: internetGateway.ref
      });
    });

    new cdk.aws_ssm.StringParameter(this, 'VpcIdExport', {
      parameterName: 'VpcId',
      stringValue: vpc.vpcId
    })
    
    vpc.publicSubnets.forEach((subnet, index)=> {
      new cdk.aws_ssm.StringParameter(this, `PublicSubnetExport-${index}`, {
        parameterName: `PublicSubnet-${index}`,
        stringValue: subnet.subnetId
      })
    })

    vpc.privateSubnets.forEach((subnet, index)=> {
      new cdk.aws_ssm.StringParameter(this, `PrivateSubnetExport-${index}`, {
        parameterName: `PrivateSubnet-${index}`,
        stringValue: subnet.subnetId
      })
    }) 

  }
}
