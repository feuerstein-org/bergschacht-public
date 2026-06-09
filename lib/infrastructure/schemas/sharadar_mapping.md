# Sharadar -> Bronze Layer Mapping

All Sharadar data is name-adjusted, meaning the ticker will always be the newest ticker, name changes are recorded so it's possible to reconstruct the old ticker.

## SEP table -> `BRONZE_FACT_DAILY_OHLCV`

| Sharadar field | Bronze column     | Notes                                                |
| -------------- | ----------------- | ---------------------------------------------------- |
| `ticker`       | `ticker`          |                                                      |
| `date`         | `price_date`      |                                                      |
| `open`         | ``                | Used to calculate `open`                             |
| `high`         | ``                | Used to calculate `high`                             |
| `low`          | ``                | Used to calculate `low`                              |
| `close`        | ``                | Unadjusted close is already provided by `closeunadj` |
| `volume`       | ``                | Used to calculate `volume`                           |
| `closeadj`     | ``                | Dropped since recalculating dividends is too hard    |
| `closeunadj`   | `close`           | Used to calculate `open`, `high`, `low` & `volume`   |
| `lastupdated`  | `vendor_as_of_ts` |                                                      |

To calculate unadjusted values we do:

```
split_factor = closeunadj / close        # e.g. 0.5 after a 2-for-1 split

open   = open   × split_factor
high   = high   × split_factor
low    = low    × split_factor
volume = volume × (1 / split_factor)     # volume moves inverse to price
```

`split_factor` is always ≤ 1 for forward splits (price went down, volume went up) and > 1 for reverse splits. When there have been no splits, `closeunadj == close` and `split_factor == 1`, so all unadjusted values equal the vendor values.

Note: this factor only captures splits. Cash dividends and spinoffs affect `closeadj` but do **not** affect `closeunadj` or `close`, so the factor is clean for this purpose.

All adjusted fields are dropped after being used to get the unadjusted values.

---

## SFP table

Same fields as SEP but for funds, treated the same way.

---

## ACTIONS table -> `BRONZE_FACT_CORPORATE_ACTIONS`

### Common column mapping (all ingested action types)

| Sharadar field | Bronze column         | Notes                                          |
| -------------- | --------------------- | ---------------------------------------------- |
| `ticker`       | `ticker`              |                                                |
| `date`         | `effective_date`      | Meaning varies by action type (see below)      |
| `action`       | `raw_action_type`     | Raw Sharadar value preserved as-is             |
| `action`       | `action_type`         | Normalised - see mapping table below           |
| `name`         | `NULL`                | Dropped - entity name, not an action attribute |
| `contraticker` | `counterparty_ticker` | `N/A` values stored as `NULL`                  |
| `contraname`   | `counterparty_name`   | `N/A` values stored as `NULL`                  |

`source_vendor` is hardcoded to `'SHARADAR'` for all rows.

### Action-type-specific field mapping details

#### Splits: `split`, `adrratiosplit`

| Sharadar field | Bronze column    | Notes                                                                                              |
| -------------- | ---------------- | -------------------------------------------------------------------------------------------------- |
| `action`       | `action_type`    | `split` (value ≥ 1) -> `SPLIT`; `split` (value < 1) -> `REVERSE_SPLIT`; `adrratiosplit` -> `SPLIT` |
| `date`         | `effective_date` | Effective date of the split                                                                        |
| `value`        | `split_ratio`    | Shares after / shares before (e.g. 0.1 = 1-for-10 reverse split)                                   |

#### Dividends: `dividend`

| Sharadar field | Bronze column       | Notes                                      |
| -------------- | ------------------- | ------------------------------------------ |
| `action`       | `action_type`       | `CASH_DIVIDEND`                            |
| `date`         | `effective_date`    | Ex-dividend date                           |
| `value`        | `dividend_amount`   | Split-adjusted USD per share               |
| -              | `dividend_currency` | Hardcoded to `'USD'` (Sharadar is US-only) |

#### Spinoffs: `spinoff`, `spinoffdividend`, `spunofffrom`

| `action`          | `ticker` is     | `contraticker` is |
| ----------------- | --------------- | ----------------- |
| `spinoff`         | Parent company  | Spunoff company   |
| `spinoffdividend` | Parent company  | Spunoff company   |
| `spunofffrom`     | Spunoff company | Parent company    |

| Sharadar field              | Bronze column         | Notes                                        |
| --------------------------- | --------------------- | -------------------------------------------- |
| `action`                    | `action_type`         | `SPINOFF`                                    |
| `date`                      | `effective_date`      | Date of the spinoff transaction              |
| `value` (`spinoff`)         | `distribution_ratio`  | Shares of spunoff entity per share of parent |
| `value` (`spinoffdividend`) | `dividend_amount`     | USD/share value of the spinoff distribution  |
| `value` (`spunofffrom`)     | `distribution_ratio`  | Shares of spunoff entity per share of parent |
| `contraticker`              | `counterparty_ticker` |                                              |
| `contraname`                | `counterparty_name`   |                                              |

