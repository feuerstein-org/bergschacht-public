/**
 * Version manifest loader utility.
 *
 * This module provides functions to load and access version manifest data
 * for deploying specific versions of Lambda functions and container images.
 * Repositories can contain multiple named artifacts of different types.
 *
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type {
  VersionManifest,
  Repository,
  LambdaArtifactConfig,
  ContainerArtifactConfig,
} from './version-manifest.types';
import { hasLambdaDeployment, hasImageDeployment } from './version-manifest.types';

/** Path to the version manifests directory */
const MANIFESTS_DIR = path.resolve(__dirname, '..', 'version-manifests');

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
 * Get a specific repository from a version manifest.
 * @param repoName - Name of the repository
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns The repository configuration
 * @throws Error if the repository doesn't exist in the manifest
 */
export function getRepository(repoName: string, manifestName: string = 'latest'): Repository {
  const manifest = loadVersionManifest(manifestName);
  const repo = manifest.repositories[repoName];

  if (!repo) {
    throw new Error(`Repository '${repoName}' not found in manifest '${manifestName}'`);
  }

  return repo;
}

/**
 * Get a named Lambda artifact from a repository.
 * @param repoName - Name of the repository
 * @param artifactName - Name of the Lambda artifact
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns The Lambda artifact configuration
 * @throws Error if the repository or artifact doesn't exist
 */
export function getLambdaArtifact(
  repoName: string,
  artifactName: string,
  manifestName: string = 'latest'
): LambdaArtifactConfig {
  const repo = getRepository(repoName, manifestName);

  const config = repo.lambdas?.[artifactName];
  if (!config) {
    const available = repo.lambdas ? Object.keys(repo.lambdas).join(', ') : 'none';
    throw new Error(
      `Lambda artifact '${artifactName}' not found in repository '${repoName}' (available: ${available})`
    );
  }

  return config;
}

/**
 * Get a named container image artifact from a repository.
 * @param repoName - Name of the repository
 * @param artifactName - Name of the image artifact
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns The container artifact configuration
 * @throws Error if the repository or artifact doesn't exist
 */
export function getImageArtifact(
  repoName: string,
  artifactName: string,
  manifestName: string = 'latest'
): ContainerArtifactConfig {
  const repo = getRepository(repoName, manifestName);

  const config = repo.images?.[artifactName];
  if (!config) {
    const available = repo.images ? Object.keys(repo.images).join(', ') : 'none';
    throw new Error(
      `Image artifact '${artifactName}' not found in repository '${repoName}' (available: ${available})`
    );
  }

  return config;
}

/**
 * List all repository names in a version manifest.
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns Array of repository names
 */
export function listRepositories(manifestName: string = 'latest'): string[] {
  const manifest = loadVersionManifest(manifestName);
  return Object.keys(manifest.repositories);
}

/**
 * List all Lambda artifact names for a repository.
 * @param repoName - Name of the repository
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns Array of Lambda artifact names
 */
export function listLambdaArtifacts(repoName: string, manifestName: string = 'latest'): string[] {
  const repo = getRepository(repoName, manifestName);
  return Object.keys(repo.lambdas ?? {});
}

/**
 * List all image artifact names for a repository.
 * @param repoName - Name of the repository
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns Array of image artifact names
 */
export function listImageArtifacts(repoName: string, manifestName: string = 'latest'): string[] {
  const repo = getRepository(repoName, manifestName);
  return Object.keys(repo.images ?? {});
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
 * Get all deployment types for a repository.
 * @param repoName - Name of the repository
 * @param manifestName - Name of the manifest file, defaults to 'latest'
 * @returns Array of deployment types ('lambda', 'image')
 */
export function getRepositoryDeploymentTypes(
  repoName: string,
  manifestName: string = 'latest'
): ('lambda' | 'image')[] {
  const repo = getRepository(repoName, manifestName);
  const types: ('lambda' | 'image')[] = [];

  if (hasLambdaDeployment(repo)) types.push('lambda');
  if (hasImageDeployment(repo)) types.push('image');

  return types;
}

// Re-export types for convenience
export type {
  VersionManifest,
  Repository,
  LambdaArtifactConfig,
  ContainerArtifactConfig,
} from './version-manifest.types';

export { hasLambdaDeployment, hasImageDeployment } from './version-manifest.types';
