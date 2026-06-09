# Massive -> Bronze Layer Mapping

## Ingestion Strategy

The All Tickers API (`GET /v3/reference/tickers`) is called with a specific `date` parameter to discover all available tickers on that date. For each ticker returned, the Ticker Overview API (`GET /v3/reference/tickers/{ticker}`) is called with the same `date` to retrieve detailed attributes. Together, these two APIs populate `BRONZE_SECURITY_MASTER`, `BRONZE_FACT_DAILY_INSTRUMENT_METRICS` and `BRONZE_FACT_CORPORATE_ACTIONS`.

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
| `address`            | Overview    | `location`               | Constructed from subfields, e.g. `CA; U.S.A`                                       |
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
| `split_from`              | `split_from`      | Raw vendor denominator (old shares)                   |
| `split_to`                | `split_to`        | Raw vendor numerator (new shares)                     |
| `split_to` / `split_from` | `split_ratio`     | Computed: `split_to / split_from`                     |

### `adjustment_type` -> `action_type` mapping

| `adjustment_type` | `action_type`    |
| ----------------- | ---------------- |
| `forward_split`   | `SPLIT`          |
| `reverse_split`   | `REVERSE_SPLIT`  |
| `stock_dividend`  | `STOCK_DIVIDEND` |

### Dropped fields

| Massive field                  | Reason                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `historical_adjustment_factor` | Vendor-adjusted cumulative factor, stale after future events |

---

## Dividends API -> `BRONZE_FACT_CORPORATE_ACTIONS`

`GET /stocks/v1/dividends`

| Massive field       | Bronze column        | Notes                                                                                                                |
| ------------------- | -------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `ticker`            | `ticker`             |                                                                                                                      |
| `id`                | `action_id`          | Unique dividend record identifier                                                                                    |
| `distribution_type` | `raw_action_type`    | `recurring`, `special`, `supplemental`, `irregular`, `unknown`                                                       |
| `distribution_type` | `action_type`        | `special`/`supplemental` -> `SPECIAL_DIVIDEND`; all others -> `CASH_DIVIDEND`                                        |
| `declaration_date`  | `announcement_date`  |                                                                                                                      |
| `ex_dividend_date`  | `effective_date`     | Canonical date for this event                                                                                        |
| `record_date`       | `record_date`        |                                                                                                                      |
| `pay_date`          | `pay_date`           |                                                                                                                      |
| `cash_amount`       | `dividend_amount`    | Original per-share amount                                                                                            |
| `currency`          | `dividend_currency`  | e.g. `USD`                                                                                                           |
| `frequency`         | `dividend_frequency` | frequency reports the amounts of payouts in a year, we use the same numeric value - 0 signifies irregular or unknown |

### Dropped fields

| Massive field                  | Reason                                                       |
| ------------------------------ | ------------------------------------------------------------ |
| `split_adjusted_cash_amount`   | Vendor-adjusted, stale after future splits                   |
| `historical_adjustment_factor` | Vendor-adjusted cumulative factor, stale after future events |

---

## IPOs API -> `BRONZE_FACT_CORPORATE_ACTIONS`

Delisted companies are also available.

`GET /vX/reference/ipos`

Name-adjusted - META is reported instead of FB.

| Massive field         | Bronze column          | Notes                         |
| --------------------- | ---------------------- | ----------------------------- |
| `ticker`              | `ticker`               |                               |
| `ipo_status`          | `raw_action_type`      | Raw status preserved as-is    |
| `ipo_status`          | `action_status`        | See mapping table below       |
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
| `issue_end_date`       | Not in schema                                                                 |
| `announced_date`       | Not in schema, the records we ingest now don't have announcements (`history`) |

Potentially can add the missing fields later.

---

## Ticker Events API -> `BRONZE_FACT_CORPORATE_ACTIONS`

`GET /vX/reference/tickers/{id}/events` (experimental)

Currently only supports `ticker_change` events. Events are returned as a timeline of ticker values at specific dates. The current values is always returned first, e.g. AAPL will be returned for Apple with the change date being in 2003 (earliest available data). We obviously only need results with at least one pair (e.g. META).

Note: It will only return ticker changes for a singular company, not ticker handoffs between companies. So in the case of "S" or "Q" we will not see anything.

Delisted companies are not shown.

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
