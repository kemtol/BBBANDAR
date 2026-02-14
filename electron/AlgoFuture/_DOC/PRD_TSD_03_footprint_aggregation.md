# PRD & TSD — Footprint Aggregation Engine

## PRD

### Objective
Aggregate tick/trade events into time-framed footprint candles (1m/5m/15m) with volume profile, POC, Value Area (70%), VWAP, delta and speed stats for each candle.

### Success Metrics
- Candle finalization latency < 100 ms after timeframe end
- POC/VA computations reproduce results from replay data
- No floating point drift (use integer tick indices)

### Stakeholders
- Strategies, Dashboard, Backtester

---

## TSD

### Overview
`FootprintAggregator` consumes normalized `trade` and `quote` events and maintains `currentCandle` per timeframe. On candle boundary, finalizes and emits `candle-closed` with derived analytics.

### Interfaces
- `constructor(symbol, tickSize)`
- `processTrade(trade)` — trade normalized object
- `processQuote(quote)` — optional quote-driven updates
- Events: `on('candle-closed', (candle) => {})`, `on('partial', (candle) => {})`

### Data Model (candle)
See example schema: `{ symbol, timeframe, time, ohlc_pt, ohlc, vol, delta, profile, poc, vah, val, vwap, trade_stats, quote_stats, quality }`
- `profile` keyed by integer tick index: `{pt: {bv, av}}`

### Important Algorithms
- Integer tick index conversion using tickSize to avoid FP issues
- POC: highest total volume level
- Value area: accumulate levels sorted by volume until 70% total
- VWAP: volume-weighted price from profile

### Edge Cases
- Late trades: log and drop by default; optionally attach to historical candle if config allows
- Burst handling: queue buffer with flush policy

### Persistence
- Emit finalized candles to `data/footprints-cache.json` and optional R2 storage

### Tests
- Unit: POC, VA, VWAP calculators
- Replay: feed raw sample files from `QQQUANTA/workers/.../raw_tns` and assert outputs

### Effort Estimate
3–5 dev days (impl + replay tests)
