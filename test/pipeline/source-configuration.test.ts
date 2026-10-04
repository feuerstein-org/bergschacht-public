import * as fs from 'node:fs';
import * as path from 'node:path';
import * as cdk from 'aws-cdk-lib/core';
import { Template } from 'aws-cdk-lib/assertions';

import * as settings from '../../lib/config/constants.ts';
import { DevelopmentPipelineStack } from '../../lib/pipeline/development-pipeline-stack.ts';
import { InfrastructurePipelineStack } from '../../lib/pipeline/infrastructure-pipeline-stack.ts';
import { ProductionPipelineStack } from '../../lib/pipeline/production-pipeline-stack.ts';

test('pipelines retain their triggers and trust only their source repository', () => {
  const app = new cdk.App({
    context: JSON.parse(
      fs.readFileSync(path.resolve(import.meta.dirname, '../../cdk.context.json'), 'utf8')
    ),
  });
  const props = {
    githubOwner: 'example-org',
    githubRepo: 'private-deployment',
    connectionArn: settings.githubConnectionArn,
    cicdAccountId: settings.cicdAccount,
    devAccountId: settings.devAccount,
    stageAccountId: settings.stageAccount,
    prodAccountId: settings.prodAccount,
    awsRegion: settings.awsRegion,
    pagerDutyEmail: settings.pagerDutyEmail,
    encryptionKeyAlias: 'alias/cicd-shared',
    env: { account: settings.cicdAccount, region: settings.awsRegion },
  };
  const infrastructure = new InfrastructurePipelineStack(app, 'InfrastructurePipeline', props);
  const development = new DevelopmentPipelineStack(app, 'DevelopmentPipeline', props);
  for (const stack of [
    infrastructure,
    development,
    new ProductionPipelineStack(app, 'ProductionPipeline', props),
  ]) {
    const template = Template.fromStack(stack);
    const pipeline = Object.values(template.findResources('AWS::CodePipeline::Pipeline'))[0]!
      .Properties;
    expect(pipeline.ExecutionMode ?? 'SUPERSEDED').toBe('SUPERSEDED');
    expect(pipeline.RestartExecutionOnUpdate).toBe(stack !== development);
    if (stack === development) {
      expect(pipeline.Stages[0].Actions[0].Name).toBe('GitHubSource');
      expect(pipeline.Triggers[0].GitConfiguration).toEqual({
        SourceActionName: 'GitHubSource',
        Push: [{ Branches: { Includes: ['dev-*'] } }],
      });
    } else {
      expect(pipeline.Triggers).toBeUndefined();
    }
    expect(pipeline.Stages[0].Actions[0]).toMatchObject({
      Configuration: { FullRepositoryId: 'example-org/private-deployment', DetectChanges: false },
    });
    const synth = Object.values(template.findResources('AWS::CodeBuild::Project')).find((project) =>
      JSON.stringify(project.Properties.Source.BuildSpec).includes('cdk synth')
    )!;
    expect(synth.Properties.Environment).toMatchObject({
      Type: 'ARM_LAMBDA_CONTAINER',
      ComputeType: 'BUILD_LAMBDA_2GB',
      Image: 'aws/codebuild/amazonlinux-aarch64-lambda-standard:nodejs22',
    });
  }

  const stage = infrastructure.node.findChild('Cicd');
  for (const environment of ['dev', 'prod']) {
    const title = environment === 'dev' ? 'Dev' : 'Prod';
    const stack = stage.node.findChild(`FeuersteinBergschacht${title}GitHubActions`) as cdk.Stack;
    const template = Template.fromStack(stack);
    const role = Object.values(template.findResources('AWS::IAM::Role'))[0]!.Properties;
    expect(role.MaxSessionDuration ?? 3600).toBe(3600);
    expect(role.AssumeRolePolicyDocument.Statement[0].Condition.StringEquals).toMatchObject({
      'token.actions.githubusercontent.com:sub': `repo:example-org/private-deployment:environment:${environment}`,
    });
    const policy = Object.values(template.findResources('AWS::IAM::Policy'))[0]!.Properties;
    const pipelinePermissions = policy.PolicyDocument.Statement.filter(
      (statement: { Action: string | string[] }) =>
        [statement.Action].flat().some((action) => action.startsWith('codepipeline:'))
    );
    expect(pipelinePermissions).toHaveLength(environment === 'dev' ? 0 : 1);
    if (environment === 'dev') continue;
    expect([pipelinePermissions[0].Action].flat()).toEqual(['codepipeline:StartPipelineExecution']);
    expect([pipelinePermissions[0].Resource].flat()).toEqual(
      ['Infrastructure', 'Production'].map(
        (name) =>
          `arn:aws:codepipeline:${props.awsRegion}:${props.cicdAccountId}:Bergschacht${name}Pipeline`
      )
    );
  }
}, 15000);
