# Massive -> Bronze Layer Mapping

> **Ticker conventions vary by feed.** Most Massive feeds report the **as-of-date** symbol (PIT-safe), but the **IPO** feed is name-adjusted ("META instead of FB") and **Ticker Events** are queried by current ticker - both are _current-labeled_ and must not be resolved point-in-time on the event date. See [`DATA_DESIGN.md` -> Vendor ticker semantics](../../../DATA_DESIGN.md) and the resolution contract in [`bronze_to_gold_mapping.md`](./bronze_to_gold_mapping.md). Massive carries identity via `composite_figi` / `share_class_figi` (and CIK), so it has no permaticker-style `vendor_record_id`.

## Ingestion Strategy

Massive is ingested via the [`massive-api`](https://github.com/feuerstein-org/massive-api) async client.

The connector runs one **source** (API pull) per **daily partition**, and each source fans out to one or more bronze tables - fetched once, never re-fetched per target table:

| Source (`feed`)      | Massive call(s)                                                    | Bronze tables                                                                  |
| -------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------ |
| `reference_snapshot` | All Tickers(`date`) + Ticker Overview(`ticker`, `date`) per ticker | `security_master`, `fact_daily_metrics`, `fact_corporate_actions` (delistings) |
| `splits`             | Splits(`execution_date` = partition day)                           | `fact_corporate_actions`                                                       |
| `dividends`          | Dividends(`ex_dividend_date` = partition day)                      | `fact_corporate_actions`                                                       |
| `ticker_events`      | Ticker Events(`ticker`) per active ticker (bounded)                | `fact_corporate_actions` (ticker changes)                                      |

The per-ticker Overview / Events fan-outs run concurrently to saturate the rate limiter without an unbounded coroutine count over the ~10k-ticker universe.

### Date semantics (daily partition)

- **`reference_snapshot`** - the partition date is the `date` query param on both calls, a genuine point-in-time as-of date (`snapshot_date` / `metric_date`) that can be historical/backfilled. All Tickers and Overview are merged per ticker into one record, Overview-preferred (richer detail call).
- **`splits` / `dividends`** - the partition date is queried **exactly** (`execution_date` / `ex_dividend_date`), _not_ as a range. Massive exposes **no `last_updated`** on these payloads, so there is **no restatement watermark**: a corrected past-dated split/dividend is only re-captured by **re-running that day's partition** (a Dagster backfill over the affected dates), after which change-detected append writes only the diff.
- **`ticker_events`** - **ignores the partition date.** The endpoint has no date filter (it returns a security's _whole_ change history every call) and is only offered for **active** tickers, so the connector enumerates **today's** active universe (no `date`). See [Ticker Events](#ticker-events-api---bronze_fact_corporate_actions), this feed is effectively "current state".

---

## Identity & change detection

Massive has **no permaticker-style stable per-security id**; identity is carried by `composite_figi` / `share_class_figi` / `cik`, and bronze stores the vendor identifiers raw. The connector only needs a stable **natural key** for change-detected append (a row is written only when new or when its content hash changed):

| Bronze table                                               | Append mode     | Natural key                                                                        | `record_hash` also excludes | SCD `as_of` (version ordering) |
| ---------------------------------------------------------- | --------------- | ---------------------------------------------------------------------------------- | --------------------------- | ------------------------------ |
| `security_master`                                          | change-detected | `(source_vendor, vendor_record_id)`                                                | `snapshot_date`             | `snapshot_date`                |
| `fact_daily_metrics`                                       | plain append    | -                                                                                  | -                           | -                              |
| `fact_corporate_actions` - splits / dividends / delistings | change-detected | `(source_vendor, action_type, ticker, effective_date)`                             | -                           | `ingested_at`                  |
| `fact_corporate_actions` - ticker changes                  | change-detected | `(source_vendor, action_type, change_old_value, change_new_value, effective_date)` | `ticker`                    | `ingested_at`                  |

- **`security_master`** - `vendor_record_id` = `composite_figi`, falling back to `UNRESOLVED:<ticker>` when the FIGI is null (namespaced so it never collapses onto a bare ticker). `snapshot_date` moves every run, so it is excluded from the hash; it is also the SCD `as_of` that orders a security's versions.
- **Corporate actions `as_of`** - all corporate-action sub-feeds order versions by `ingested_at`, not by a snapshot date. Each is a discrete event whose `effective_date` is already in the key.
- **`fact_daily_metrics`** - plain append (one row per ticker per day); operational duplicates and any restatements collapse in the bronze -> gold pipeline on `(resolved identity, metric_date)`, like the other date-keyed facts.
- **Corporate actions - as-of-date / terminal feeds** (splits, dividends, delistings): the event's `ticker` is stable (splits/dividends are _not_ name-adjusted; a delisted symbol no longer moves), so it is safe in the key. `action_type` in the key keeps the sub-feeds from colliding in the shared `MASSIVE` partition (each is its own `append_changed` call).
- **Corporate actions - Ticker Events** (current-labeled): keyed on the immutable change identity with the volatile current `ticker` excluded from the hash - see [Ticker Events](#ticker-events-api---bronze_fact_corporate_actions).

---

## All Tickers + Ticker Overview -> `BRONZE_SECURITY_MASTER`

Fields from both APIs are merged into a single record per ticker per snapshot date. Where both APIs provide the same field, the Ticker Overview value is preferred (it comes from the detail call and is richer).

| Massive field        | Source API  | Bronze column            | Notes                                                                              |
| -------------------- | ----------- | ------------------------ | ---------------------------------------------------------------------------------- |
| (query param) `date` | Both        | `snapshot_date`          | Date parameter used in the API calls                                               |
| `ticker`             | Both        | `ticker`                 |                                                                                    |
| `name`               | Both        | `entity_name`            |                                                                                    |
| `cik`                | Both        | `cik`                    |                                                                                    |
| `composite_figi`     | Both        | `composite_figi`         |                                                                                    |
| `share_class_figi`   | Both        | `share_class_figi`       |                                                                                    |
| `primary_exchange`   | Both        | `operating_mic`          |                                                                                    |
| `active`             | Both        | `listing_status`         | `true` -> `ACTIVE`, `false` -> `DELISTED`                                          |
| `type`               | Both        | `instrument_type`        | e.g. `CS`, `ETF`, `ADRC`                                                           |
| `currency_name`      | Both        | `trading_currency`       | Uppercase, e.g. `usd` -> `USD`. `reporting_currency` is left `NULL` - not provided |
| `sic_code`           | Overview    | `sic_code`               |                                                                                    |
| `homepage_url`       | Overview    | `company_website`        |                                                                                    |
| `description`        | Overview    | `instrument_description` |                                                                                    |
| `address`            | Overview    | `hq_location`            | Constructed from subfields, e.g. `CA; U.S.A`                                       |
| `last_updated_utc`   | All Tickers | `vendor_as_of_ts`        |                                                                                    |
| `round_lot`          | Overview    | `round_lot`              |                                                                                    |

### Dropped fields

| Massive field          | Source API  | Reason                                                              |
| ---------------------- | ----------- | ------------------------------------------------------------------- |
| `locale`               | Both        | Always `us` for stocks market or `global` for crypto/Forex          |
| `market`               | Both        | Not in schema                                                       |
| `delisted_utc`         | Both        | Mapped to `BRONZE_FACT_CORPORATE_ACTIONS` (see below)               |
| `currency_symbol`      | All Tickers | Redundant with `currency_name`                                      |
| `base_currency_name`   | All Tickers | Only relevant for crypto/fx pairs, dropped for now                  |
| `base_currency_symbol` | All Tickers | Only relevant for crypto/fx pairs, dropped for now                  |
| `sic_description`      | Overview    | Derivable from SIC code                                             |
| `branding`             | Overview    | Logo/icon URLs                                                      |
| `phone_number`         | Overview    | Not in schema                                                       |
| `ticker_root`          | Overview    | Derivable from ticker                                               |
| `ticker_suffix`        | Overview    | Derivable from ticker                                               |
| `list_date`            | Overview    | very inaccurate for old tickers, use dedicated IPOs API (see below) |

---

## All Tickers + Ticker Overview -> `BRONZE_FACT_CORPORATE_ACTIONS` (delistings only)

When a ticker has `active=false` and `delisted_utc` is present, a `DELISTING` event is emitted. There is no dedicated delisting API.

| Massive field  | Source API | Bronze column     | Notes                    |
| -------------- | ---------- | ----------------- | ------------------------ |
| `ticker`       | Both       | `ticker`          |                          |
| -              | -          | `action_type`     | Hardcoded to `DELISTING` |
| -              | -          | `raw_action_type` | `delisted`               |
| `delisted_utc` | Both       | `effective_date`  | Last trade date          |

---

## Ticker Overview -> `BRONZE_FACT_DAILY_METRICS`

The Ticker Overview API provides point-in-time market metrics that land in the daily instrument metrics table.

| Massive field                    | Bronze column                    | Notes                                       |
| -------------------------------- | -------------------------------- | ------------------------------------------- |
| `ticker`                         | `ticker`                         |                                             |
| (query param) `date`             | `metric_date`                    | Date parameter used in the API call         |
| `market_cap`                     | `market_cap`                     |                                             |
| `total_employees`                | `total_employees`                | Total number of employees                   |
| `weighted_shares_outstanding`    | `entity_shares_outstanding`      | Entity-level total across all share classes |
| `share_class_shares_outstanding` | `share_class_shares_outstanding` | Instrument-level, this share class only     |

---

## Splits API -> `BRONZE_FACT_CORPORATE_ACTIONS`

`GET /stocks/v1/splits`

Not name adjusted, splits are reported for whatever ticker name was used at the time.

| Massive field             | Bronze column     | Notes                                                 |
| ------------------------- | ----------------- | ----------------------------------------------------- |
| `ticker`                  | `ticker`          |                                                       |
| `id`                      | `action_id`       | Unique split event identifier                         |
| `adjustment_type`         | `raw_action_type` | `forward_split`, `reverse_split`, or `stock_dividend` |
| `adjustment_type`         | `action_type`     | See mapping table below                               |
| `execution_date`          | `effective_date`  | Date when split was applied                           |
| `split_to` / `split_from` | `split_ratio`     | Computed: `split_to / split_from`                     |

### `adjustment_type` -> `action_type` mapping

| `adjustment_type` | `action_type`    |
| ----------------- | ---------------- |
| `forward_split`   | `SPLIT`          |
| `reverse_split`   | `REVERSE_SPLIT`  |
| `stock_dividend`  | `STOCK_DIVIDEND` |

### Dropped fields

| Massive field                  | Reason                                                        |
| ------------------------------ | ------------------------------------------------------------- |
| `split_from`                   | No need to store this, only useful for dashboards later maybe |
| `split_to`                     | No need to store this, only useful for dashboards later maybe |
| `historical_adjustment_factor` | Vendor-adjusted cumulative factor, stale after future events  |

---

## Dividends API -> `BRONZE_FACT_CORPORATE_ACTIONS`

`GET /stocks/v1/dividends`

| Massive field       | Bronze column        | Notes                                                                                                                |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ticker`            | `ticker`             |                                                                                                                      |
| `id`                | `action_id`          | Unique dividend record identifier                                                                                    |
| `distribution_type` | `raw_action_type`    | `recurring`, `special`, `supplemental`, `irregular`, `unknown`                                                       |
| `distribution_type` | `action_type`        | `special`/`supplemental` -> `SPECIAL_DIVIDEND`; all others -> `CASH_DIVIDEND`                                        |
| `ex_dividend_date`  | `effective_date`     | Canonical date for this event                                                                                        |
| `record_date`       | `record_date`        |                                                                                                                      |
| `pay_date`          | `pay_date`           |                                                                                                                      |
| `cash_amount`       | `dividend_amount`    | Original per-share amount                                                                                            |
| `currency`          | `dividend_currency`  | e.g. `USD`                                                                                                           |
| `frequency`         | `dividend_frequency` | frequency reports the amounts of payouts in a year, we use the same numeric value - 0 signifies irregular or unknown |

### Dropped fields

| Massive field                  | Reason                                                                                         |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| `declaration_date`             | No `announcement_date` column in the current bronze schema - dropped until the column is added |
| `split_adjusted_cash_amount`   | Vendor-adjusted, stale after future splits                                                     |
| `historical_adjustment_factor` | Vendor-adjusted cumulative factor, stale after future events                                   |

---

## IPOs API -> `BRONZE_FACT_CORPORATE_ACTIONS`

> **Not yet ingestable.** The `massive-api` client (v0.2.0) exposes no IPOs endpoint, so this feed is **not currently wired**. The mapping below is retained for when the endpoint ships.

Delisted companies are also available.

`GET /vX/reference/ipos`

Name-adjusted - META is reported instead of FB.

| Massive field         | Bronze column          | Notes                         |
| --------------------- | ---------------------- | ----------------------------- |
| `ticker`              | `ticker`               |                               |
| `ipo_status`          | `raw_action_type`      | Raw status preserved as-is    |
| `listing_date`        | `effective_date`       | First trading date            |
| `final_issue_price`   | `ipo_offer_price`      |                               |
| `lowest_offer_price`  | `ipo_price_range_low`  |                               |
| `highest_offer_price` | `ipo_price_range_high` |                               |
| `currency_code`       | `ipo_price_currency`   |                               |
| `max_shares_offered`  | `ipo_shares_offered`   | Upper limit of shares offered |
| `primary_exchange`    | `ipo_exchange_mic`     | Already MIC format            |
| `security_type`       | `ipo_security_type`    | e.g. `CS`                     |
| `last_updated`        | `vendor_as_of_ts`      |                               |

### `ipo_status` -> `action_status` mapping

| `ipo_status`             | `action_status`  | Notes                |
| ------------------------ | ---------------- | -------------------- |
| `rumor`                  | `NULL`           | Dropped - unreliable |
| `pending`                | `NULL`           | Dropped - unreliable |
| `new`                    | `NULL`           | Dropped - unreliable |
| `history`                | `COMPLETED`      |                      |
| `direct_listing_process` | `DIRECT_LISTING` |                      |
| `postponed`              | `NULL`           | Dropped - unreliable |
| `withdrawn`              | `NULL`           | Dropped - unreliable |

Currently Massive has data quality issues with IPO data, specifically values besides `history` and `direct_listing_process` are often inaccurate. For now we only ingest those two until the situation changes.

### Dropped fields

| Massive field          | Reason                                                                        |
| ---------------------- | ----------------------------------------------------------------------------- |
| `issuer_name`          | Redundant with `name` from Ticker Overview                                    |
| `isin`                 | Not historical (isin can change)                                              |
| `us_code`              | CUSIP - not historical (CUSIP can change)                                     |
| `security_description` | Redundant with `security_type`                                                |
| `shares_outstanding`   | Only the shares outstanding at the time of the IPO - not historical           |
| `total_offer_size`     | Not in schema                                                                 |
| `min_shares_offered`   | Not in schema                                                                 |
| `lot_size`             | Not in schema                                                                 |
| `issue_start_date`     | Not in schema                                                                 |
| `ipo_status`           | Not in schema, we only store completed ipos (no rumors etc)                   |
| `issue_end_date`       | Not in schema                                                                 |
| `announced_date`       | Not in schema, the records we ingest now don't have announcements (`history`) |

Potentially can add the missing fields later.

---

## Ticker Events API -> `BRONZE_FACT_CORPORATE_ACTIONS`

`GET /vX/reference/tickers/{id}/events` (experimental)

Currently only supports `ticker_change` events. Events are returned as a timeline of ticker values at specific dates. The current values is always returned first, e.g. AAPL will be returned for Apple with the change date being in 2003 (earliest available data). We obviously only need results with at least one pair (e.g. META).

Note: It will only return ticker changes for a singular company, not ticker handoffs between companies. So in the case of "S" or "Q" we will not see anything.

Delisted companies are not shown.

### Enumeration & change detection

The endpoint has **no date filter** - every call returns the security's entire ticker-change history (newest first) - and is only available for **active** tickers. So the connector enumerates **today's** active universe (All Tickers, `active=true`, **no `date`** - a historical universe would only add now-delisted tickers that return nothing and miss tickers that became active later) and re-pulls every history on each run. Idempotency comes entirely from change-detected append.

Because Ticker Events is **current-labeled** - the `ticker` we query with, and store, is the security's _current_ symbol - it must **not** be keyed on `ticker`: on the next rename the whole history re-appears under the new current symbol, and keying on `ticker` would re-write every past change as a duplicate. Instead:

- **Natural key** = `(source_vendor, action_type, change_old_value, change_new_value, effective_date)` - the immutable identity of the change itself.
- **`record_hash` excludes `ticker`** - so a re-pull under a new current symbol matches on key _and_ hash and writes nothing.

This mirrors the Sharadar ACTIONS handling of current-labeled feeds. Since every input is "current state" (today's universe + whole history), the feed does not vary by partition date and is best scheduled on its own cadence rather than per daily partition.

For each two entries:

| Derived from                 | Bronze column      | Notes                              |
| ---------------------------- | ------------------ | ---------------------------------- |
| path param `id`              | `ticker`           | Current ticker used to query       |
| -                            | `action_type`      | Hardcoded to `TICKER_CHANGE`       |
| `type`                       | `raw_action_type`  | `ticker_change`                    |
| `date`                       | `effective_date`   | Date of the ticker change          |
| older `ticker_change.ticker` | `change_old_value` | The previous ticker                |
| newer `ticker_change.ticker` | `change_new_value` | The new ticker                     |
| `composite_figi`             | `composite_figi`   | Stable identifier for the security |

### Dropped fields

| Massive field      | Reason                                                      |
| ------------------ | ----------------------------------------------------------- |
| `name`             | Entity name, not an action attribute                        |
| `share_class_figi` | Share-class granularity not needed for ticker change events |
