/**
 * Schema definitions for the two-layer (Bronze -> Gold) financial data lake.
 *
 * Namespace layout:
 *
 * ```
 * s3tablescatalog
 * ├── bronze
 * │   ├── security_master               <- raw vendor security/identifier feeds
 * │   ├── fact_daily_ohlcv              <- raw pricing data, one row per vendor
 * │   ├── fact_corporate_actions        <- raw splits, dividends, M&A, IPO, delistings
 * │   └── fact_daily_metrics            <- raw shares outstanding, market cap, etc.
 * └── gold (WIP)
 * ```
 *
 * @see DATA_DESIGN.md for the full design rationale.
 */

import type { TableDefinition } from '../table-namespace-stack';

import {
  BRONZE_SECURITY_MASTER,
  BRONZE_FACT_DAILY_OHLCV,
  BRONZE_FACT_CORPORATE_ACTIONS,
  BRONZE_FACT_DAILY_METRICS,
} from './bronze-schemas';

// ---------------------------------------------------------------------------
// Pre-built table definition arrays for use with TableNamespaceStack
// ---------------------------------------------------------------------------

/**
 * All Bronze-layer table definitions.
 * Pass to a `TableNamespaceStack` with `namespaceName: 'bronze'`.
 */
export const BRONZE_TABLES: TableDefinition[] = [
  { tableName: 'security_master', schema: BRONZE_SECURITY_MASTER },
  { tableName: 'fact_daily_ohlcv', schema: BRONZE_FACT_DAILY_OHLCV },
  {
    tableName: 'fact_corporate_actions',
    schema: BRONZE_FACT_CORPORATE_ACTIONS,
  },
  { tableName: 'fact_daily_metrics', schema: BRONZE_FACT_DAILY_METRICS },
];
