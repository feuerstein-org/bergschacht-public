import * as fs from 'node:fs';
import * as cdk from 'aws-cdk-lib/core';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import {
  getLambdaArtifact,
  getImageArtifact,
  getContainerImage,
  getLambdaDockerImageCode,
  VERSION_MANIFEST_PATH,
  type VersionManifest,
  _resetManifestCache,
  _loadManifestFromData,
} from '../../lib/config/version-manifest.ts';

/**
 * Manifest contents used across tests. Mirrors version-manifests/latest.json.
 */
const MANIFEST: VersionManifest = {
  schemaVersion: '1.0.0',
  repositories: {
    // order-processor - lambda only
    'order-processor': {
      source: 'feuerstein-org/order-processor',
      lambdas: {
        'order-processor': {
          latest: {
            bucket: 'my-artifacts-bucket',
            key: 'lambdas/order-processor/v1.2.3.zip',
            objectVersion: 'abc123VersionId',
            version: '1.2.3',
            commitSha: 'abc1234',
          },
        },
      },
    },

    // payment-service - image only
    'payment-service': {
      source: 'feuerstein-org/payment-service',
      images: {
        'payment-service': {
          latest: {
            repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/payment-service',
            imageTag: 'v2.0.1',
            version: '2.0.1',
            commitSha: '789abcd',
          },
        },
      },
    },

    // pinned-service - pinned at 1.0.0 while 2.0.0 is the latest published
    'pinned-service': {
      source: 'feuerstein-org/pinned-service',
      images: {
        api: {
          latest: {
            repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/pinned-service',
            imageTag: 'api-2.0.0',
            version: '2.0.0',
            commitSha: 'bbbb222',
          },
          pinned: {
            repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/pinned-service',
            imageTag: 'api-1.0.0',
            version: '1.0.0',
            commitSha: 'aaaa111',
          },
          pinReason: '2.0.0 breaks the frobnicator, see incident 42',
        },
      },
    },

    // multi-artifact-service - multiple images + one lambda
    'multi-artifact-service': {
      source: 'feuerstein-org/multi-artifact-service',
      images: {
        worker: {
          latest: {
            repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/multi-artifact-service',
            imageTag: 'worker-1.0.0',
            version: '1.0.0',
            commitSha: 'cafe1234',
          },
        },
        api: {
          latest: {
            repository: '123456789012.dkr.ecr.us-east-1.amazonaws.com/multi-artifact-service',
            imageTag: 'api-1.0.0',
            version: '1.0.0',
            commitSha: 'cafe1234',
          },
        },
      },
      lambdas: {
        webhook: {
          latest: {
            bucket: 'my-artifacts-bucket',
            key: 'lambdas/multi-artifact-service/webhook-1.0.0.zip',
            objectVersion: 'cafe1234VersionId',
            version: '1.0.0',
            commitSha: 'cafe1234',
          },
        },
      },
    },
  },
};

beforeEach(() => {
  _resetManifestCache();
  _loadManifestFromData(MANIFEST);
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

describe('pinned entries', () => {
  test('resolves the pinned block, not the newer latest', () => {
    const config = getImageArtifact('pinned-service', 'api');

    expect(config.version).toBe('1.0.0');
    expect(config.imageTag).toBe('api-1.0.0');
    expect(config.commitSha).toBe('aaaa111');
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

describe('getContainerImage', () => {
  test('emits an ECR image reference and grants the execution role pull permissions', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Test', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const artifact = getImageArtifact('payment-service', 'payment-service');
    const taskDef = new ecs.FargateTaskDefinition(stack, 'TaskDef');
    taskDef.addContainer('app', {
      image: getContainerImage(stack, 'PaymentRepo', artifact),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::ECS::TaskDefinition', {
      ContainerDefinitions: Match.arrayWith([
        Match.objectLike({
          Image: {
            'Fn::Join': Match.arrayWith([
              Match.arrayWith([Match.stringLikeRegexp('/payment-service:v2\\.0\\.1$')]),
            ]),
          },
        }),
      ]),
    });
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: {
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: Match.arrayWith([
              'ecr:BatchCheckLayerAvailability',
              'ecr:GetDownloadUrlForLayer',
              'ecr:BatchGetImage',
            ]),
            Resource: 'arn:aws:ecr:us-east-1:123456789012:repository/payment-service',
          }),
        ]),
      },
    });
  });

  test('throws when the repository URI is not a recognizable ECR URI', () => {
    const stack = new cdk.Stack();
    expect(() =>
      getContainerImage(stack, 'BadRepo', {
        repository: 'docker.io/library/nginx',
        imageTag: 'latest',
        version: '0.0.0',
        commitSha: 'abc1234',
      })
    ).toThrow(/Unrecognized ECR repository URI/);
  });
});

describe('getLambdaDockerImageCode', () => {
  test('builds container-image Lambda code referencing the ECR repository and image tag', () => {
    const app = new cdk.App();
    const stack = new cdk.Stack(app, 'Test', {
      env: { account: '111111111111', region: 'us-east-1' },
    });
    const artifact = getImageArtifact('payment-service', 'payment-service');
    new lambda.DockerImageFunction(stack, 'Fn', {
      code: getLambdaDockerImageCode(stack, 'PaymentRepo', artifact),
    });

    const template = Template.fromStack(stack);
    template.hasResourceProperties('AWS::Lambda::Function', {
      PackageType: 'Image',
      Code: {
        ImageUri: {
          'Fn::Join': Match.arrayWith([
            Match.arrayWith([Match.stringLikeRegexp('/payment-service:v2\\.0\\.1$')]),
          ]),
        },
      },
    });
  });

  test('throws when the repository URI is not a recognizable ECR URI', () => {
    const stack = new cdk.Stack();
    expect(() =>
      getLambdaDockerImageCode(stack, 'BadRepo', {
        repository: 'docker.io/library/nginx',
        imageTag: 'latest',
        version: '0.0.0',
        commitSha: 'abc1234',
      })
    ).toThrow(/Unrecognized ECR repository URI/);
  });
});

describe('committed manifest file', () => {
  test('loads from disk and every entry has a latest artifact', () => {
    const manifest = JSON.parse(fs.readFileSync(VERSION_MANIFEST_PATH, 'utf-8')) as VersionManifest;

    expect(manifest.schemaVersion).toBe('1.0.0');
    const repos = Object.entries(manifest.repositories);
    expect(repos.length).toBeGreaterThan(0);

    for (const [repoName, repo] of repos) {
      expect(repo.source).toBe(`feuerstein-org/${repoName}`);
      const entries = [...Object.values(repo.images ?? {}), ...Object.values(repo.lambdas ?? {})];
      expect(entries.length).toBeGreaterThan(0);
      for (const entry of entries) {
        expect(entry.latest.version).toMatch(/^\d+\.\d+\.\d+$/);
        if (entry.pinned) {
          expect(entry.pinned.version).toMatch(/^\d+\.\d+\.\d+$/);
        }
      }
    }
  });
});

describe('error handling', () => {
  test('throws when artifact is not in the manifest', () => {
    expect(() => getLambdaArtifact('nonexistent-repo', 'nonexistent')).toThrow(
      /nonexistent-repo\/lambdas\/nonexistent.*not found/
    );
  });
});
