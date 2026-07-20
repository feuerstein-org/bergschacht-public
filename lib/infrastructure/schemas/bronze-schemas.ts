/**
 * Bronze-layer Iceberg schema definitions.
 *
 * Bronze stores per-vendor data conformed to a standard schema: append-only,
 * with full provenance. Records are typecast, deduplicated, and lightly
 * normalized *within* each vendor (e.g. enum canonicalization, unadjusted-price
 * derivation) but identifiers remain vendor-native and unresolved - cross-vendor
 * reconciliation (identifier resolution, dedup across vendors, conflict
 * detection, SCD2) happens in gold. Each vendor stays separate here, which is
 * what keeps this a bronze layer rather than a conformed silver one.
 *
 * Ingestion uses change-detected append: existing and incoming rows are merged
 * into a per-key timeline ordered by an `as_of` column (see DATA_DESIGN.md)
 * and a new row is only written when its `record_hash`
 * differs from the immediately preceding version on that timeline.
 * `record_hash` excludes provenance columns, exact exclusions are documented
 * per-table. This also handles deduplication - some vendors deliver the same
 * record multiple times, so we avoid re-ingesting it over and over. Only SCD2
 * tables have a record hash.
 *
 * All bronze tables share:
 *  - {@link BRONZE_PROVENANCE_COLUMNS} - ingestion metadata
 *  - {@link BRONZE_VENDOR_IDENTIFIER_COLUMNS} - unresolved vendor identifiers (fact tables)
 */

import type { IcebergSchemaDefinition } from '../iceberg-schema';
import { BRONZE_PROVENANCE_COLUMNS, BRONZE_VENDOR_IDENTIFIER_COLUMNS } from './shared-columns';

/**
 * Precision 18 keeps the column in Parquet's 8-byte INT64 encoding (19 would use more storage)
 * We can still widen the type by using a bigger precision (can't widen the scale) later if required.
 * E.g. use 'decimal(22,6)'

 * Default for Decimal columns in general, however some columns like market cap deviate
 */
const BRONZE_DECIMAL_TYPE = 'decimal(18,6)';

// ---------------------------------------------------------------------------
// bronze.security_master
// ---------------------------------------------------------------------------

/**
 * Raw vendor reference/identifier feeds.
 *
 * Stores the vendor's view of entities, instruments, and listings exactly as
 * delivered.  Identifiers are unresolved - `ticker`, `isin` etc.
 * are the vendor's own values and may disagree across vendors.
 *
 * Partitioned by `source_vendor` (identity) and `snapshot_date` (month).
 */
export const BRONZE_SECURITY_MASTER: IcebergSchemaDefinition = {
  columns: [
    // Vendor provenance
    {
      name: 'source_vendor',
      type: 'string',
      required: true,
      doc: "Data vendor name, e.g. 'OPENFIGI', 'REFINITIV', 'BLOOMBERG'",
    },
    {
      name: 'vendor_record_id',
      type: 'string',
      renamedFrom: 'entity_id',
      doc: "Vendor's own stable per-security identifier (e.g. Sharadar `permaticker`).",
    },
    {
      name: 'snapshot_date',
      type: 'date',
      required: true,
      doc: "Observation cycle this row belongs to - the vendor's as-of view of the universe on this date.",
    },

    // Entity-level
    { name: 'entity_name', type: 'string', doc: 'Entity name' },
    { name: 'lei', type: 'string', doc: 'Legal Entity Identifier' },
    { name: 'cik', type: 'string', doc: 'SEC CIK number' },
    // { name: 'mgecs_code', type: 'string', doc: 'Morningstar Global Equity Classification code' },
    { name: 'sic_code', type: 'string', doc: 'SIC code' },
    {
      name: 'reporting_currency',
      type: 'string',
      doc: "Company's functional reporting currency for financial statements (ISO 4217).",
    },

    // Instrument-level
    { name: 'cusip', type: 'string', doc: 'Primary/current CUSIP for this instrument' },
    // { name: 'isin', type: 'string', doc: 'ISIN' },
    {
      name: 'cusip_history',
      type: 'list<string>',
      doc: 'All CUSIPs ever associated with this instrument (full history, includes the current one). Entity-level rollups across share classes are a gold-layer derivation, not stored here.',
    },
    { name: 'share_class_figi', type: 'string', doc: 'Bloomberg Share Class FIGI' },
    {
      name: 'instrument_type',
      type: 'string',
      doc: "Raw instrument type, e.g. 'Domestic Common Stock', 'CS', 'ADR Preferred Stock'",
    },
    {
      name: 'instrument_description',
      type: 'string',
      doc: 'Human-readable instrument description',
    },
    { name: 'related_tickers', type: 'list<string>', doc: 'Related tickers' },

    // Listing-level
    { name: 'ticker', type: 'string', doc: 'Ticker symbol' },
    { name: 'figi', type: 'string', doc: 'Exchange-level FIGI' },
    { name: 'composite_figi', type: 'string', doc: 'Bloomberg Composite FIGI' },
    { name: 'operating_mic', type: 'string', doc: 'Operating MIC (ISO 10383)' },
    { name: 'trading_currency', type: 'string', doc: 'Trading currency of the listing (ISO 4217)' },
    { name: 'listing_status', type: 'string', doc: "Listing status, e.g. 'ACTIVE', 'DELISTED'" },
    { name: 'round_lot', type: 'int', doc: 'Round lot size' },
    {
      name: 'hq_location',
      type: 'string',
      renamedFrom: 'location',
      doc: 'HQ location (e.g. California; U.S.A)',
    },
    { name: 'company_website', type: 'string', doc: 'Company website URL' },

    // Provenance
    {
      name: 'record_hash',
      type: 'string',
      doc: 'SHA-256 of all content columns, excludes snapshot_date and provenance columns',
    },
    ...BRONZE_PROVENANCE_COLUMNS,
  ],
  partitionSpec: [
    { sourceColumn: 'source_vendor', transform: 'identity' },
    { sourceColumn: 'snapshot_date', transform: 'month', name: 'snapshot_month' },
  ],
  // Key-first, date-second: reads are per-key SCD timelines (ingestion's
  // existing-rows scan filters on vendor_record_id, gold builds per-key
  // histories), never date-range scans.
  sortOrder: [
    { sourceColumn: 'vendor_record_id', direction: 'asc', nullOrder: 'nulls-last' },
    { sourceColumn: 'snapshot_date', direction: 'asc', nullOrder: 'nulls-last' },
  ],
};

