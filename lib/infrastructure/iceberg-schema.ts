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

  /**
   * Name of a pre-existing column that this column was renamed *from*.
   *
   * When set, the table-manager issues a true Iceberg `rename_column` - which
   * preserves the field id and all existing data (and lets partition / sort
   * references follow automatically) - instead of dropping the old column and
   * adding a new, empty one.
   *
   * ⚠️ This is a **transient migration directive requiring TWO deploys**:
   *
   *  1. Deploy with `renamedFrom` set. The rename runs against every environment.
   *  2. Once every environment has deployed step 1, remove `renamedFrom` in a
   *     follow-up commit, leaving only the new `name`.
   *
   * ⚠️ Superseded pipelines make step 2 dangerous: under the default SUPERSEDED
   * execution mode (CDK Pipelines / CodePipeline), a quickly-merged deploy 2 can
   * leapfrog deploy 1 at a stage transition and hit a not-yet-renamed table with no
   * `renamedFrom` present - the reconciler then DROPS the old column (losing its
   * data) and adds an empty new one. Keep the directive until deploy 1 is confirmed
   * everywhere, and/or run the pipeline in QUEUED mode / gate the two deploys.
   *
   * The rename is idempotent and self-deactivating, so leaving it in place does
   * not re-run, inherently there's no downside leaving it unless you want to re-use
   * the old name.
   */
  readonly renamedFrom?: string;
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

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Validate a schema definition at synth time, throwing on invariant violations.
 *
 * The most important check guards the {@link IcebergColumn.renamedFrom}:
 * a rename directive is transient and must be removed once deployed everywhere.
 * If the old name is reintroduced as a live column while the directive still
 * points at it, the table-manager's rename pass would silently hijack that new
 * column - so we reject the collision here.
 *
 * @param schema - the schema definition to validate
 * @param tableName - used only to make error messages actionable
 * @throws Error if any invariant is violated
 */
export function validateSchemaDefinition(schema: IcebergSchemaDefinition, tableName: string): void {
  const errors: string[] = [];
  const columnNames = new Set(schema.columns.map((c) => c.name));

  const renameSources = schema.columns
    .filter((c): c is IcebergColumn & { renamedFrom: string } => c.renamedFrom !== undefined)
    .map((c) => c.renamedFrom);

  for (const src of renameSources) {
    if (columnNames.has(src)) {
      errors.push(
        `column 'renamedFrom' = '${src}' collides with a live column of the same name. ` +
          `A rename directive is transient: once the rename has deployed to every ` +
          `environment, remove 'renamedFrom' (second deploy) before reintroducing a ` +
          `column named '${src}'. Leaving it in place would make the table-manager ` +
          `rename (and empty) that column on the next deploy.`
      );
    }
  }

  // Two columns cannot both claim to be renamed from the same source.
  const seen = new Set<string>();
  for (const src of renameSources) {
    if (seen.has(src)) {
      errors.push(`multiple columns declare 'renamedFrom' = '${src}'`);
    }
    seen.add(src);
  }

  if (errors.length > 0) {
    throw new Error(
      `Invalid Iceberg schema for table '${tableName}':\n  - ${errors.join('\n  - ')}`
    );
  }
}
