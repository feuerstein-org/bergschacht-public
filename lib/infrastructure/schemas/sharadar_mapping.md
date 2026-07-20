# Sharadar -> Bronze Layer Mapping

**All Sharadar data is name-adjusted.** Across every table (SEP/SFP, ACTIONS, DAILY, TICKERS) the `ticker` field holds the security's **current** symbol, applied retroactively to all of its history: ingest the ACTIONS table while a company trades as FB and a 2015 dividend is labeled `FB`; re-ingest after it becomes META and the _same_ 2015 event is now labeled `META`. The symbol is therefore not a stable key and is **point-in-time-unsafe** (resolving `(SHARADAR, META, 2015)` is wrong - META was Meta Materials then). Ticker changes are recorded as `TICKER_CHANGE` actions and as new `security_master` snapshots, so the old symbol is always reconstructable.

The consequence for ingestion: anything keyed on the raw `ticker` would duplicate on every rename. The stable key is `permaticker` (Sharadar's permanent per-security id), which the connector uses as `vendor_record_id`. See [`DATA_DESIGN.md` -> Vendor ticker semantics](../../../DATA_DESIGN.md) for the as-of-date-vs-current-labeled framing that gold relies on, and [`bronze_to_gold_mapping.md`](./bronze_to_gold_mapping.md) for the resolution contract.

> **Note on `lastupdated` (→ `vendor_as_of_ts`):** For Sharadar this column normally moves only because the vendor re-adjusted a row for a later split or dividend, not because the underlying values were corrected - so it **cannot be used for restatement detection**. We still stamp it as `vendor_as_of_ts` for provenance, but treat it as an adjustment marker, not a freshness / CDC signal.

| Table   | Stable identity in bronze                                                 | Why                                                                                                                                                                         |
| ------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| TICKERS | `vendor_record_id` = `permaticker`                                        | Already keyed on permaticker; a rename writes a new SCD row (the ticker timeline).                                                                                          |
| ACTIONS | `vendor_record_id` = `permaticker` of the event **anchor** (from TICKERS) | Change-detected; keying on the anchor permaticker keeps full re-ingest idempotent across renames. Mirror pairs (acquisition/merger/spinoff/ticker-change) merge to one row. |
| SEP/SFP | raw `ticker` only                                                         | Plain append, ingested incrementally by date - never full-reingested, so no rename dup. Resolved current-ticker -> permaticker in gold.                                     |
| DAILY   | raw `ticker` only                                                         | Plain append (same as SEP/SFP); written once per date, no stable key needed. Operational dups + restatements deduped in gold.                                               |

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

### Incremental loading & restatements

After the one-time year-partitioned backfill, SEP (and the analogous DAILY metrics feed) is kept current with a `lastupdated`-watermark incremental: each run pulls rows whose `lastupdated` (→ `vendor_as_of_ts`) exceeds the highest already in bronze. That window contains both new trading days and any **restated** past-dated rows the vendor recomputed since the last run. Restated rows (newer `vendor_as_of_ts`) and operational duplicates from retries (same `vendor_as_of_ts`, identical content) are both collapsed in gold by keeping the latest per `(resolved identity, date)` on `vendor_as_of_ts DESC, ingested_at DESC`. See [`DATA_DESIGN.md` → Incremental ingestion & restatements](../../../DATA_DESIGN.md).

---

## SFP table

Same fields as SEP but for funds, treated the same way.

---

## DAILY table -> `BRONZE_FACT_DAILY_METRICS`

Daily, market-price-driven valuation metrics: one row per security per trading
day. Handled exactly like SEP/SFP - a plain append (no `record_hash`), kept current
by the same `lastupdated`-watermark incremental, with operational dups and
restatements collapsed in gold on `(resolved identity, metric_date)`.

| Sharadar field | Bronze column       | Notes                                                                       |
| -------------- | ------------------- | --------------------------------------------------------------------------- |
| `ticker`       | `ticker`            |                                                                             |
| `date`         | `metric_date`       | Trade date of the price observations used in the metrics                    |
| `marketcap`    | `market_cap`        | **\* 1,000,000** - Sharadar reports in USD millions; stored as absolute USD |
| `ev`           | `enterprise_value`  | **\* 1,000,000** - USD millions -> absolute USD                             |
| -              | `ev_currency`       | Hardcoded to `'USD'` (Sharadar is US-only)                                  |
| `evebit`       | `ev_to_ebit`        |                                                                             |
| `evebitda`     | `ev_to_ebitda`      |                                                                             |
| `pb`           | `price_to_book`     |                                                                             |
| `pe`           | `price_to_earnings` |                                                                             |
| `ps`           | `price_to_sales`    |                                                                             |
| `lastupdated`  | `vendor_as_of_ts`   |                                                                             |

> TODO: Add SF1 mapping later

---

## ACTIONS table -> `BRONZE_FACT_CORPORATE_ACTIONS`

### Common column mapping (all ingested action types)

| Sharadar field                              | Bronze column                     | Notes                                                                                                                                                                                    |
| ------------------------------------------- | --------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `permaticker` (from TICKERS, anchor symbol) | `vendor_record_id`                | Joined from the same-pull TICKERS export on the **anchor** symbol; falls back to a namespaced `UNRESOLVED:<symbol>` if unmatched. See "Identity, mirror pairs & change detection" below. |
| anchor symbol (`ticker` or `contraticker`)  | `ticker`                          | The anchor security's **current** symbol (name-adjusted). A faithful label, not the identity; excluded from `record_hash`.                                                               |
| `date`                                      | `effective_date`                  | Meaning varies by action type (see below)                                                                                                                                                |
| `action`                                    | `raw_action_type`                 | Raw Sharadar value, except mirror pairs are merged to one synthesized value (`acquisition` / `merger` / `spinoff` / `tickerchange`)                                                      |
| `action`                                    | `action_type`                     | Normalised - see mapping table below                                                                                                                                                     |
| counterparty symbol / name                  | `related_ticker` / `related_name` | The non-anchor party (acquirer, surviving company, spun-off entity); `N/A` -> `NULL`. NULL for ticker changes (old/new go to `change_*`).                                                |
| `name`                                      | `NULL`                            | Dropped - entity name, not an action attribute                                                                                                                                           |

`source_vendor` is hardcoded to `'SHARADAR'` for all rows.

### Identity, mirror pairs & change detection

Because Sharadar relabels `ticker` to the current symbol on every row (see the top of this doc), the connector resolves a **stable identity** for each action by joining the same-pull TICKERS export (`ticker -> permaticker`), written as `vendor_record_id`. The join is built once per run from the same TICKERS file ingested into `security_master`, and is unique within a snapshot because Sharadar disambiguates reused symbols as `S`/`S1`/`S2` and includes delisted securities (so historical events still resolve).

**Anchor identity.** Multi-party events are keyed on the **anchor** - the Sharadar-tracked security the event belongs to - not the row's raw `ticker`:

| Event           | Anchor (`vendor_record_id`, `ticker`) | Counterparty (`related_ticker`)   |
| --------------- | ------------------------------------- | --------------------------------- |
| Acquisition     | the **acquired** company              | the acquirer                      |
| Merger          | the **non-surviving** company         | the surviving company             |
| Spinoff         | the **parent**                        | the spun-off entity               |
| everything else | the row's own `ticker`                | `contraticker` (where applicable) |

This matters because for the mirror perspectives (`acquisitionof`, `mergerto`, `spunofffrom`) the row's `ticker` is the _counterparty_ - frequently a private/PE/foreign acquirer reported as `N/A`. Keying on the anchor (which is always an in-universe security on the contra side there) keeps `vendor_record_id` resolvable; keying on the raw `ticker` would stamp `vendor_record_id = 'N/A'` and silently collapse unrelated deals.

In the rare case the anchor itself is absent from TICKERS (old/delisted/foreign - ~6 rows in the full history), `vendor_record_id` falls back to a **namespaced** `UNRESOLVED:<symbol>` rather than a bare ticker. The prefix can never collide with a real (numeric) permaticker, and the `effective_date` in the natural key keeps temporally-separated reuses of a symbol distinct; gold detects the prefix and resolves these via the counterparty's CUSIP/FIGI or routes them to `fact_identifier_conflicts`.

**Mirror merge.** Sharadar delivers these events as multiple rows - the same deal from each side. The connector collapses each into **one** bronze row keyed on the anchor (`acquisitionby`+`acquisitionof` -> one `acquisition`; `mergerfrom`+`mergerto` -> one `merger`; `spinoff`+`spunofffrom`+`spinoffdividend` -> one `spinoff`; `tickerchangefrom`+`tickerchangeto` -> one `tickerchange`), recovering the counterparty / old+new symbols / dollar valuation from whichever side carried them.

- **Natural key:** `(source_vendor, vendor_record_id, effective_date, raw_action_type)`. The merged `raw_action_type` keeps these grouped rows from fanning out; it still separates genuinely distinct same-day events (e.g. a same-day `spinoff` and `dividend` on one parent).
- **`record_hash` excludes `ticker`** (on top of the standard provenance columns). A rename changes only the (excluded) `ticker`, so the hash is unchanged and no new version is written - a full ACTIONS re-ingest stays idempotent across renames. The current symbol remains recoverable from `security_master` and `TICKER_CHANGE` events; the stored `ticker` reflects whichever symbol was current when the row was first written.
- **Version ordering (`as_of`) is `ingested_at`.** Since this table is a historical table (unlike the `TICKERS` table which is point-in-time), `effective_date` has to be in the key, so a full re-ingest carries one version per key, a vendor correction to a past event is a later run (where `ingested_at` would be different). Sharadar ACTIONS exposes no `lastupdated`, so there is no vendor freshness signal to fall back on either.

Operationally, ACTIONS is re-ingested in full each run (it is small) and the change-detected append keeps storage bounded. This requires the TICKERS export to be staged alongside ACTIONS - the Dagster `sharadar_corporate_actions` asset passes it as `tickers_source`. Other tables like OHLCV don't have this issue since unlike here not the entire table is re-ingested, just the newest rows.

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

Anchored on the **parent**; `related_ticker` = the spun-off entity. All three are the **same** corporate event - a single share distribution - delivered three ways: `spinoff` (share ratio) and `spunofffrom` (mirror perspective, share ratio) and `spinoffdividend` (that same distribution valued in dollars).

| `action`          | `ticker` is     | `contraticker` is | anchor (parent) is |
| ----------------- | --------------- | ----------------- | ------------------ |
| `spinoff`         | Parent company  | Spunoff company   | `ticker`           |
| `spinoffdividend` | Parent company  | Spunoff company   | `ticker`           |
| `spunofffrom`     | Spunoff company | Parent company    | `contraticker`     |

| Sharadar field                    | Bronze column                     | Notes                                                                                      |
| --------------------------------- | --------------------------------- | ------------------------------------------------------------------------------------------ |
| `action`                          | `action_type`                     | `SPINOFF`                                                                                  |
| `action`                          | `raw_action_type`                 | `spinoff` (merged from `spinoff`+`spunofffrom`+`spinoffdividend`)                          |
| `date`                            | `effective_date`                  | Date of the spinoff transaction (identical across all three)                               |
| `value` (`spinoff`/`spunofffrom`) | `distribution_ratio`              | Shares of spunoff entity per share of parent                                               |
| `value` (`spinoffdividend`)       | `distribution_value`              | USD/share dollar value of that same distribution (initially split-adjusted, we de-adjust). |
| spunoff symbol / name             | `related_ticker` / `related_name` | The spun-off entity (the non-parent side)                                                  |

#### Acquisitions: `acquisitionby`, `acquisitionof`

`acquisitionby` and `acquisitionof` are the same deal from each side and **merge** into one `acquisition` row, anchored on the **acquired** company (always in-universe); `related_ticker` = the acquirer (often private/foreign -> `N/A` -> `NULL`).

| `action`        | `ticker` is       | `contraticker` is | anchor (acquired) is |
| --------------- | ----------------- | ----------------- | -------------------- |
| `acquisitionby` | Acquired company  | Acquiring company | `ticker`             |
| `acquisitionof` | Acquiring company | Acquired company  | `contraticker`       |

| Sharadar field         | Bronze column                     | Notes                                                       |
| ---------------------- | --------------------------------- | ----------------------------------------------------------- |
| `action`               | `action_type`                     | `ACQUISITION`                                               |
| `action`               | `raw_action_type`                 | `acquisition` (merged from `acquisitionby`+`acquisitionof`) |
| `date`                 | `effective_date`                  | Last trade date of the acquired company                     |
| acquirer symbol / name | `related_ticker` / `related_name` | The acquiring company (the non-acquired side)               |
| `value`                | `NULL`                            | Dropped - final market cap of acquired company (USD M)      |

#### Mergers: `mergerfrom`, `mergerto`

`mergerfrom` and `mergerto` are the same merger from each side and **merge** into one `merger` row, anchored on the **non-surviving** company; `related_ticker` = the surviving company.

| `action`     | `ticker` is           | `contraticker` is     | anchor (non-surviving) is |
| ------------ | --------------------- | --------------------- | ------------------------- |
| `mergerfrom` | Surviving company     | Non-surviving company | `contraticker`            |
| `mergerto`   | Non-surviving company | Surviving company     | `ticker`                  |

| Sharadar field          | Bronze column                     | Notes                                                       |
| ----------------------- | --------------------------------- | ----------------------------------------------------------- |
| `action`                | `action_type`                     | `MERGER`                                                    |
| `action`                | `raw_action_type`                 | `merger` (merged from `mergerfrom`+`mergerto`)              |
| `date`                  | `effective_date`                  | Last trade date of the non-surviving company                |
| surviving symbol / name | `related_ticker` / `related_name` | The surviving company (the non-anchor side)                 |
| `value`                 | `NULL`                            | Dropped - final market cap of non-surviving company (USD M) |

#### Ticker changes: `tickerchangefrom`, `tickerchangeto`

Sharadar delivers a change as a paired `tickerchangefrom` + `tickerchangeto` on the same `(ticker, date)`. We **merge** the pair into one `tickerchange` row, anchored on the (current) `ticker`, with both symbols populated:

| `action`           | `ticker` is               | `contraticker` is         |
| ------------------ | ------------------------- | ------------------------- |
| `tickerchangefrom` | Current ticker in dataset | Old ticker (changed from) |
| `tickerchangeto`   | Current ticker in dataset | New ticker (changed to)   |

| Sharadar field                      | Bronze column      | Notes                                         |
| ----------------------------------- | ------------------ | --------------------------------------------- |
| `action`                            | `action_type`      | `TICKER_CHANGE`                               |
| `action`                            | `raw_action_type`  | `tickerchange` (merged from the from/to pair) |
| `date`                              | `effective_date`   | Effective date of the ticker change           |
| `contraticker` (`tickerchangefrom`) | `change_old_value` | The ticker that was changed from              |
| `contraticker` (`tickerchangeto`)   | `change_new_value` | The ticker that was changed to                |

There's one big caveat, if a tickername was handed off between different companies, there will be a number added at the end. E.g. ticker "S" is a good example. It changed ownership 3 times so there is "S", "S1" and "S2" in the dataset. In our dataset we should just have "S" since disambiguation is on the instrument level (CUSIP/Composite FIGI).

Note here that "S" will be the **current** company that has this ticker, "S1" will be the **first** company that ever held this ticker, "S2" will be the second, if the current company gives the ticket up for another one it would become "S3" and the new company would be "S".

We can't use the `related_ticker` column since it would break for a company that changed it's name twice, since Sharadar will always use the first ticker name a ticker that changed from A -> B -> C would produce these rows:

| ticker | related_ticker | Notes                |
| ------ | -------------- | -------------------- |
| A      | B              |                      |
| A      | C              | <- should be B and C |

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

| Sharadar field | Bronze column    | Notes                                                         |
| -------------- | ---------------- | ------------------------------------------------------------- |
| `action`       | `action_type`    | `LISTING`                                                     |
| `date`         | `effective_date` | First trade date on exchange                                  |
| `value`        | `NULL`           | Dropped - initial market cap (USD M)                          |
| `contraticker` | `related_ticker` | Original name of the company (in case it changed ticker name) |

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
| `permaticker`        | `vendor_record_id`   | Vendor's permanent numeric identifier                                                                                                                        |
| `ticker`             | `ticker`             |                                                                                                                                                              |
| `name`               | `entity_name`        |                                                                                                                                                              |
| `exchange`           | `operating_mic`      | Needs mapping, e.g. `NYSE` -> `XNYS`, `NASDAQ` -> `XNAS`                                                                                                     |
| `isdelisted`         | `listing_status`     | `Y` -> `DELISTED`, `N` -> `ACTIVE`                                                                                                                           |
| `category`           | `instrument_type`    | e.g. `Domestic Common Stock`                                                                                                                                 |
| `cusips`             | `cusip`              | Space-separated list of all CUSIPs for this security over time. First token -> `cusip` (primary/current); full list parsed into `cusip_history`              |
| `cusips`             | `cusip_history`      | Same source field, parsed into a `list<string>` of every CUSIP ever associated with this instrument                                                          |
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
| `location`           | `hq_location`        | e.g. `California; U.S.A`                                                                                                                                     |
| `lastupdated`        | `vendor_as_of_ts`    |                                                                                                                                                              |
| `firstadded`         | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `firstpricedate`     | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `lastpricedate`      | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `firstquarter`       | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `lastquarter`        | `NULL`               | Dropped - Sharadar internal metadata                                                                                                                         |
| `secfilings`         | `cik`                | CIK can be extracted from URL                                                                                                                                |
| `companysite`        | `company_website`    |                                                                                                                                                              |
| `table`              | `NULL`               | Dropped from output, but used to exclude institutional investors, deduplicate, and split `currency` into `trading_currency`/`reporting_currency` (see below) |

`source_vendor` is hardcoded to `'SHARADAR'` for all rows. `snapshot_date` is set to the ingestion date since the TICKERS table doesn't carry its own snapshot date. SCD `as_of` that orders a security's versions on the ticker timeline is the `ingested_at` column since this is not a time-travel feed we have to rely on our ingest time. See `DATA_DESIGN.md` for details.

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
