import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import { Construct } from 'constructs';

export interface ReadOnlyRoleStackProps extends cdk.StackProps {
  /**
   * ARNs of trusted principals that can assume this role (accounts, roles, users, etc.)
   * @example ['arn:aws:iam::123456789012:root', 'arn:aws:iam::987654321098:user/SomeUser']
   */
  readonly trustedArns: string[];
}

/**
 * CDK Stack that creates a ReadOnly IAM role in an account.
 *
 * This role can be assumed by trusted ARNs to
 * perform read-only operations for inspection, monitoring, or validation.
 */
export class ReadOnlyRoleStack extends cdk.Stack {
  public readonly role: iam.IRole;

  constructor(scope: Construct, id: string, props: ReadOnlyRoleStackProps) {
    super(scope, id, props);

    const compositePrincipal = new iam.CompositePrincipal(
      ...props.trustedArns.map((arn) => new iam.ArnPrincipal(arn))
    );

    // Create the ReadOnly role
    const readOnlyRole = new iam.Role(this, 'ReadOnlyRole', {
      roleName: 'ReadOnly',
      description: 'Read-only access role for monitoring and inspection',
      assumedBy: compositePrincipal,
      managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess')],
    });

    cdk.Annotations.of(readOnlyRole).acknowledgeWarning(
      '@aws-cdk/core:addConstructMetadataFailed',
      'Metadata warning from fromAwsManagedPolicyName is expected and harmless'
    );

    this.role = readOnlyRole;

    // Suppress CDK Nag warnings for AWS managed policy
    // The ReadOnlyAccess policy is intentionally used for broad read access
    NagSuppressions.addResourceSuppressions(
      readOnlyRole,
      [
        {
          id: 'AwsSolutions-IAM4',
          reason:
            'AWS managed ReadOnlyAccess policy is intentionally used to provide broad read-only access for monitoring and inspection purposes.',
          appliesTo: ['Policy::arn:<AWS::Partition>:iam::aws:policy/ReadOnlyAccess'],
        },
      ],
      true
    );

    // Output the role ARN for reference
    new cdk.CfnOutput(this, 'ReadOnlyRoleArn', {
      value: readOnlyRole.roleArn,
      description: 'ARN of the ReadOnly IAM role',
      exportName: `${id}-RoleArn`,
    });

    // Output trusted ARNs
    new cdk.CfnOutput(this, 'TrustedArns', {
      value: props.trustedArns.join(', '),
      description: 'ARNs of principals trusted to assume this role',
      exportName: `${id}-TrustedArns`,
    });
  }
}