#### Acquisitions: `acquisitionby`, `acquisitionof`

| `action`        | `ticker` is       | `contraticker` is |
| --------------- | ----------------- | ----------------- |
| `acquisitionby` | Acquired company  | Acquiring company |
| `acquisitionof` | Acquiring company | Acquired company  |

| Sharadar field | Bronze column         | Notes                                                  |
| -------------- | --------------------- | ------------------------------------------------------ |
| `action`       | `action_type`         | `ACQUISITION`                                          |
| `date`         | `effective_date`      | Last trade date of the acquired company                |
| `contraticker` | `counterparty_ticker` |                                                        |
| `contraname`   | `counterparty_name`   |                                                        |
| `value`        | `NULL`                | Dropped - final market cap of acquired company (USD M) |

#### Mergers: `mergerfrom`, `mergerto`

| `action`     | `ticker` is           | `contraticker` is     |
| ------------ | --------------------- | --------------------- |
| `mergerfrom` | Non-surviving company | Surviving company     |
| `mergerto`   | Surviving company     | Non-surviving company |

| Sharadar field | Bronze column         | Notes                                                       |
| -------------- | --------------------- | ----------------------------------------------------------- |
| `action`       | `action_type`         | `MERGER`                                                    |
| `date`         | `effective_date`      | Last trade date of the non-surviving company                |
| `contraticker` | `counterparty_ticker` |                                                             |
| `contraname`   | `counterparty_name`   |                                                             |
| `value`        | `NULL`                | Dropped - final market cap of non-surviving company (USD M) |

#### Ticker changes: `tickerchangefrom`, `tickerchangeto`

These come as paired rows and should be viewed together.

| `action`           | `ticker` is               | `contraticker` is         |
| ------------------ | ------------------------- | ------------------------- |
| `tickerchangefrom` | Current ticker in dataset | Old ticker (changed from) |
| `tickerchangeto`   | Current ticker in dataset | New ticker (changed to)   |

| Sharadar field                      | Bronze column      | Notes                               |
| ----------------------------------- | ------------------ | ----------------------------------- |
| `action`                            | `action_type`      | `TICKER_CHANGE`                     |
| `date`                              | `effective_date`   | Effective date of the ticker change |
| `contraticker` (`tickerchangefrom`) | `change_old_value` | The ticker that was changed from    |
| `contraticker` (`tickerchangeto`)   | `change_new_value` | The ticker that was changed to      |

There's one big caveat, if a tickername was handed off between different companies, there will be a number added at the end. E.g. ticker "S" is a good example. It changed ownership 3 times so there is "S", "S1" and "S2" in the dataset. In our dataset we should just have "S" since disambiguation is on the instrument level (CUSIP/Composite FIGI).

#### Delistings: `delisted`, `regulatorydelisting`, `voluntarydelisting`

| Sharadar field | Bronze column    | Notes                              |
| -------------- | ---------------- | ---------------------------------- |
| `action`       | `action_type`    | `DELISTING`                        |
| `date`         | `effective_date` | Last trade date                    |
| `value`        | `NULL`           | Dropped - final market cap (USD M) |

#### Bankruptcy: `bankruptcyliquidation`

| Sharadar field | Bronze column    | Notes                              |
| -------------- | ---------------- | ---------------------------------- |
| `action`       | `action_type`    | `BANKRUPTCY`                       |
| `date`         | `effective_date` | Last trade date                    |
| `value`        | `NULL`           | Dropped - final market cap (USD M) |

#### First trade / listing: `listed`

| Sharadar field | Bronze column    | Notes                                |
| -------------- | ---------------- | ------------------------------------ |
| `action`       | `action_type`    | `LISTING`                            |
| `date`         | `effective_date` | First trade date on exchange         |
| `value`        | `NULL`           | Dropped - initial market cap (USD M) |

Gold resolves whether this event was an IPO by cross-referencing the IPO feed: an instrument with a `LISTING` event and a matching IPO feed row is typed `IPO` in gold.

### Dropped action types

| `action`    | Reason                                                                                    |
| ----------- | ----------------------------------------------------------------------------------------- |
| `relation`  | Bidirectional related-ticker links - redundant with `relatedtickers` in the TICKERS table |
| `initiated` | Coverage initiation date in Sharadar's dataset - vendor metadata, not a corporate action  |

---

## TICKERS table -> `BRONZE_SECURITY_MASTER`