// ---------------------------------------------------------------------------
// bronze.fact_daily_ohlcv
// ---------------------------------------------------------------------------

/**
 * Raw daily OHLCV pricing data as delivered by each vendor.
 *
 * Multiple rows per (price_date, listing identifier) are expected - one per
 * vendor.  Identifier resolution happens in the bronze -> gold pipeline.
 *
 * All prices and volume are unadjusted. Vendors that deliver split-adjusted data
 * are converted to unadjusted at ingestion time (if possible).
 *
 * Partitioned by `source_vendor` (identity) and `price_date` (month).
 */
export const BRONZE_FACT_DAILY_OHLCV: IcebergSchemaDefinition = {
  columns: [
    {
      name: 'source_vendor',
      type: 'string',
      required: true,
      doc: "Data vendor, e.g. 'IEX', 'POLYGON', 'EODHD'",
    },

    // Unresolved vendor identifiers
    ...BRONZE_VENDOR_IDENTIFIER_COLUMNS,

    // Price data - unadjusted (immutable, never change retroactively)
    { name: 'price_date', type: 'date', required: true, doc: 'Trading date' },
    { name: 'open', type: BRONZE_DECIMAL_TYPE, doc: 'Opening price' },
    { name: 'high', type: BRONZE_DECIMAL_TYPE, doc: 'Highest price during session' },
    { name: 'low', type: BRONZE_DECIMAL_TYPE, doc: 'Lowest price during session' },
    { name: 'close', type: BRONZE_DECIMAL_TYPE, doc: 'Closing price' },
    { name: 'volume', type: 'long', doc: 'Trading volume' },
    { name: 'currency', type: 'string', doc: 'Price currency (ISO 4217)' },

    // Provenance
    ...BRONZE_PROVENANCE_COLUMNS,
  ],
  partitionSpec: [
    { sourceColumn: 'source_vendor', transform: 'identity' },
    { sourceColumn: 'price_date', transform: 'month', name: 'price_month' },
  ],
  // Key-first, date-second: gold reads one ticker's month at a time (per-ticker
  // cross-vendor comparison), so clustering by ticker makes that one contiguous run per file.
  // Bonus: ticker RLE-encodes to almost nothing and consecutive prices of one
  // ticker compress far better than interleaved tickers.
  sortOrder: [
    { sourceColumn: 'ticker', direction: 'asc', nullOrder: 'nulls-last' },
    { sourceColumn: 'price_date', direction: 'asc', nullOrder: 'nulls-last' },
  ],
};

// ---------------------------------------------------------------------------
// bronze.fact_corporate_actions
// ---------------------------------------------------------------------------

