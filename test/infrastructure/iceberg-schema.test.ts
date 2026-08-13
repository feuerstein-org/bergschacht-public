import { validateSchemaDefinition } from '../../lib/infrastructure/iceberg-schema.ts';
import type { IcebergSchemaDefinition } from '../../lib/infrastructure/iceberg-schema.ts';

describe('validateSchemaDefinition', () => {
  test('accepts a plain schema with no rename directives', () => {
    const schema: IcebergSchemaDefinition = {
      columns: [
        { name: 'id', type: 'string', required: true },
        { name: 'amount', type: 'decimal(18,6)' },
      ],
    };
    expect(() => validateSchemaDefinition(schema, 'my_table')).not.toThrow();
  });

  test('accepts a valid rename (old name absent, new name present)', () => {
    const schema: IcebergSchemaDefinition = {
      columns: [{ name: 'vendor_record_id', type: 'string', renamedFrom: 'entity_id' }],
    };
    expect(() => validateSchemaDefinition(schema, 'my_table')).not.toThrow();
  });

  test('throws when a reintroduced column collides with a live renamedFrom', () => {
    const schema: IcebergSchemaDefinition = {
      columns: [
        { name: 'vendor_record_id', type: 'string', renamedFrom: 'entity_id' },
        // entity_id reintroduced while the rename directive still points at it
        { name: 'entity_id', type: 'string' },
      ],
    };
    expect(() => validateSchemaDefinition(schema, 'my_table')).toThrow(
      /collides with a live column/
    );
  });

  test('throws when a column renames from itself', () => {
    const schema: IcebergSchemaDefinition = {
      columns: [{ name: 'entity_id', type: 'string', renamedFrom: 'entity_id' }],
    };
    expect(() => validateSchemaDefinition(schema, 'my_table')).toThrow(
      /collides with a live column/
    );
  });

  test('throws when two columns rename from the same source', () => {
    const schema: IcebergSchemaDefinition = {
      columns: [
        { name: 'a', type: 'string', renamedFrom: 'old' },
        { name: 'b', type: 'string', renamedFrom: 'old' },
      ],
    };
    expect(() => validateSchemaDefinition(schema, 'my_table')).toThrow(/multiple columns declare/i);
  });

  test('error message names the offending table', () => {
    const schema: IcebergSchemaDefinition = {
      columns: [
        { name: 'vendor_record_id', type: 'string', renamedFrom: 'entity_id' },
        { name: 'entity_id', type: 'string' },
      ],
    };
    expect(() => validateSchemaDefinition(schema, 'bronze_security_master')).toThrow(
      /bronze_security_master/
    );
  });
});
