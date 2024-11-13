import * as cdk from 'aws-cdk-lib';
import { SecurityGroup, Subnet, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from "path";
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import * as servicediscovery from 'aws-cdk-lib/aws-servicediscovery';
import * as ec2 from "aws-cdk-lib/aws-ec2"

export class ExpenseBackendServices extends cdk.Stack {
   
    constructor(scope: Construct, id: string, props?: cdk.StackProps){
        super(scope, id, props);
        
        const vpc = Vpc.fromLookup(this, 'VpcImported', {
            vpcId: cdk.aws_ssm.StringParameter.valueFromLookup(this, 'VpcId')
        });

        const namespace = new servicediscovery.PrivateDnsNamespace(this, 'BackendNamespace', {
            name: 'local',
            vpc,
            description: "namespace for expense backend services"
        });

        const privateSubnet1 = Subnet.fromSubnetId(this, 'PrivateSubnet1', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-0'));
        const privateSubnet2 = Subnet.fromSubnetId(this, 'PrivateSubnet2', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-1'));
        const publicSubnet1 = Subnet.fromSubnetId(this, 'PublicSubnet1', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PublicSubnet-0'));
        const publicSubnet2 = Subnet.fromSubnetId(this, 'PublicSubnet2', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PublicSubnet-1'));

        const nlbDnsName = cdk.aws_ssm.StringParameter.valueFromLookup(this, "ExpenseTrackerServicesNLB");

        const servicesSecurityGroup = new SecurityGroup(this, 'BackendServicesSecurityGroup', {
            vpc,
            allowAllOutbound: true
        });

        const authServiceImage = new assets.DockerImageAsset(this, 'AuthServiceImage', {
            directory: path.join(__dirname, '..', '..', 'backend_services', 'authservice'),
        });

        const kongServiceImage = new assets.DockerImageAsset(this, "KongServiceImage", {
            directory: path.join(__dirname, "..", "..", "expenseTrackerAppDeps", "kong")
        });

        const cluster = new ecs.Cluster(this, 'ExpenseBackendCluster', {
            vpc: vpc
        })

        const authServiceTaskDef = new ecs.FargateTaskDefinition(this, 'AuthServiceTaskDef', {
            memoryLimitMiB: 1024,
            cpu: 512,
        });

        const kongServiceTaskDef = new ecs.FargateTaskDefinition(this, 'KongServiceTaskDef', {
            memoryLimitMiB: 512,
            cpu: 256
        });

        authServiceTaskDef.addContainer('AuthServiceContainer', {
            image: ecs.ContainerImage.fromDockerImageAsset(authServiceImage),
            logging: ecs.LogDrivers.awsLogs({
                streamPrefix: "AuthService",
                logRetention: RetentionDays.ONE_WEEK 
            }),
            portMappings: [{containerPort: 9898}],
            environment: {
                MYSQL_HOST: nlbDnsName,
                MYSQL_PORT: '3306',
                MYSQL_DB: 'authservice',
                MYSQL_USER: 'user',
                MYSQL_PASSWORD: 'password',
                KAFKA_HOST: nlbDnsName,
                KAFKA_PORT: '9092'
            },
        });

        kongServiceTaskDef.addContainer('KongServiceContainer', {
            image: ecs.ContainerImage.fromDockerImageAsset(kongServiceImage),
            logging: ecs.LogDriver.awsLogs({
                streamPrefix: "KongService",
                logRetention: RetentionDays.ONE_WEEK
            })
        });

        const kongSecurityGroup = new SecurityGroup(this, "KongSecurityGroup", {
            vpc,
            allowAllOutbound: true,
            description: "Security Group for Kong"
         });
        
        kongSecurityGroup.addEgressRule(
            servicesSecurityGroup,
            ec2.Port.tcp(9898),
            'Allow Kong to access Auth Service'
        );

        servicesSecurityGroup.addIngressRule(
            kongSecurityGroup,
            ec2.Port.tcp(9898),
            'Allow traffic from Kong to Auth Service'
        )
        
        const kongFargateService = new ecs.FargateService(this, 'KongFargateService', {
            cluster: cluster,
            taskDefinition: kongServiceTaskDef,
            desiredCount: 1,
            securityGroups: [kongSecurityGroup],
            vpcSubnets: {
                subnets: [publicSubnet1, publicSubnet2]
            },
            assignPublicIp: true,
            cloudMapOptions: {
                name: 'kong',
                cloudMapNamespace: namespace,
                dnsRecordType: servicediscovery.DnsRecordType.A,
                dnsTtl: cdk.Duration.seconds(60)
            }
        });     

        
        const kongALB = new elbv2.ApplicationLoadBalancer(this, 'KongALB', {
            vpc, 
            internetFacing: true,
            vpcSubnets: {subnets: [publicSubnet1, publicSubnet2]}
        });

        const kongTargetGroup = new elbv2.ApplicationTargetGroup(this, 'KongTargetGroup', {
            vpc,
            port: 8000,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/status',
                interval: cdk.Duration.seconds(30),
                timeout: cdk.Duration.seconds(5)
            }
        });

        kongTargetGroup.addTarget(kongFargateService);
        const kongListener = kongALB.addListener('KongListener', {
            port: 80,
            defaultTargetGroups: [kongTargetGroup]
        });

        new cdk.CfnOutput(this, 'KongEndpoint', {
            value: kongALB.loadBalancerDnsName,
            description: 'Kong API Gateway endpoint'
        });

        const authFargateService = new ecs.FargateService(this, 'AuthService', {
            cluster: cluster,
            taskDefinition: authServiceTaskDef,
            desiredCount: 1,
            securityGroups: [servicesSecurityGroup],
            vpcSubnets: {subnets: [privateSubnet1, privateSubnet2]},
            assignPublicIp: false,
            enableExecuteCommand: true,
            cloudMapOptions: {
                name: 'auth-service',
                cloudMapNamespace: namespace,
                dnsRecordType: servicediscovery.DnsRecordType.A,
                dnsTtl: cdk.Duration.seconds(60)
            }
        });

        const authServiceAlb = new elbv2.ApplicationLoadBalancer(this, 'AuthServiceALB', {
            vpc,
            internetFacing: false,
            vpcSubnets: {subnets: [privateSubnet1, privateSubnet2]}
        });

        const authServiceTargetGroup = new elbv2.ApplicationTargetGroup(this, 'AuthServiceTargetGroup', {
            vpc,
            port: 9898,
            protocol: elbv2.ApplicationProtocol.HTTP,
            targetType: elbv2.TargetType.IP,
            healthCheck: {
                path: '/health',
                interval: cdk.Duration.seconds(60),
                timeout: cdk.Duration.seconds(30),
                healthyThresholdCount: 2,
                unhealthyThresholdCount: 3,
                healthyHttpCodes: '200-299'
            }
        })

        authServiceTargetGroup.addTarget(authFargateService);

        const listener = authServiceAlb.addListener('AuthServiceListener', {
            port: 80,
            defaultTargetGroups: [authServiceTargetGroup]
        });
        
        

    } 


}

/* solve using these commands when getting:- must use ASL logging (which requires CGO) if running as root
then use these commands:-

brew install docker-credential-helper-ecr
brew install docker-credential-helper

cat > ~/.docker/config.json << EOF
{
  "credsStore": "osxkeychain",
  "credHelpers": {
    "060795936197.dkr.ecr.ap-south-1.amazonaws.com": "ecr-login"
  }
}
EOF

chmod 600 ~/.docker/config.json

docker logout
docker logout 060795936197.dkr.ecr.ap-south-1.amazonaws.com

sudo aws ecr get-login-password --region ap-south-1 | docker login --username AWS --password-stdin 060795936197.dkr.ecr.ap-south-1.amazonaws.com

cat > ~/.docker/config.json << EOF
{
  "auths": {
    "060795936197.dkr.ecr.ap-south-1.amazonaws.com": {}
  },
  "credStore": "osxkeychain",
  "credHelpers": {
    "public.ecr.aws": "ecr-login",
    "060795936197.dkr.ecr.ap-south-1.amazonaws.com": "ecr-login"
  }
}
EOF

*/