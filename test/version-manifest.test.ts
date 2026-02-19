import * as cdk from 'aws-cdk-lib/core';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { getLambdaArtifact, getImageArtifact, SSM_PREFIX } from '../lib/version-manifest';

/**
 * SSM parameter store contents used across tests.
 * Each artifact is stored as a single JSON-valued parameter.
 */
const SSM_PARAMS: Record<string, string> = {
  // order-processor — lambda only
  [`${SSM_PREFIX}/order-processor/lambdas/order-processor`]: JSON.stringify({
    bucket: 'my-artifacts-bucket',
    key: 'lambdas/order-processor/v1.2.3.zip',
    version: '1.2.3',
    commitSha: 'abc1234',
  }),

  // payment-service — image only
  [`${SSM_PREFIX}/payment-service/images/payment-service`]: JSON.stringify({
    repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/payment-service',
    imageTag: 'v2.0.1',
    version: '2.0.1',
    commitSha: '789abcd',
  }),

  // dual-deploy-service — both lambda and image
  [`${SSM_PREFIX}/dual-deploy-service/lambdas/dual-deploy-service`]: JSON.stringify({
    bucket: 'my-artifacts-bucket',
    key: 'lambdas/dual-deploy-service/v1.0.0.zip',
    version: '1.0.0',
    commitSha: 'deadbeef',
  }),
  [`${SSM_PREFIX}/dual-deploy-service/images/dual-deploy-service`]: JSON.stringify({
    repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/dual-deploy-service',
    imageTag: 'v1.0.0',
    version: '1.0.0',
    commitSha: 'deadbeef',
  }),

  // multi-artifact-service — multiple images + one lambda
  [`${SSM_PREFIX}/multi-artifact-service/images/worker`]: JSON.stringify({
    repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/multi-artifact-service',
    imageTag: 'worker-1.0.0',
    version: '1.0.0',
    commitSha: 'cafe1234',
  }),
  [`${SSM_PREFIX}/multi-artifact-service/images/api`]: JSON.stringify({
    repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/multi-artifact-service',
    imageTag: 'api-1.0.0',
    version: '1.0.0',
    commitSha: 'cafe1234',
  }),
  [`${SSM_PREFIX}/multi-artifact-service/lambdas/webhook`]: JSON.stringify({
    bucket: 'my-artifacts-bucket',
    key: 'lambdas/multi-artifact-service/webhook-1.0.0.zip',
    version: '1.0.0',
    commitSha: 'cafe1234',
  }),
};

let stack: cdk.Stack;

beforeEach(() => {
  // Mock valueFromLookup to return values from SSM_PARAMS
  jest.spyOn(ssm.StringParameter, 'valueFromLookup').mockImplementation((_scope, paramName) => {
    const value = SSM_PARAMS[paramName];
    if (value === undefined) {
      throw new Error(`SSM parameter not found in test data: ${paramName}`);
    }
    return value;
  });

  const app = new cdk.App();
  stack = new cdk.Stack(app, 'Test');
});

afterEach(() => {
  jest.restoreAllMocks();
});

describe('getLambdaArtifact', () => {
  test('returns a named lambda artifact', () => {
    const config = getLambdaArtifact(stack, 'multi-artifact-service', 'webhook');

    expect(config.bucket).toBe('my-artifacts-bucket');
    expect(config.key).toContain('webhook');
    expect(config.version).toBe('1.0.0');
    expect(config.commitSha).toBe('cafe1234');
  });

  test('returns lambda artifact for single-artifact repo', () => {
    const config = getLambdaArtifact(stack, 'order-processor', 'order-processor');

    expect(config.bucket).toBe('my-artifacts-bucket');
    expect(config.key).toContain('order-processor');
    expect(config.version).toBe('1.2.3');
  });
});

describe('getImageArtifact', () => {
  test('returns a named image artifact', () => {
    const config = getImageArtifact(stack, 'multi-artifact-service', 'worker');

    expect(config.repository).toContain('ecr');
    expect(config.imageTag).toBe('worker-1.0.0');
    expect(config.version).toBe('1.0.0');
  });

  test('returns different named artifacts from the same repo', () => {
    const worker = getImageArtifact(stack, 'multi-artifact-service', 'worker');
    const api = getImageArtifact(stack, 'multi-artifact-service', 'api');

    expect(worker.imageTag).toBe('worker-1.0.0');
    expect(api.imageTag).toBe('api-1.0.0');
    expect(worker.repository).toBe(api.repository);
  });
});

describe('dual deployment repositories', () => {
  test('can get both lambda and image configs from same repo', () => {
    const lambdaConfig = getLambdaArtifact(stack, 'dual-deploy-service', 'dual-deploy-service');
    const imageConfig = getImageArtifact(stack, 'dual-deploy-service', 'dual-deploy-service');

    expect(lambdaConfig.bucket).toBe('my-artifacts-bucket');
    expect(lambdaConfig.version).toBe('1.0.0');

    expect(imageConfig.repository).toContain('ecr');
    expect(imageConfig.version).toBe('1.0.0');
  });
});

describe('multi-artifact repositories', () => {
  test('can get multiple image artifacts and lambda from same repo', () => {
    const worker = getImageArtifact(stack, 'multi-artifact-service', 'worker');
    const api = getImageArtifact(stack, 'multi-artifact-service', 'api');
    const webhook = getLambdaArtifact(stack, 'multi-artifact-service', 'webhook');

    expect(worker.version).toBe('1.0.0');
    expect(api.version).toBe('1.0.0');
    expect(webhook.version).toBe('1.0.0');
  });
});
