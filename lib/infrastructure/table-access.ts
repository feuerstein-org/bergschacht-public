import * as cdk from 'aws-cdk-lib/core';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3tables from '@aws-cdk/aws-s3tables-alpha';

/**
 * The S3 Tables namespace a workload writes to: the bucket plus the tables to scope the grant to.
 * {@link TableNamespaceStack} satisfies this structurally, so callers just pass the namespace stack.
 */
export interface BronzeTableNamespace {
  /** Namespace name. */
  readonly namespaceName: string;
  /** Table bucket the namespace lives in. */
  readonly tableBucket: s3tables.ITableBucket;
  /** The namespace's tables, keyed by name; only their ARNs are read here. */
  readonly tables: ReadonlyMap<string, { readonly tableArn: string }>;
}

/**
 * Grant read/write on every table in *namespace* to *grantee*. S3 Tables has no namespace-level
 * resource, so this scopes per-table: the table id is the segment after `/table/` in each table ARN.
 * Throws if the namespace has no tables.
 */
export function grantTableAccess(grantee: iam.IGrantable, namespace: BronzeTableNamespace): void {
  const tableArns = Array.from(namespace.tables.values(), (t) => t.tableArn);
  if (tableArns.length === 0) {
    throw new Error(
      `Provided S3 Tables namespace has no tables to grant access to: ${namespace.namespaceName}`
    );
  }
  for (const arn of tableArns) {
    namespace.tableBucket.grantReadWrite(grantee, cdk.Fn.select(1, cdk.Fn.split('/table/', arn)));
  }
}
