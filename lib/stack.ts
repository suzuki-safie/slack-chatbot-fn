import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as nodejs from 'aws-cdk-lib/aws-lambda-nodejs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as path from "path";


export class MyStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // The code that defines your stack goes here
    const vpc = new ec2.Vpc(this, "VPC", {
      maxAzs: 1,
      cidr: "10.1.0.0/16",
      natGateways: 0,
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: "PublicSubnet",
          subnetType: ec2.SubnetType.PUBLIC,
        },
      ],
    });

    const sg = new ec2.SecurityGroup(this, "SecurityGroup", {
      vpc,
      allowAllOutbound: true,
    });

    const fnChatbotHandler = new nodejs.NodejsFunction(this, "chatbot-handler", {
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: {
        sourceMap: true,
        sourceMapMode: nodejs.SourceMapMode.INLINE,
      },
      environment: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN!,
      },
      timeout: cdk.Duration.seconds(180),
      vpc,
      securityGroups: [sg],
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      allowPublicSubnet: true,
    });

    const fnSlackApp = new nodejs.NodejsFunction(this, "slack-app", {
      runtime: lambda.Runtime.NODEJS_20_X,
      bundling: {
        sourceMap: true,
        sourceMapMode: nodejs.SourceMapMode.INLINE,
      },
      environment: {
        SLACK_BOT_TOKEN: process.env.SLACK_BOT_TOKEN!,
        SLACK_SIGNING_SECRET: process.env.SLACK_SIGNING_SECRET!,
        CHATBOT_HANDLER_FUNCTION_NAME: fnChatbotHandler.functionName,
      },
      timeout: cdk.Duration.seconds(4),
      vpc,
      securityGroups: [sg],
      vpcSubnets: vpc.selectSubnets({
        subnetType: ec2.SubnetType.PUBLIC,
      }),
      allowPublicSubnet: true,
    });

    const fnUrl = fnSlackApp.addFunctionUrl({
      authType: lambda.FunctionUrlAuthType.NONE,
    });

    // slack-appからchatbot-handlerを呼び出す権限を付与
    fnChatbotHandler.grantInvoke(fnSlackApp);

    new cdk.CfnOutput(this, "LambdaFunctionURL", {
      value: fnUrl.url,
    });

    // see https://dev.to/slsbytheodo/deploy-a-lambda-with-a-static-ip-for-free-4e0l
    // see https://github.com/guillaumeduboc/free-static-ip/blob/main/lib/free-static-ip-stack.ts
    vpc.publicSubnets.map((subnet) => {
      const cr = new cdk.custom_resources.AwsCustomResource(subnet, 'customResource', {
        onCreate: {
          physicalResourceId: cdk.custom_resources.PhysicalResourceId.of(
            // adds a dependency on the security group and the subnet
            `${sg.securityGroupId}-${subnet.subnetId}-CustomResource`,
          ),
          service: 'EC2',
          action: 'describeNetworkInterfaces',
          parameters: {
            Filters: [
              { Name: 'interface-type', Values: ['lambda'] },
              { Name: 'group-id', Values: [sg.securityGroupId] },
              { Name: 'subnet-id', Values: [subnet.subnetId] },
            ],
          },
        },
        policy: cdk.custom_resources.AwsCustomResourcePolicy.fromSdkCalls({
          resources: cdk.custom_resources.AwsCustomResourcePolicy.ANY_RESOURCE,
        }),
      });
      // adds a dependency on the lambda function
      cr.node.addDependency(fnChatbotHandler);

      const eip =  new cdk.aws_ec2.CfnEIP(subnet, "EIP", { domain: "vpc" });
      new cdk.aws_ec2.CfnEIPAssociation(this, "EIPAssociation", {
        networkInterfaceId: cr.getResponseField('NetworkInterfaces.0.NetworkInterfaceId'),
        allocationId: eip.attrAllocationId,
      });

      new cdk.CfnOutput(this, "ElasticIP", {
        value: eip.attrPublicIp,
      });
    });
  }
}
