import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
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
      managedPolicies: [
        // AWS managed ReadOnlyAccess policy for ReadOnly access
        iam.ManagedPolicy.fromAwsManagedPolicyName('ReadOnlyAccess'),
      ],
    });

    this.role = readOnlyRole;

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
