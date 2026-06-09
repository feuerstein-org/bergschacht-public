# Data Design

## Medallion Architecture

Data flows through a three-layer medallion architecture: **Bronze -> Silver (virtual) -> Gold**.

```
┌──────────────────────┐
│     Vendor APIs      │  Massive, Sharadar, OpenFIGI, ...
└──────────┬───────────┘
           │  Change-detected append
           ▼
┌──────────────────────┐
│     Bronze Layer     │  Raw vendor data, append-only, full provenance
│   (Iceberg tables)   │  One row per vendor per snapshot - minimal transforms like mapping
└──────────┬───────────┘
           │  Deterministic resolution pipeline
           │  (Silver is virtual - no materialised tables)
           ▼
┌──────────────────────┐
│      Gold Layer      │  Single authoritative "golden copy"
│   (Iceberg tables)   │  Dimensions (SCD2) + Facts (auditable lineage)
└──────────────────────┘
```

### Bronze

Bronze tables store raw vendor data exactly as delivered - no transformations beyond adding ingestion metadata (`ingested_at`, `pipeline_run_id`) and some minimal mapping (e.g. MIC codes for exchanges). Each vendor's feed produces its own rows, so the same instrument on the same date may appear multiple times, once per vendor.

Ingestion uses **change-detected append**: a `record_hash` (SHA-256 of all content columns) is compared against the latest row for the same natural key. A new row is only written when the hash differs, keeping storage bounded while preserving the full audit trail. Note that this only applies to SCD2 tables, for tables that store daily pricing for example we accept potential duplicates and filter them out either separately or they get removed in the pipeline to gold.

#### Bronze time columns

Bronze rows carry up to three distinct, non-redundant time signals. They sit on different axes and answer different questions, so none can be derived from the others:

- **`vendor_as_of_ts`** (_valid time_) - when the **vendor** claims this record's content became accurate. Per-record and sparse: it only moves when the vendor actually edits that record, so a security can carry a `vendor_as_of_ts` years older than the snapshot that observed it. Optional (nullable) - some vendors don't supply it. Sourced from the vendor's own `lastupdated` / `last_updated_utc`.
- **`snapshot_date`** (_observation / as-of time_) - which pull cycle this row belongs to. Uniform across an entire pull and **required**; it is the column the `snapshot_month` partition is built on. It records _when we observed the universe_, which is what lets us reconstruct "the set of securities the vendor presented as of date T" - something `vendor_as_of_ts` cannot express, because an instrument absent from a snapshot is indistinguishable from one present-but-unchanged by vendor timestamp alone. Its semantics differ by vendor:
  - **Massive** sets it to the `date` **query parameter** of the All Tickers / Ticker Overview calls - a genuine point-in-time as-of date that can be historical/backfilled.
  - **Sharadar** sets it to the **ingestion run date** (a proxy), because the TICKERS export carries no as-of date of its own; the vendor's real freshness signal for Sharadar lives in `vendor_as_of_ts`.
- **`ingested_at`** (_transaction time_) - when **our** pipeline physically wrote the row. Drives change-detection ordering (latest-version-per-key) and provenance.

Bronze tables are partitioned by `source_vendor` and a time column (e.g. `snapshot_month`, `price_month`) so vendor-scoped scans are efficient.

We deliberately do **not** partition or optimise bronze for per-ticker access. Bronze is not a query layer - its only readers are the ingestion writer, the bronze->gold pipeline, and occasional provenance debugging, all of which scan whole vendor/month partitions rather than selective ticker slices. Partitioning by `ticker` would also explode partition count (tens of thousands of high-cardinality, nullable, vendor-unresolved values) and hit the Iceberg small-files problem.

#### Backfill ingestion (partitioned)

