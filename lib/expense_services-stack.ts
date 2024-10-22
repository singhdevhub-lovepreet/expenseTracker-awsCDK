import * as cdk from 'aws-cdk-lib';
import { Peer, Port, SecurityGroup, Subnet, Vpc } from 'aws-cdk-lib/aws-ec2';
import { AwsLogDriverMode, Cluster, ContainerImage, FargateService, FargateTaskDefinition, LogDrivers } from 'aws-cdk-lib/aws-ecs';
import { NetworkLoadBalancer, NetworkTargetGroup, Protocol, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';

export class ExpenseTrackerServices extends cdk.Stack {
    constructor(scope: Construct, id: string, props?: cdk.StackProps) {
        super(scope, id, props);

        const vpcId = cdk.aws_ssm.StringParameter.valueFromLookup(this, 'VpcId');
        const vpc = Vpc.fromLookup(this, "VpcImported", {
            vpcId: vpcId
        });

        const privateSubnet1 = Subnet.fromSubnetId(this, 'PrivateSubnet1', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-0'));
        const privateSubnet2 = Subnet.fromSubnetId(this, 'PrivateSubnet2', cdk.aws_ssm.StringParameter.valueFromLookup(this, 'PrivateSubnet-1'));

        const dbSecurityGroup = new SecurityGroup(this, 'DbSecurityGroup', {
            vpc,
            allowAllOutbound: true,
        });

        dbSecurityGroup.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(3306), 'Allow MySQL traffic');
        dbSecurityGroup.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(9092), 'Allow Kafka traffic');
        dbSecurityGroup.addIngressRule(Peer.ipv4(vpc.vpcCidrBlock), Port.tcp(2181), 'Allow Kafka to access Zookeeper');

        const cluster = new Cluster(this, 'DatabaseKafkaCluster', {
            vpc,
            defaultCloudMapNamespace: {
                name: 'local',
            },
        });

        const nlb = new NetworkLoadBalancer(this, 'DatabaseNLB', {
            vpc,
            internetFacing: false,
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
        });

        const mysqlTaskDefination = new FargateTaskDefinition(this, 'MySQLTaskDef');
        mysqlTaskDefination.addContainer('MySQLContainer', {
            image: ContainerImage.fromRegistry('mysql:8.3.0'),
            environment: {
                MYSQL_ROOT_PASSWORD: 'password',
                MYSQL_USER: 'user',
                MYSQL_PASSWORD: 'password',
                MYSQL_ROOT_USER: 'root'
            },
            logging: LogDrivers.awsLogs({
                streamPrefix: 'MySql',
                mode: AwsLogDriverMode.NON_BLOCKING,
                maxBufferSize: cdk.Size.mebibytes(25)
            }),
            portMappings: [{ containerPort: 3306 }],
        });

        const zookeeperTaskDefination = new FargateTaskDefinition(this, 'ZookeeperTaskDef', {
            memoryLimitMiB: 512,
            cpu: 256,
        });

        zookeeperTaskDefination.addContainer('ZookeeperContainer', {
            image: ContainerImage.fromRegistry('confluentinc/cp-zookeeper:7.4.4'),
            environment: {
                ZOOKEEPER_CLIENT_PORT: '2181',
                ZOOKEEPER_TICK_TIME: '2000'
            },
            portMappings: [{ containerPort: 2181 }],
            logging: LogDrivers.awsLogs({
                streamPrefix: 'Zookeeper',
                mode: AwsLogDriverMode.NON_BLOCKING,
                maxBufferSize: cdk.Size.mebibytes(25)
            })
        });

        const kafkaTaskDefination = new FargateTaskDefinition(this, 'KafkaTaskDef', {
            memoryLimitMiB: 1024,
            cpu: 512,
        });

        kafkaTaskDefination.addContainer('KafkaContainer', {
            image: ContainerImage.fromRegistry('confluentinc/cp-kafka:7.4.4'),
            environment: {
                KAFKA_BROKER_ID: "1",
                KAFKA_ZOOKEEPER_CONNECT: 'zookeeper-service.local:2181',
                KAFKA_ADVERTISED_LISTENERS: `PLAINTEXT://${nlb.loadBalancerDnsName}:9092`,
                KAFKA_LISTENERS: 'PLAINTEXT://:9092',
                KAFKA_LISTENER_SECURITY_PROTOCOL_MAP: 'PLAINTEXT:PLAINTEXT',
                KAFKA_INTER_BROKER_LISTENER_NAME: 'PLAINTEXT',
                KAFKA_OFFSETS_TOPIC_REPLICATION_FACTOR: '3',
            },
            portMappings: [{ containerPort: 9092 }],
            logging: LogDrivers.awsLogs({
                streamPrefix: 'Kafka',
                mode: AwsLogDriverMode.NON_BLOCKING,
                maxBufferSize: cdk.Size.mebibytes(25)
            })
        });

        const mysqlService = new FargateService(this, 'MySQLService', {
            cluster,
            taskDefinition: mysqlTaskDefination,
            desiredCount: 1,
            securityGroups: [dbSecurityGroup],
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
        });

        const zookeeperService = new FargateService(this, 'ZookeeperService', {
            cluster,
            taskDefinition: zookeeperTaskDefination,
            desiredCount: 3,
            securityGroups: [dbSecurityGroup],
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
            cloudMapOptions: {
                name: 'zookeeper-service'
            },
        });

        const kafkaService = new FargateService(this, 'KafkaService', {
            cluster,
            taskDefinition: kafkaTaskDefination,
            desiredCount: 3,
            securityGroups: [dbSecurityGroup],
            vpcSubnets: { subnets: [privateSubnet1, privateSubnet2] },
        });

        const mysqlTargetGroup = new NetworkTargetGroup(this, 'MySQLTargetGroup', {
            vpc,
            port: 3306,
            protocol: Protocol.TCP,
            targetType: TargetType.IP
        });

        const kafkaTargetGroup = new NetworkTargetGroup(this, 'KafkaTargetGroup', {
            vpc,
            port: 9092,
            protocol: Protocol.TCP,
            targetType: TargetType.IP,
        });


        mysqlTargetGroup.addTarget(mysqlService);
        kafkaTargetGroup.addTarget(kafkaService);

        nlb.addListener('MySQLListener', {
            port: 3306,
            protocol: Protocol.TCP,
            defaultTargetGroups: [mysqlTargetGroup],
        });

        nlb.addListener('KafkaListener', {
            port: 9092,
            protocol: Protocol.TCP,
            defaultTargetGroups: [kafkaTargetGroup],
        });

        
        new cdk.aws_ssm.StringParameter(this, `ExpenseTrackerServicesNLB`, {
            parameterName: `ExpenseTrackerServicesNLB`,
            stringValue: nlb.loadBalancerDnsName
        })
        
    }
}
