import {
  loadVersionManifest,
  getRepository,
  getLambdaArtifact,
  getImageArtifact,
  listRepositories,
  listLambdaArtifacts,
  listImageArtifacts,
  listManifests,
  hasLambdaDeployment,
  hasImageDeployment,
  getRepositoryDeploymentTypes,
} from '../lib/version-manifest';

const TEST_MANIFEST_NAME = 'test-manifest';

describe('Version Manifest', () => {
  describe('loadVersionManifest', () => {
    test('loads a named manifest', () => {
      const manifest = loadVersionManifest(TEST_MANIFEST_NAME);

      expect(manifest).toBeDefined();
      expect(manifest.schemaVersion).toBe('2.0.0');
      expect(manifest.repositories).toBeDefined();
    });

    test('throws error for non-existent manifest', () => {
      expect(() => loadVersionManifest('non-existent')).toThrow(/not found/);
    });
  });

  describe('getRepository', () => {
    test('returns repository configuration', () => {
      const repo = getRepository('order-processor', TEST_MANIFEST_NAME);

      expect(repo).toBeDefined();
      expect(repo.source).toBe('feuerstein/order-processor');
      expect(repo.lambdas).toBeDefined();
    });

    test('throws error for non-existent repository', () => {
      expect(() => getRepository('non-existent', TEST_MANIFEST_NAME)).toThrow(/not found/);
    });
  });

  describe('getLambdaArtifact', () => {
    test('returns a named lambda artifact', () => {
      const config = getLambdaArtifact('multi-artifact-service', 'webhook', TEST_MANIFEST_NAME);

      expect(config).toBeDefined();
      expect(config.bucket).toBe('my-artifacts-bucket');
      expect(config.key).toContain('webhook');
      expect(config.version).toBe('1.0.0');
    });

    test('throws error for non-existent artifact name', () => {
      expect(() =>
        getLambdaArtifact('multi-artifact-service', 'nonexistent', TEST_MANIFEST_NAME)
      ).toThrow(/Lambda artifact.*not found/);
    });
  });

  describe('getImageArtifact', () => {
    test('returns a named image artifact', () => {
      const config = getImageArtifact('multi-artifact-service', 'worker', TEST_MANIFEST_NAME);

      expect(config).toBeDefined();
      expect(config.repository).toContain('ecr');
      expect(config.imageTag).toBe('worker-1.0.0');
      expect(config.version).toBe('1.0.0');
    });

    test('returns different named artifacts from the same repo', () => {
      const worker = getImageArtifact('multi-artifact-service', 'worker', TEST_MANIFEST_NAME);
      const api = getImageArtifact('multi-artifact-service', 'api', TEST_MANIFEST_NAME);

      expect(worker.imageTag).toBe('worker-1.0.0');
      expect(api.imageTag).toBe('api-1.0.0');
      expect(worker.repository).toBe(api.repository);
    });
  });

  describe('listRepositories', () => {
    test('returns all repository names', () => {
      const repos = listRepositories(TEST_MANIFEST_NAME);

      expect(repos).toContain('order-processor');
      expect(repos).toContain('payment-service');
      expect(repos).toContain('api-gateway');
      expect(repos).toContain('dual-deploy-service');
      expect(repos).toContain('multi-artifact-service');
    });
  });

  describe('listLambdaArtifacts', () => {
    test('returns lambda artifact names for a repo', () => {
      const artifacts = listLambdaArtifacts('multi-artifact-service', TEST_MANIFEST_NAME);
      expect(artifacts).toEqual(['webhook']);
    });

    test('returns empty array for repo with no lambdas', () => {
      const artifacts = listLambdaArtifacts('payment-service', TEST_MANIFEST_NAME);
      expect(artifacts).toEqual([]);
    });
  });

  describe('listImageArtifacts', () => {
    test('returns image artifact names for a repo', () => {
      const artifacts = listImageArtifacts('multi-artifact-service', TEST_MANIFEST_NAME);
      expect(artifacts).toContain('worker');
      expect(artifacts).toContain('api');
      expect(artifacts).toHaveLength(2);
    });

    test('returns empty array for repo with no images', () => {
      const artifacts = listImageArtifacts('order-processor', TEST_MANIFEST_NAME);
      expect(artifacts).toEqual([]);
    });
  });

  describe('listManifests', () => {
    test('returns available manifests', () => {
      const manifests = listManifests();

      expect(manifests).toContain(TEST_MANIFEST_NAME);
    });
  });

  describe('deployment type checks', () => {
    test('hasLambdaDeployment correctly identifies lambda deployments', () => {
      const lambdaRepo = getRepository('order-processor', TEST_MANIFEST_NAME);
      const imageRepo = getRepository('payment-service', TEST_MANIFEST_NAME);
      const dualRepo = getRepository('dual-deploy-service', TEST_MANIFEST_NAME);

      expect(hasLambdaDeployment(lambdaRepo)).toBe(true);
      expect(hasLambdaDeployment(imageRepo)).toBe(false);
      expect(hasLambdaDeployment(dualRepo)).toBe(true);
    });

    test('hasImageDeployment correctly identifies image deployments', () => {
      const lambdaRepo = getRepository('order-processor', TEST_MANIFEST_NAME);
      const imageRepo = getRepository('payment-service', TEST_MANIFEST_NAME);
      const dualRepo = getRepository('dual-deploy-service', TEST_MANIFEST_NAME);

      expect(hasImageDeployment(lambdaRepo)).toBe(false);
      expect(hasImageDeployment(imageRepo)).toBe(true);
      expect(hasImageDeployment(dualRepo)).toBe(true);
    });
  });

  describe('getRepositoryDeploymentTypes', () => {
    test('returns correct deployment types for lambda-only repo', () => {
      const types = getRepositoryDeploymentTypes('order-processor', TEST_MANIFEST_NAME);
      expect(types).toEqual(['lambda']);
    });

    test('returns correct deployment types for image-only repo', () => {
      const types = getRepositoryDeploymentTypes('payment-service', TEST_MANIFEST_NAME);
      expect(types).toEqual(['image']);
    });

    test('returns correct deployment types for dual-deploy repo', () => {
      const types = getRepositoryDeploymentTypes('dual-deploy-service', TEST_MANIFEST_NAME);
      expect(types).toContain('lambda');
      expect(types).toContain('image');
      expect(types).toHaveLength(2);
    });
  });

  describe('dual deployment repositories', () => {
    test('can get both lambda and image configs from same repo', () => {
      const lambdaConfig = getLambdaArtifact(
        'dual-deploy-service',
        'dual-deploy-service',
        TEST_MANIFEST_NAME
      );
      const imageConfig = getImageArtifact(
        'dual-deploy-service',
        'dual-deploy-service',
        TEST_MANIFEST_NAME
      );

      expect(lambdaConfig.bucket).toBe('my-artifacts-bucket');
      expect(lambdaConfig.version).toBe('1.0.0');

      expect(imageConfig.repository).toContain('ecr');
      expect(imageConfig.version).toBe('1.0.0');
    });
  });

  describe('multi-artifact repositories', () => {
    test('can get multiple image artifacts from same repo', () => {
      const worker = getImageArtifact('multi-artifact-service', 'worker', TEST_MANIFEST_NAME);
      const api = getImageArtifact('multi-artifact-service', 'api', TEST_MANIFEST_NAME);
      const webhook = getLambdaArtifact('multi-artifact-service', 'webhook', TEST_MANIFEST_NAME);

      expect(worker.version).toBe('1.0.0');
      expect(api.version).toBe('1.0.0');
      expect(webhook.version).toBe('1.0.0');
    });
  });

  describe('source repository', () => {
    test('each repository has a source field', () => {
      const repos = listRepositories(TEST_MANIFEST_NAME);

      for (const name of repos) {
        const repo = getRepository(name, TEST_MANIFEST_NAME);
        expect(repo.source).toBeDefined();
        expect(typeof repo.source).toBe('string');
        expect(repo.source).toMatch(/^[a-zA-Z0-9-_]+\/[a-zA-Z0-9-_]+$/);
      }
    });

    test('returns correct source repository', () => {
      const repo = getRepository('payment-service', TEST_MANIFEST_NAME);
      expect(repo.source).toBe('feuerstein/payment-service');
    });
  });
});
