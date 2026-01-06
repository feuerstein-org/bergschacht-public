/**
 * Version manifest loader utility.
 *
 * This module provides functions to load and access version manifest data
 * for deploying specific versions of Lambda functions and container images.
 * Packages can have multiple deployment types (lambda, image, or both).
 *
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  VersionManifest,
  Package,
  LambdaArtifactConfig,
  ContainerArtifactConfig,
} from './version-manifest.types';
import { hasLambdaDeployment, hasImageDeployment } from './version-manifest.types';

/** Path to the version manifests directory */
const MANIFESTS_DIR = path.resolve(__dirname, '..', '..', 'version-manifests');

/**
 * Load a version manifest from the version-manifests directory.
 * @param manifestName - Name of the manifest file (without .json extension), defaults to 'latest'
 * @returns The parsed version manifest
 * @throws Error if the manifest file doesn't exist or is invalid JSON
 */
export function loadVersionManifest(manifestName: string = 'latest'): VersionManifest {
  const manifestPath = path.join(MANIFESTS_DIR, `${manifestName}.json`);

  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Version manifest not found: ${manifestPath}`);
  }

  const content = fs.readFileSync(manifestPath, 'utf-8');
  return JSON.parse(content) as VersionManifest;
}

/**
 * Get a specific package from a version manifest.
 * @param packageName - Name of the package
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns The package configuration
 * @throws Error if the package doesn't exist in the manifest
 */
export function getPackage(packageName: string, manifestName: string = 'latest'): Package {
  const manifest = loadVersionManifest(manifestName);
  const pkg = manifest.packages[packageName];

  if (!pkg) {
    throw new Error(`Package '${packageName}' not found in manifest '${manifestName}'`);
  }

  return pkg;
}

/**
 * Get a Lambda package configuration from a version manifest.
 * @param packageName - Name of the Lambda package
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns The Lambda artifact configuration
 * @throws Error if the package doesn't exist or doesn't have a Lambda deployment
 */
export function getLambdaPackage(
  packageName: string,
  manifestName: string = 'latest'
): LambdaArtifactConfig {
  const pkg = getPackage(packageName, manifestName);

  if (!hasLambdaDeployment(pkg)) {
    const deployTypes = Object.keys(pkg).join(', ') || 'none';
    throw new Error(
      `Package '${packageName}' does not have a Lambda deployment (available: ${deployTypes})`
    );
  }

  return pkg.lambda;
}

/**
 * Get a container image package configuration from a version manifest.
 * @param packageName - Name of the container image package
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns The container artifact configuration
 * @throws Error if the package doesn't exist or doesn't have an image deployment
 */
export function getImagePackage(
  packageName: string,
  manifestName: string = 'latest'
): ContainerArtifactConfig {
  const pkg = getPackage(packageName, manifestName);

  if (!hasImageDeployment(pkg)) {
    const deployTypes = Object.keys(pkg).join(', ') || 'none';
    throw new Error(
      `Package '${packageName}' does not have an image deployment (available: ${deployTypes})`
    );
  }

  return pkg.image;
}

/**
 * List all package names in a version manifest.
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns Array of package names
 */
export function listPackages(manifestName: string = 'latest'): string[] {
  const manifest = loadVersionManifest(manifestName);
  return Object.keys(manifest.packages);
}

/**
 * List all available manifest files.
 * @returns Array of manifest names (without .json extension)
 */
export function listManifests(): string[] {
  if (!fs.existsSync(MANIFESTS_DIR)) {
    return [];
  }

  return fs
    .readdirSync(MANIFESTS_DIR)
    .filter((file: string) => file.endsWith('.json') && !file.endsWith('.schema.json'))
    .map((file: string) => file.replace('.json', ''));
}

/**
 * Get all deployment types for a package.
 * @param packageName - Name of the package
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns Array of deployment types ('lambda', 'image')
 */
export function getPackageDeploymentTypes(
  packageName: string,
  manifestName: string = 'latest'
): ('lambda' | 'image')[] {
  const pkg = getPackage(packageName, manifestName);
  const types: ('lambda' | 'image')[] = [];

  if (hasLambdaDeployment(pkg)) types.push('lambda');
  if (hasImageDeployment(pkg)) types.push('image');

  return types;
}

// Re-export types for convenience
export type {
  VersionManifest,
  Package,
  LambdaArtifactConfig,
  ContainerArtifactConfig,
} from './version-manifest.types';

export { hasLambdaDeployment, hasImageDeployment } from './version-manifest.types';
