/**
 * Declarative Iceberg schema definition types.
 *
 * These interfaces describe the desired schema, partition spec, and sort order
 * for an Iceberg table on S3 Tables.  They are serialised to JSON and passed to
 * the schema-manager Custom Resource Lambda which uses pyiceberg to reconcile
 * the actual table state with the desired definition.
 *
 * Type strings follow the Apache Iceberg specification:
 * @see https://iceberg.apache.org/spec/#primitive-types
 */

// ---------------------------------------------------------------------------
// Column definition
// ---------------------------------------------------------------------------

/**
 * A single column / field in an Iceberg schema.
 *
 * @example
 * { name: 'event_time', type: 'timestamptz', required: true, doc: 'When the event occurred' }
 * { name: 'tags', type: 'list<string>', doc: 'Arbitrary tags' }
 * { name: 'amount', type: 'decimal(12,2)', required: true }
 */
export interface IcebergColumn {
  /**
   * Column name.  Must be unique within the schema.
   */
  readonly name: string;

  /**
   * Iceberg type as a string.
   *
   * **Primitive types:**
   * `boolean`, `int`, `long`, `float`, `double`, `decimal(p,s)`,
   * `date`, `time`, `timestamp`, `timestamptz`, `string`, `uuid`,
   * `fixed(l)`, `binary`
   *
   * **Complex types:**
   * `list<element>`, `map<key,value>`
   */
  readonly type: string;

  /**
   * Whether the column is required (NOT NULL).
   * @default false - column is optional / nullable
   */
  readonly required?: boolean;

  /**
   * Human-readable documentation for this column.
   */
  readonly doc?: string;
}

// ---------------------------------------------------------------------------
// Partition specification
// ---------------------------------------------------------------------------

/**
 * A single partition field.
 *
 * @example
 * { sourceColumn: 'event_time', transform: 'day' }
 * { sourceColumn: 'user_id', transform: 'bucket[16]', name: 'user_bucket' }
 */
export interface IcebergPartitionField {
  /**
   * Name of the source column to partition on.
   */
  readonly sourceColumn: string;

  /**
   * Partition transform to apply.
   *
   * Supported values: `identity`, `year`, `month`, `day`, `hour`,
   * `bucket[N]`, `truncate[N]`, `void`
   */
  readonly transform: string;

  /**
   * Explicit name for the partition field.
   * @default derived from source column and transform
   */
  readonly name?: string;
}

// ---------------------------------------------------------------------------
// Sort order
// ---------------------------------------------------------------------------

/**
 * A single sort-order field.
 *
 * @example
 * { sourceColumn: 'event_time', direction: 'asc', nullOrder: 'nulls-last' }
 */
export interface IcebergSortField {
  /**
   * Name of the source column to sort on.
   */
  readonly sourceColumn: string;

  /**
   * Optional transform applied before sorting.
   * @default 'identity'
   */
  readonly transform?: string;

  /**
   * Sort direction.
   * @default 'asc'
   */
  readonly direction?: 'asc' | 'desc';

  /**
   * Where nulls are placed in the sort order.
   * @default 'nulls-last' for asc, 'nulls-first' for desc
   */
  readonly nullOrder?: 'nulls-first' | 'nulls-last';
}

// ---------------------------------------------------------------------------
// Top-level schema definition
// ---------------------------------------------------------------------------

/**
 * Complete declarative schema definition for an Iceberg table.
 *
 * Pass this to `TableNamespaceStack` - it will be serialised to JSON and handed
 * to the schema-manager Custom Resource Lambda for reconciliation.
 *
 * @example
 * const schema: IcebergSchemaDefinition = {
 *   columns: [
 *     { name: 'id', type: 'string', required: true, doc: 'Unique event identifier' },
 *     { name: 'event_time', type: 'timestamptz', required: true, doc: 'Event timestamp' },
 *     { name: 'payload', type: 'string', doc: 'JSON payload' },
 *   ],
 *   partitionSpec: [
 *     { sourceColumn: 'event_time', transform: 'day' },
 *   ],
 *   sortOrder: [
 *     { sourceColumn: 'event_time', direction: 'asc', nullOrder: 'nulls-last' },
 *   ],
 * };
 */
export interface IcebergSchemaDefinition {
  /**
   * Ordered list of columns that make up the Iceberg schema.
   */
  readonly columns: IcebergColumn[];

  /**
   * Partition specification.  Omit or pass an empty array for unpartitioned tables.
   * @default [] - no partitioning
   */
  readonly partitionSpec?: IcebergPartitionField[];

  /**
   * Sort order specification.  Omit or pass an empty array for unsorted tables.
   * @default [] - unsorted
   */
  readonly sortOrder?: IcebergSortField[];
}
