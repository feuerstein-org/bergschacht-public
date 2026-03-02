import {
  getLambdaArtifact,
  getImageArtifact,
  SSM_PREFIX,
  _resetManifestCache,
  _loadManifestFromData,
} from '../../lib/config/version-manifest';

/**
 * Manifest file contents used across tests.
 * Mirrors the format produced by:
 *   aws ssm get-parameters-by-path --query "Parameters[*].{Name:Name,Value:Value}"
 */
const MANIFEST_ENTRIES: { Name: string; Value: string }[] = [
  // order-processor — lambda only
  {
    Name: `${SSM_PREFIX}/order-processor/lambdas/order-processor`,
    Value: JSON.stringify({
      bucket: 'my-artifacts-bucket',
      key: 'lambdas/order-processor/v1.2.3.zip',
      objectVersion: 'abc123VersionId',
      version: '1.2.3',
      commitSha: 'abc1234',
    }),
  },

  // payment-service — image only
  {
    Name: `${SSM_PREFIX}/payment-service/images/payment-service`,
    Value: JSON.stringify({
      repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/payment-service',
      imageTag: 'v2.0.1',
      version: '2.0.1',
      commitSha: '789abcd',
    }),
  },

  // dual-deploy-service — both lambda and image
  {
    Name: `${SSM_PREFIX}/dual-deploy-service/lambdas/dual-deploy-service`,
    Value: JSON.stringify({
      bucket: 'my-artifacts-bucket',
      key: 'lambdas/dual-deploy-service/v1.0.0.zip',
      objectVersion: 'deadbeefVersionId',
      version: '1.0.0',
      commitSha: 'deadbeef',
    }),
  },
  {
    Name: `${SSM_PREFIX}/dual-deploy-service/images/dual-deploy-service`,
    Value: JSON.stringify({
      repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/dual-deploy-service',
      imageTag: 'v1.0.0',
      version: '1.0.0',
      commitSha: 'deadbeef',
    }),
  },

  // multi-artifact-service — multiple images + one lambda
  {
    Name: `${SSM_PREFIX}/multi-artifact-service/images/worker`,
    Value: JSON.stringify({
      repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/multi-artifact-service',
      imageTag: 'worker-1.0.0',
      version: '1.0.0',
      commitSha: 'cafe1234',
    }),
  },
  {
    Name: `${SSM_PREFIX}/multi-artifact-service/images/api`,
    Value: JSON.stringify({
      repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/multi-artifact-service',
      imageTag: 'api-1.0.0',
      version: '1.0.0',
      commitSha: 'cafe1234',
    }),
  },
  {
    Name: `${SSM_PREFIX}/multi-artifact-service/lambdas/webhook`,
    Value: JSON.stringify({
      bucket: 'my-artifacts-bucket',
      key: 'lambdas/multi-artifact-service/webhook-1.0.0.zip',
      objectVersion: 'cafe1234VersionId',
      version: '1.0.0',
      commitSha: 'cafe1234',
    }),
  },
];

beforeEach(() => {
  _resetManifestCache();
  _loadManifestFromData(MANIFEST_ENTRIES);
});

afterEach(() => {
  _resetManifestCache();
});

describe('getLambdaArtifact', () => {
  test('returns a named lambda artifact', () => {
    const config = getLambdaArtifact('multi-artifact-service', 'webhook');

    expect(config.bucket).toBe('my-artifacts-bucket');
    expect(config.key).toContain('webhook');
    expect(config.version).toBe('1.0.0');
    expect(config.commitSha).toBe('cafe1234');
  });

  test('returns lambda artifact for single-artifact repo', () => {
    const config = getLambdaArtifact('order-processor', 'order-processor');

    expect(config.bucket).toBe('my-artifacts-bucket');
    expect(config.key).toContain('order-processor');
    expect(config.version).toBe('1.2.3');
  });
});

describe('getImageArtifact', () => {
  test('returns a named image artifact', () => {
    const config = getImageArtifact('multi-artifact-service', 'worker');

    expect(config.repository).toContain('ecr');
    expect(config.imageTag).toBe('worker-1.0.0');
    expect(config.version).toBe('1.0.0');
  });

  test('returns different named artifacts from the same repo', () => {
    const worker = getImageArtifact('multi-artifact-service', 'worker');
    const api = getImageArtifact('multi-artifact-service', 'api');

    expect(worker.imageTag).toBe('worker-1.0.0');
    expect(api.imageTag).toBe('api-1.0.0');
    expect(worker.repository).toBe(api.repository);
  });
});

describe('dual deployment repositories', () => {
  test('can get both lambda and image configs from same repo', () => {
    const lambdaConfig = getLambdaArtifact('dual-deploy-service', 'dual-deploy-service');
    const imageConfig = getImageArtifact('dual-deploy-service', 'dual-deploy-service');

    expect(lambdaConfig.bucket).toBe('my-artifacts-bucket');
    expect(lambdaConfig.version).toBe('1.0.0');

    expect(imageConfig.repository).toContain('ecr');
    expect(imageConfig.version).toBe('1.0.0');
  });
});

describe('multi-artifact repositories', () => {
  test('can get multiple image artifacts and lambda from same repo', () => {
    const worker = getImageArtifact('multi-artifact-service', 'worker');
    const api = getImageArtifact('multi-artifact-service', 'api');
    const webhook = getLambdaArtifact('multi-artifact-service', 'webhook');

    expect(worker.version).toBe('1.0.0');
    expect(api.version).toBe('1.0.0');
    expect(webhook.version).toBe('1.0.0');
  });
});

describe('error handling', () => {
  test('throws when artifact parameter is not in the manifest', () => {
    expect(() => getLambdaArtifact('nonexistent-repo', 'nonexistent')).toThrow(
      /not found in.*version-manifest\.json/
    );
  });
});
