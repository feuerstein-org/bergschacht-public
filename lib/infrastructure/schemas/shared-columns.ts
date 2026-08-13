/**
 * Shared column groups used across multiple Iceberg schema definitions.
 *
 * Centralising these prevents drift between tables that should carry
 * identical provenance, SCD2, resolution, or identifier columns.
 *
 * Usage:
 * ```ts
 * columns: [
 *   ...BRONZE_PROVENANCE_COLUMNS,
 *   // table-specific columns …
 * ]
 * ```
 */

import type { IcebergColumn } from '../iceberg-schema.ts';

// ═══════════════════════════════════════════════════════════════════════════
//  BRONZE LAYER - shared column groups
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Common vendor provenance columns appended to every bronze table.
 * `record_hash` is NOT included here - it is defined per-table to document exactly which columns are excluded.
 */
export const BRONZE_PROVENANCE_COLUMNS: readonly IcebergColumn[] = [
  {
    name: 'ingested_at',
    type: 'timestamptz',
    required: true,
    doc: 'Timestamp when the pipeline ingested this record',
  },
  {
    name: 'vendor_as_of_ts',
    type: 'timestamptz',
    doc: 'When the vendor claims this data was accurate',
  },
  {
    name: 'pipeline_run_id',
    type: 'string',
    doc: 'FK to pipeline execution log.',
  },

  // { name: 'is_correction', type: 'boolean', doc: 'Whether this record corrects a previously ingested row' },
] as const;

/**
 * Unresolved vendor identifier columns used in bronze fact tables
 * (pricing, corporate actions, earnings, financials).
 */
export const BRONZE_VENDOR_IDENTIFIER_COLUMNS: readonly IcebergColumn[] = [
  { name: 'ticker', type: 'string', doc: 'Ticker symbol as reported by vendor' },
  { name: 'composite_figi', type: 'string', doc: 'Composite FIGI as reported by vendor' },
] as const;

// ===========

/**
 * Fiscal period columns shared across bronze financial statement tables
 * and earnings announcements.
 */
export const BRONZE_FISCAL_PERIOD_COLUMNS: readonly IcebergColumn[] = [
  { name: 'fiscal_year', type: 'int', required: true, doc: 'Fiscal year' },
  { name: 'fiscal_quarter', type: 'int', doc: '0 = annual, 1-4 = quarterly' },
  { name: 'fiscal_period_end_date', type: 'date', doc: 'End of the fiscal period' },
] as const;

// TODO: Is this needed?
/**
 * Financial statement metadata columns shared across bronze income statement,
 * balance sheet, and cash flow tables.
 */
export const BRONZE_FINANCIAL_STATEMENT_META_COLUMNS: readonly IcebergColumn[] = [
  { name: 'period_type', type: 'string', doc: 'ANNUAL, QUARTERLY, TTM' },
  { name: 'report_date', type: 'date', doc: 'Date this was filed/made public (PIT critical)' },
  { name: 'currency', type: 'string', doc: 'Reporting currency (ISO 4217)' },
  { name: 'scale', type: 'string', doc: 'THOUSANDS, MILLIONS, ACTUAL' },
] as const;

// ═══════════════════════════════════════════════════════════════════════════
//  GOLD LAYER - shared column groups
// ═══════════════════════════════════════════════════════════════════════════

/**
 * SCD Type 2 lifecycle columns for all gold dimension tables.
 */
export const GOLD_SCD2_COLUMNS: readonly IcebergColumn[] = [
  {
    name: 'effective_from',
    type: 'timestamptz',
    required: true,
    doc: 'Start of validity period for this version',
  },
  {
    name: 'effective_to',
    type: 'timestamptz',
    doc: 'End of validity period (NULL = currently active)',
  },
  {
    name: 'is_current',
    type: 'boolean',
    required: true,
    doc: 'Whether this is the active version of the record',
  },
  {
    name: 'record_hash',
    type: 'string',
    doc: 'SHA-256 hash of mutable fields for change detection',
  },
] as const;

/**
 * Fiscal period columns shared across gold financial statement tables
 * and earnings announcements.
 */
export const GOLD_FISCAL_PERIOD_COLUMNS: readonly IcebergColumn[] = [
  { name: 'fiscal_year', type: 'int', required: true, doc: 'Fiscal year' },
  { name: 'fiscal_quarter', type: 'int', doc: '0 = annual, 1-4 = quarterly' },
  { name: 'fiscal_period_end_date', type: 'date', doc: 'End of the fiscal period' },
] as const;

/**
 * Point-in-time restatement tracking columns shared across gold financial
 * statement tables (income statement, balance sheet, cash flow).
 */
export const GOLD_RESTATEMENT_COLUMNS: readonly IcebergColumn[] = [
  { name: 'report_date', type: 'date', doc: 'Date this was filed/made public' },
  { name: 'revision_seq', type: 'int', doc: '0 = original filing, 1+ = restatement' },
  {
    name: 'is_latest_revision',
    type: 'boolean',
    doc: 'Convenience flag for the most recent version',
  },
  { name: 'currency', type: 'string', doc: 'Reporting currency (ISO 4217)' },
  { name: 'scale', type: 'string', doc: 'THOUSANDS, MILLIONS, ACTUAL' },
] as const;