Large historical vendor files (e.g. Sharadar SEP: ~3 GB / 46M rows of daily prices)
are too big to transform-and-write in a single Lambda. For the one-time backfill we
split the source file once into **per-year partitions** in a staging S3 bucket
(`year=YYYY/…`), then ingest **one partition per Lambda invocation**, driven by a
date-partitioned Dagster asset. One year (≤2.1M rows) fits comfortably in a Lambda
(10 GB / 15 min), keeping orchestration Lambda-only instead of a long-running ECS
task. The processing partition (year) is independent of the Iceberg storage
partition (price month) - a year's rows simply land across the relevant monthly
partitions. Date-keyed fact tables (OHLCV, daily metrics) use this; snapshot
dimensions like `security_master` are small enough to ingest in a single invocation.
This implies the IaC provides a **staging bucket** for the split partitions and a
Lambda sized for one partition, and that the orchestrator task def passes
`SHARADAR_STAGING_PREFIX` (the staging `s3://…/sharadar` prefix) and
`CONNECTOR_SHARADAR_LAMBDA_NAME` to the Dagster code, which exposes the
`sharadar_ohlcv` (yearly-partitioned) and `sharadar_security_master` Pipes assets.
(Split/upload tooling lives in `foerderturm`'s `scripts/split_and_upload.py`.)

### Silver (Virtual)

There is no materialised silver layer. The reconciliation logic that would traditionally live in silver - vendor comparison, conflict detection, priority-based resolution - runs as a pipeline step and writes its output directly to gold. Cross-vendor conflicts are persisted in `gold.fact_data_conflicts` and `gold.fact_identifier_conflicts` for auditability.

### Gold

Gold contains the single authoritative view of each record. Dimension tables use **SCD Type 2** (`effective_from`, `effective_to`, `is_current`) so point-in-time queries can reconstruct any historical state. Cross-vendor disagreements are recorded in `gold.fact_data_conflicts` and `gold.fact_identifier_conflicts` for auditability. Gold facts carry only the resolved values - lineage back to bronze is reconstructable via the deterministic pipeline and natural keys.

All gold dimensions are partitioned by `is_current` so current-only scans skip historical rows.

---

## Identifier Resolution

Bronze fact tables (OHLCV, corporate actions, daily metrics, …) carry **no foreign keys** to the identifier dimensions. They store the vendor's raw `ticker` (plus `composite_figi` where the vendor provides one) exactly as delivered. Resolving those raw vendor identifiers to the stable internal keys (`internal_instrument_id`, `internal_listing_id`, `internal_entity_id`) happens **in the bronze->gold pipeline** - not at ingestion time.

This is a deliberate choice since resolution is a revisable judgment; bronze is append-only, a late-arriving ticker-change event, a CUSIP correction, or a steward override in `fact_identifier_conflicts` can flip a _past_ resolution. Keeping resolution in the pipeline means gold is simply recomputed while bronze stays an immutable, vendor-faithful provenance anchor that is always reproducible from the vendor payload alone.

### Why ticker is not a stable key

A ticker symbol is **not** a stable identifier. It is reused across unrelated companies over time and changes for a single company. The symbol `S`, for example, was held in turn by Sears, then Sprint, then SentinelOne. Vendors disambiguate inconsistently - Sharadar exposes the collisions as `S`, `S1`, `S2`, while other vendors name them differently.

Because of this, the pipeline resolves on `(source_vendor, ticker, date)` **point-in-time** against the reconciled security master (or the vendors security master) rather than on the ticker string alone. Cases that cannot be resolved deterministically, or where vendors disagree on identity, are written to `gold.fact_identifier_conflicts` and block the affected instrument from the golden copy until a steward resolves them.

---

## Gold Hierarchy

Gold dimensions follow a four-level hierarchy: **Entity → Instrument → Listing → Fact**.

```
┌─────────────────────────────────────┐
│            dim_entity               │  Legal entity / company
│        internal_entity_id           │  LEI, CIK, SIC, incorporation country
└─────────────────┬───────────────────┘
                  │ 1:N
                  ▼
┌─────────────────────────────────────┐
│           dim_instrument            │  Fungible financial instrument (share class)
│        internal_instrument_id       │  CUSIP, Share Class FIGI, instrument type
│             entity_fk               │  foreign key to dim_entity
└─────────────────┬───────────────────┘
                  │ 1:N
                  ▼
┌─────────────────────────────────────┐
│            dim_listing              │  Trading instance (composite or venue)
│        internal_listing_id          │  Ticker, Composite FIGI / venue FIGI
│           instrument_fk             │  foreign key to dim_instrument
│   listing_scope: COMPOSITE | VENUE  │
└─────────────────┬───────────────────┘
                  │ 1:N
                  ▼
┌─────────────────────────────────────┐
│          Fact tables                │  OHLCV, corporate actions, financials, ...
│      listing_fk / instrument_fk     │  foreign key to dim_listing or dim_instrument
└─────────────────────────────────────┘
```

### Why the split between Entity and Instrument?

OpenFIGI defines a three-level identifier hierarchy - but its _top_ level is the **Share Class FIGI**, which represents a single share class globally, _not_ the entire company. There is no entity-level FIGI.

Consider Alphabet (Google) with its three share classes: GOOGL (Class A), GOOG (Class C), and a non-traded Class B. Each class has its own CUSIP and Share Class FIGI, but they all belong to the same legal entity, Alphabet Inc., which has one LEI, one CIK, one SIC code.

Each share class is a separate instrument with its own CUSIP and Share Class FIGI. But company-level attributes - legal name, LEI, CIK, SIC code - belong to Alphabet Inc. the entity, not to any individual share class. Similarly, `entity_shares_outstanding` (~12.8B, the sum across all classes) is an entity-level metric, while `share_class_shares_outstanding` (~5.96B for GOOGL alone) is instrument-level.

This is why gold separates the two:

- **`dim_entity`** holds LEI, CIK, SIC, incorporation country - attributes that identify the legal entity and apply across all its instruments.
- **`dim_instrument`** holds CUSIP, Share Class FIGI, instrument type, domicile - attributes that identify a specific fungible security.

### Listing scope: COMPOSITE vs VENUE

Each instrument can have multiple listings. `listing_scope` distinguishes two kinds:

- **COMPOSITE**: the consolidated tape across all venues in a market. The `operating_mic` is set to the instrument's primary listing exchange (e.g. XNAS for AAPL). Identified by `bbg_composite_figi`.
- **VENUE**: a specific venue (exchange, ATS, dark pool).

### OpenFIGI to Gold mapping

The OpenFIGI hierarchy maps onto gold as follows:

| OpenFIGI Level     | FIGI Type        | Gold Table                | Gold Column          |
| ------------------ | ---------------- | ------------------------- | -------------------- |
| _(above OpenFIGI)_ | -                | `dim_entity`              | `internal_entity_id` |
| Top                | Share Class FIGI | `dim_instrument`          | `share_class_figi`   |
| Middle             | Composite FIGI   | `dim_listing` (COMPOSITE) | `bbg_composite_figi` |
| Bottom             | FIGI             | `dim_listing` (VENUE)     | `figi`               |
