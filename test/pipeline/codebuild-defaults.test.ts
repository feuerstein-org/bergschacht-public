import { PIPELINE_CODEBUILD_DEFAULTS } from '../../lib/pipeline/codebuild-defaults';

describe('PIPELINE_CODEBUILD_DEFAULTS', () => {
  test('pins ARM Lambda compute on the Node.js 22 image', () => {
    const env = PIPELINE_CODEBUILD_DEFAULTS.buildEnvironment;
    expect(env?.buildImage?.imageId).toBe(
      'aws/codebuild/amazonlinux-aarch64-lambda-standard:nodejs22'
    );
    expect(env?.buildImage?.type).toBe('ARM_LAMBDA_CONTAINER');
    expect(env?.computeType).toBe('BUILD_LAMBDA_2GB');
  });
});
