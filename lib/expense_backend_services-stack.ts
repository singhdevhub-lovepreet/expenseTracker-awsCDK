import * as cdk from 'aws-cdk-lib';
import { SecurityGroup, Subnet, Vpc } from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import * as assets from 'aws-cdk-lib/aws-ecr-assets';
import * as path from "path";
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as elbv2 from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';

export class ExpenseBackendServices extends cdk.Stack {
   
    constructor(scope: Construct, id: string, props?: cdk.StackProps){
        super(scope, id, props);
        
        const vpc = Vpc.fromLookup(this, 'VpcImported', {
            vpcId: cdk.aws_ssm.StringParameter.valueFromLookup(this, 'VpcId')
        });

        const privateSubnet1 = Subnet.fromSubnetId(this, 'PrivateSubnet1', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-0'));
        const privateSubnet2 = Subnet.fromSubnetId(this, 'PrivateSubnet2', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-1'));

        const nlbDnsName = cdk.aws_ssm.StringParameter.valueFromLookup(this, "ExpenseTrackerServicesNLB");

        const servicesSecurityGroup = new SecurityGroup(this, 'BackendServicesSecurityGroup', {
            vpc,
            allowAllOutbound: true
        });

        const authServiceImage = new assets.DockerImageAsset(this, 'AuthServiceImage', {
            directory: path.join(__dirname, '..', '..', 'backend_services', 'authservice'),
        });

        const cluster = new ecs.Cluster(this, 'ExpenseBackendCluster', {
            vpc: vpc
        })

        const authServiceTaskDef = new ecs.FargateTaskDefinition(this, 'AuthServiceTaskDef', {
            memoryLimitMiB: 1024,
            cpu: 512,
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
            }
        });

        const authFargateService = new ecs.FargateService(this, 'AuthService', {
            cluster: cluster,
            taskDefinition: authServiceTaskDef,
            desiredCount: 1,
            securityGroups: [servicesSecurityGroup],
            vpcSubnets: {subnets: [privateSubnet1, privateSubnet2]},
            assignPublicIp: false
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
                interval: cdk.Duration.seconds(60)
            }
        })

        authServiceTargetGroup.addTarget(authFargateService);

        const listener = authServiceAlb.addListener('AuthServiceListener', {
            port: 80,
            defaultTargetGroups: [authServiceTargetGroup]
        })

        new cdk.CfnOutput(this, 'AuthServiceALBDNS', {
            value: authServiceAlb.loadBalancerDnsName,
            description: 'Auth Service ALB DNS Name',
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