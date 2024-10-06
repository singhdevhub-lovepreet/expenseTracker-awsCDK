#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { ExpenseTrackerServicesDeployStack } from '../lib/expense_tracker_services_deploy-stack';
import { ExpenseTrackerServices } from '../lib/expense_services-stack';

const app = new cdk.App();

// Define the AWS environment
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: process.env.CDK_DEFAULT_REGION,
};

// Deploy VPC stack
const vpcStack = new ExpenseTrackerServicesDeployStack(app, 'ExpenseTrackerServicesDeployStack', {
  env,  // Pass the environment configuration
});

// Deploy MySQL and Kafka stack
const mysqlAndKafkaStack = new ExpenseTrackerServices(app, 'ExpenseTrackerServicesStack', {
  env,  // Pass the environment configuration
});

mysqlAndKafkaStack.addDependency(vpcStack);