| Sharadar field       | Bronze column        | Notes                                                                                                                                                        |
| -------------------- | -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `permaticker`        | `entity_id`          | Vendor's permanent numeric identifier                                                                                                                        |
| `ticker`             | `ticker`             |                                                                                                                                                              |
| `name`               | `entity_name`        |                                                                                                                                                              |
| `exchange`           | `operating_mic`      | Needs mapping, e.g. `NYSE` -> `XNYS`, `NASDAQ` -> `XNAS`                                                                                                     |
| `isdelisted`         | `listing_status`     | `Y` -> `DELISTED`, `N` -> `ACTIVE`                                                                                                                           |
| `category`           | `instrument_type`    | e.g. `Domestic Common Stock`                                                                                                                                 |
| `cusips`             | `cusip`              | Single CUSIP; also stored in `cusip_list` when the vendor reports multiple                                                                                   |
| `siccode`            | `sic_code`           |                                                                                                                                                              |
| `sicsector`          | `NULL`               | Dropped - derivable from SIC code                                                                                                                            |
| `sicindustry`        | `NULL`               | Dropped - derivable from SIC code                                                                                                                            |
| `famasector`         | `NULL`               | Dropped - derivable from SIC code                                                                                                                            |
| `famaindustry`       | `NULL`               | Dropped - derivable from SIC code                                                                                                                            |
| `sector`             | `NULL`               | Dropped - Morningstar Global Equity Classification Structure                                                                                                 |
| `industry`           | `NULL`               | Dropped - Morningstar Global Equity Classification Structure                                                                                                 |
| `scalemarketcap`     | `NULL`               | Dropped - just in time                                                                                                                                       |
| `scalerevenue`       | `NULL`               | Dropped - just in time                                                                                                                                       |
| `relatedtickers`     | `related_tickers`    | parsed into a list                                                                                                                                           |
| `currency` (SEP/SFP) | `trading_currency`   | Trading currency, taken from the price-table row; `NULL` for fundamentals-only securities (see below)                                                        |
| `currency` (SF1)     | `reporting_currency` | Company reporting currency, taken from the `SF1` row; `NULL` for securities with no `SF1` row (see below)                                                    |
| `location`           | `location`           | e.g. `California; U.S.A`                                                                                                                                     |
| `lastupdated`        | `vendor_as_of_ts`    |                                                                                                                                                              |
| `firstadded`         | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `firstpricedate`     | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `lastpricedate`      | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `firstquarter`       | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `lastquarter`        | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `secfilings`         | `cik`                | CIK can be extracted from URL                                                                                                                                |
| `companysite`        | `company_website`    |                                                                                                                                                              |
| `table`              | `NULL`               | Dropped from output, but used to exclude institutional investors, deduplicate, and split `currency` into `trading_currency`/`reporting_currency` (see below) |

`source_vendor` is hardcoded to `'SHARADAR'` for all rows. `snapshot_date` is
set to the ingestion date since the TICKERS table doesn't carry its own snapshot
date.

### Multi-table rows: investor exclusion + deduplication

The TICKERS export carries **one row per `permaticker` per Sharadar product table**
the entity appears in, given by the `table` column:

| `table`       | Sharadar product                        | In `security_master`? |
| ------------- | --------------------------------------- | --------------------- |
| `SEP`         | Equity Prices (EOD prices for stocks)   | yes (preferred)       |
| `SFP`         | Fund Prices (EOD prices for ETFs/funds) | yes (preferred)       |
| `SF1`         | Core US Fundamentals (10-K/10-Q)        | yes (fallback)        |
| `SF3A`/`SF3B` | Core US Institutional Investors         | **no - excluded**     |

We Exclude `SF3A`/`SF3B` (institutional investors) completely.

Deduplicate the remaining rows to one per security. A security can still appear in several real tables (e.g. `AACG` is in both `SF1` and `SEP`).
`security_master` wants one row per security, so we collapse per `permaticker`, preferring the **price tables** (`SEP` > `SFP` > `SF1`, ties broken by newest `lastupdated`). Fundamentals-only names with no price feed are retained via their `SF1` row, not dropped.

The dedup still collapses to one output row per `permaticker`, but `currency` is **not** taken from the chosen row - we keep both currencies. Sharadar's `currency` column is **table-specific**: in the price tables it is the **trading currency** (e.g. `USD` for the `AACG` ADR on NASDAQ), while in `SF1` it is the company's **reporting currency** (e.g. `CNY`). We therefore source each one from its own row, independent of which row wins the dedup:

- `trading_currency` <- `currency` from the `SEP`/`SFP` row (`NULL` for fundamentals-only securities)
- `reporting_currency` <- `currency` from the `SF1` row (`NULL` for securities with no `SF1` row, e.g. ETFs, warrants, preferred)
