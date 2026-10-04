import * as codebuild from 'aws-cdk-lib/aws-codebuild';
import * as pipelines from 'aws-cdk-lib/pipelines';

/**
 * Shared CodeBuild defaults for every CDK pipeline's synth.
 * Pins ARM Lambda compute on the Amazon Linux 2023 Node.js 22 image.
 * 15 minute cap is enough for us and we don't need Docker (not supported in this runtime).
 */
export const PIPELINE_CODEBUILD_DEFAULTS: pipelines.CodeBuildOptions = {
  buildEnvironment: {
    buildImage: codebuild.LinuxArmLambdaBuildImage.AMAZON_LINUX_2023_NODE_22,
    computeType: codebuild.ComputeType.LAMBDA_2GB,
  },
};

/** Synthesize from the code and configuration in the same source checkout. */
export const PIPELINE_SYNTH_OPTIONS = {
  commands: [
    'npm install -g pnpm',
    'pnpm install --frozen-lockfile',
    'pnpm run build',
    'pnpx cdk synth',
  ],
  primaryOutputDirectory: 'cdk.out',
};