/**
 * Raw corporate action events as delivered by each vendor.
 *
 * All action types (splits, dividends, M&A, IPO, delistings, etc.) live in
 * one table.  Type-specific fields are nullable - Parquet stores nulls with
 * near-zero overhead.
 *
 * Partitioned by `source_vendor` (identity) and `effective_date` (month).
 */
export const BRONZE_FACT_CORPORATE_ACTIONS: IcebergSchemaDefinition = {
  columns: [
    { name: 'source_vendor', type: 'string', required: true, doc: 'Data vendor name' },
    { name: 'action_id', type: 'string', doc: "Vendor's own ID for this action (deduplication)" },
    {
      name: 'vendor_record_id',
      type: 'string',
      renamedFrom: 'entity_id',
      doc: "Vendor's stable per-security key - used for identifying the instrument if the vendor inconsistently changes the ticker symbol.",
    },

    // Unresolved vendor identifiers
    ...BRONZE_VENDOR_IDENTIFIER_COLUMNS,

    // Action classification
    {
      name: 'action_type',
      type: 'string',
      required: true,
      doc: 'SPLIT, REVERSE_SPLIT, CASH_DIVIDEND, STOCK_DIVIDEND, SPECIAL_DIVIDEND, MERGER, ACQUISITION, SPINOFF, IPO, DIRECT_LISTING, LISTING, DELISTING, BANKRUPTCY, TICKER_CHANGE',
    },
    {
      name: 'raw_action_type',
      type: 'string',
      doc: "Vendor's original action classification before normalisation",
    },

    // Common dates
    { name: 'effective_date', type: 'date', required: true, doc: 'Date the action took effect' },
    { name: 'record_date', type: 'date', doc: 'Record date for eligibility' },
    { name: 'pay_date', type: 'date', doc: 'Payment date (for dividends)' },

    // Split / Reverse split fields
    {
      name: 'split_ratio',
      type: BRONZE_DECIMAL_TYPE,
      doc: 'Computed split ratio: split_to / split_from; >1 = split, <1 = reverse split',
    },

    // Dividend fields
    { name: 'dividend_amount', type: BRONZE_DECIMAL_TYPE, doc: 'Dividend amount per share' },
    { name: 'dividend_currency', type: 'string', doc: 'Dividend currency (ISO 4217)' },

    {
      name: 'dividend_frequency',
      type: 'int',
      doc: 'Payouts in a year, 2 = semi-annual, 4 = quarterly, 12 = monthly etc.',
    },

    // Counterparty fields (M&A, spinoff)
    {
      name: 'related_ticker',
      type: 'string',
      doc: 'The acquirer (ACQUISITION), the surviving company (MERGER), the spun-off entity (SPINOFF) or the name when the company was listed (LISTING). ',
    },
    { name: 'related_name', type: 'string', doc: 'Related entity name (see related_ticker)' },

    // Spinoff fields
    {
      name: 'distribution_ratio',
      type: BRONZE_DECIMAL_TYPE,
      doc: 'Shares of the spunoff entity distributed per share of the parent. NOT a price-adjustment factor - the parent price drop depends on the spunoff entity price.',
    },
    {
      name: 'distribution_value',
      type: BRONZE_DECIMAL_TYPE,
      doc: 'USD/share dollar value of the spunoff shares distributed per share of the parent - the same spinoff event valued in dollars rather than as a share ratio.',
    },

    // IPO fields
    { name: 'ipo_offer_price', type: BRONZE_DECIMAL_TYPE, doc: 'IPO offer price per share' },
    {
      name: 'ipo_price_range_low',
      type: BRONZE_DECIMAL_TYPE,
      doc: 'Lowest offering price in the IPO range',
    },
    {
      name: 'ipo_price_range_high',
      type: BRONZE_DECIMAL_TYPE,
      doc: 'Highest offering price in the IPO range',
    },
    { name: 'ipo_price_currency', type: 'string', doc: 'IPO price currency' },
    { name: 'ipo_shares_offered', type: 'long', doc: 'Number of shares offered in the IPO' },
    { name: 'ipo_exchange_mic', type: 'string', doc: 'Exchange MIC where the IPO listed' },
    {
      name: 'ipo_security_type',
      type: 'string',
      doc: "Security type as reported by vendor (e.g. 'CS', 'ADRC')",
    },

    // Ticker / Name change fields
    { name: 'change_old_value', type: 'string', doc: 'Previous value for TICKER_CHANGE actions' },
    { name: 'change_new_value', type: 'string', doc: 'New value for TICKER_CHANGE actions' },

    // Provenance
    {
      name: 'record_hash',
      type: 'string',
      doc: 'SHA-256 of all content columns, excludes provenance columns. Connectors whose vendor retroactively relabels `ticker` to the current symbol (e.g. Sharadar) additionally exclude `ticker`.',
    },
    ...BRONZE_PROVENANCE_COLUMNS,
  ],
  partitionSpec: [
    { sourceColumn: 'source_vendor', transform: 'identity' },
    { sourceColumn: 'effective_date', transform: 'month', name: 'effective_month' },
  ],
  // Key-first: clusters each security's event history, effective_date/action_type keep
  // a key's events in timeline order within a file.
  sortOrder: [
    { sourceColumn: 'vendor_record_id', direction: 'asc', nullOrder: 'nulls-last' },
    { sourceColumn: 'effective_date', direction: 'asc', nullOrder: 'nulls-last' },
    { sourceColumn: 'action_type', direction: 'asc', nullOrder: 'nulls-last' },
  ],
};

