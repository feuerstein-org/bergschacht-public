import {
  loadVersionManifest,
  getPackage,
  getLambdaPackage,
  getImagePackage,
  listPackages,
  listManifests,
  hasLambdaDeployment,
  hasImageDeployment,
  getPackageDeploymentTypes,
} from '../lib/version-manifest';

const TEST_MANIFEST_NAME = 'test-manifest';

describe('Version Manifest', () => {
  describe('loadVersionManifest', () => {
    test('loads a named manifest', () => {
      const manifest = loadVersionManifest(TEST_MANIFEST_NAME);

      expect(manifest).toBeDefined();
      expect(manifest.schemaVersion).toBe('1.0.0');
      expect(manifest.packages).toBeDefined();
    });

    test('throws error for non-existent manifest', () => {
      expect(() => loadVersionManifest('non-existent')).toThrow(/not found/);
    });
  });

  describe('getPackage', () => {
    test('returns package configuration', () => {
      const pkg = getPackage('order-processor', TEST_MANIFEST_NAME);

      expect(pkg).toBeDefined();
      expect(pkg.lambda).toBeDefined();
    });

    test('throws error for non-existent package', () => {
      expect(() => getPackage('non-existent', TEST_MANIFEST_NAME)).toThrow(/not found/);
    });
  });

  describe('getLambdaPackage', () => {
    test('returns lambda configuration', () => {
      const config = getLambdaPackage('order-processor', TEST_MANIFEST_NAME);

      expect(config).toBeDefined();
      expect(config.bucket).toBe('my-artifacts-bucket');
      expect(config.key).toContain('order-processor');
      expect(config.version).toBe('1.2.3');
      expect(config.commitSha).toMatch(/^[a-f0-9]{7,40}$/);
    });

    test('throws error for package without lambda deployment', () => {
      expect(() => getLambdaPackage('payment-service', TEST_MANIFEST_NAME)).toThrow(
        /does not have a Lambda deployment/
      );
    });
  });

  describe('getImagePackage', () => {
    test('returns container image configuration', () => {
      const config = getImagePackage('payment-service', TEST_MANIFEST_NAME);

      expect(config).toBeDefined();
      expect(config.repository).toContain('ecr');
      expect(config.imageTag).toBe('v2.0.1');
      expect(config.version).toBe('2.0.1');
      expect(config.commitSha).toMatch(/^[a-f0-9]{7,40}$/);
    });

    test('throws error for package without image deployment', () => {
      expect(() => getImagePackage('order-processor', TEST_MANIFEST_NAME)).toThrow(
        /does not have an image deployment/
      );
    });
  });

  describe('listPackages', () => {
    test('returns all package names', () => {
      const packages = listPackages(TEST_MANIFEST_NAME);

      expect(packages).toContain('order-processor');
      expect(packages).toContain('payment-service');
      expect(packages).toContain('api-gateway');
      expect(packages).toContain('dual-deploy-service');
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
      const lambdaPkg = getPackage('order-processor', TEST_MANIFEST_NAME);
      const imagePkg = getPackage('payment-service', TEST_MANIFEST_NAME);
      const dualPkg = getPackage('dual-deploy-service', TEST_MANIFEST_NAME);

      expect(hasLambdaDeployment(lambdaPkg)).toBe(true);
      expect(hasLambdaDeployment(imagePkg)).toBe(false);
      expect(hasLambdaDeployment(dualPkg)).toBe(true);
    });

    test('hasImageDeployment correctly identifies image deployments', () => {
      const lambdaPkg = getPackage('order-processor', TEST_MANIFEST_NAME);
      const imagePkg = getPackage('payment-service', TEST_MANIFEST_NAME);
      const dualPkg = getPackage('dual-deploy-service', TEST_MANIFEST_NAME);

      expect(hasImageDeployment(lambdaPkg)).toBe(false);
      expect(hasImageDeployment(imagePkg)).toBe(true);
      expect(hasImageDeployment(dualPkg)).toBe(true);
    });
  });

  describe('getPackageDeploymentTypes', () => {
    test('returns correct deployment types for lambda-only package', () => {
      const types = getPackageDeploymentTypes('order-processor', TEST_MANIFEST_NAME);
      expect(types).toEqual(['lambda']);
    });

    test('returns correct deployment types for image-only package', () => {
      const types = getPackageDeploymentTypes('payment-service', TEST_MANIFEST_NAME);
      expect(types).toEqual(['image']);
    });

    test('returns correct deployment types for dual-deploy package', () => {
      const types = getPackageDeploymentTypes('dual-deploy-service', TEST_MANIFEST_NAME);
      expect(types).toContain('lambda');
      expect(types).toContain('image');
      expect(types).toHaveLength(2);
    });
  });

  describe('dual deployment packages', () => {
    test('can get both lambda and image configs from same package', () => {
      const lambdaConfig = getLambdaPackage('dual-deploy-service', TEST_MANIFEST_NAME);
      const imageConfig = getImagePackage('dual-deploy-service', TEST_MANIFEST_NAME);

      expect(lambdaConfig.bucket).toBe('my-artifacts-bucket');
      expect(lambdaConfig.version).toBe('1.0.0');

      expect(imageConfig.repository).toContain('ecr');
      expect(imageConfig.version).toBe('1.0.0');
    });
  });
});