// ---------------------------------------------------------------------------
// bronze.fact_daily_metrics
// ---------------------------------------------------------------------------

/**
 * Raw daily instrument and entity metrics as delivered by each vendor.
 *
 * Shares outstanding, short interest, analyst coverage etc. - one row per
 * vendor per date.  Reconciled into the gold layer.
 *
 * Partitioned by `source_vendor` (identity) and `metric_date` (month).
 */
export const BRONZE_FACT_DAILY_METRICS: IcebergSchemaDefinition = {
  columns: [
    { name: 'source_vendor', type: 'string', required: true, doc: 'Data vendor name' },

    // Unresolved vendor identifiers
    ...BRONZE_VENDOR_IDENTIFIER_COLUMNS,

    // Metric date
    { name: 'metric_date', type: 'date', required: true, doc: 'Date of the metrics snapshot' },

    // Entity metrics (all other metrics are at the instrument/listing level)
    {
      name: 'total_employees',
      type: 'int',
      doc: 'Total number of employees as reported by vendor',
    },
    {
      name: 'entity_shares_outstanding',
      type: 'long',
      doc: 'Total shares outstanding across all share classes (entity-level)',
    },

    // Share structure
    {
      name: 'share_class_shares_outstanding',
      type: 'long',
      doc: 'Shares outstanding for this share class (instrument-level)',
    },
    { name: 'float_shares', type: 'long', doc: 'Free float shares' },
    { name: 'shares_short', type: 'long', doc: 'Shares sold short' },
    { name: 'short_ratio', type: BRONZE_DECIMAL_TYPE, doc: 'Days to cover (short interest ratio)' },
    {
      name: 'short_interest_pct',
      type: BRONZE_DECIMAL_TYPE,
      doc: 'Short interest as percentage of float',
    },

    // Derived market metrics
    { name: 'market_cap', type: 'decimal(18,2)', doc: 'Market capitalisation' },
    { name: 'enterprise_value', type: 'decimal(18,2)', doc: 'Enterprise value' },
    { name: 'ev_currency', type: 'string', doc: 'Currency for enterprise value / market cap' },

    // Valuation ratios
    {
      name: 'ev_to_ebit',
      type: BRONZE_DECIMAL_TYPE,
      renamedFrom: 'ev_ebit',
      doc: 'Enterprise value / EBIT',
    },
    {
      name: 'ev_to_ebitda',
      type: BRONZE_DECIMAL_TYPE,
      renamedFrom: 'ev_ebitda',
      doc: 'Enterprise value / EBITDA',
    },
    {
      name: 'price_to_book',
      type: BRONZE_DECIMAL_TYPE,
      renamedFrom: 'price_book',
      doc: 'Price / book value (market cap / equity)',
    },
    {
      name: 'price_to_earnings',
      type: BRONZE_DECIMAL_TYPE,
      renamedFrom: 'price_earnings',
      doc: 'Price / earnings (Damodaran method)',
    },
    {
      name: 'price_to_sales',
      type: BRONZE_DECIMAL_TYPE,
      renamedFrom: 'price_sales',
      doc: 'Price / sales (Damodaran method)',
    },

    // Provenance
    ...BRONZE_PROVENANCE_COLUMNS,
  ],
  partitionSpec: [
    { sourceColumn: 'source_vendor', transform: 'identity' },
    { sourceColumn: 'metric_date', transform: 'month', name: 'metric_month' },
  ],
  // Key-first, date-second: same access pattern as fact_daily_ohlcv - gold
  // reads per-ticker metric histories, so cluster by ticker for pruning and
  // compression.
  sortOrder: [
    { sourceColumn: 'ticker', direction: 'asc', nullOrder: 'nulls-last' },
    { sourceColumn: 'metric_date', direction: 'asc', nullOrder: 'nulls-last' },
  ],
};
