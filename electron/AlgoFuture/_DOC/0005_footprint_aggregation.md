# 0005 — Footprint Aggregation & Volume Profile

> **Layer:** Engine  
> **Module:** [`core/engine/footprint.js`](../core/engine/footprint.js)  
> **Depends on:** Trade stream ([0002](./0002_signalr_websocket.md))

---

## 1. Real-Time Candle Building

### **Multi-Timeframe Support**

```javascript
const timeframes = {
  '1m':  60 * 1000,
  '5m':  5 * 60 * 1000,
  '15m': 15 * 60 * 1000,
  '30m': 30 * 60 * 1000,
  '1h':  60 * 60 * 1000
};
```

### **Tick-Based Volume Profile**

Each candle maintains a **footprint** (price-level volume breakdown):

```javascript
candle = {
  // Metadata
  symbol: 'F.US.ENQ',
  timeframe: '5m',
  time: 1707567000000,        // UTC epoch (candle start)
  t0: '2025-02-10T14:30:00Z',
  t1: '2025-02-10T14:35:00Z',
  
  // OHLC (in ticks for accuracy)
  ohlc_pt: { o: 19400, h: 19405, l: 19400, c: 19403 },  // Tick indices
  ohlc: {    // Prices for display
    o: 4850.00,
    h: 4851.25,
    l: 4850.00,
    c: 4850.75
  },
  
  // Volume aggregates
  vol: 1250,          // Total contracts traded
  delta: 750,         // Buy volume - Sell volume
  bid_vol: 500,       // Volume at or below best bid
  ask_vol: 750,       // Volume at or above best ask
  
  // Volume profile (footprint)
  profile: {
    19405: { bid: 0, ask: 150 },  // Level 4851.25 → 150 contracts (ask)
    19404: { bid: 100, ask: 200 }, // Level 4851.00
    19403: { bid: 200, ask: 100 }, // Level 4850.75
    19402: { bid: 150, ask: 50 },  // Level 4850.50
    19401: { bid: 50, ask: 0 },    // Level 4850.25 → 50 contracts (bid)
    19400: { bid: 0, ask: 0 }      // Level 4850.00
  },
  
  // Derived analytics
  poc: 4850.75,       // Point of Control (highest volume level)
  poc_pt: 19403,
  vah: 4851.00,       // Value Area High (top of 70% volume)
  val: 4850.50,       // Value Area Low
  vah_pt: 19404,
  val_pt: 19402,
  va_vol: 875,        // Volume in value area
  vwap: 4850.68,      // Volume-weighted average price
  
  // Trade statistics
  trade_stats: {
    count: 85,                  // Total trades
    buy_count: 50,
    sell_count: 35,
    size_avg: 14.7,             // Avg contract size
    size_max: 25,
    size_min: 1,
    large_trades: 12            // Trades > 10 contracts
  },
  
  // Quote statistics
  quote_stats: {
    updates: 450,               // Quote update count
    spread_min: 0.25,
    spread_max: 0.50,
    spread_avg: 0.28,
    mid_first: 4850.10,         // First mid price
    mid_last: 4850.75           // Last mid price
  },
  
  // Speed analysis
  speed_stats: {
    first_trade_ts: 1707567010000,
    last_trade_ts: 1707567295000,
    trades_per_sec_avg: 4.8,
    min_gap_ms: 50,             // Smallest time between trades
    max_gap_ms: 2500            // Largest gap (low volume period)
  },
  
  // Quality audit
  quality: {
    aggressor_confidence: 0.85,  // % of trades with bid/ask context
    late_trades: 0,              // Trades outside candle window
    parse_errors: 0
  },
  
  // Status
  flushed: false,               // Has been saved to disk
  closed: true                  // Candle finished
};
```

---

## 2. Aggregation Algorithm

```javascript
class FootprintAggregator {
  constructor(symbol, timeframe, tickSize) {
    this.symbol = symbol;
    this.timeframe = timeframe;  // ms
    this.tickSize = 0.25;        // For ENQ
    this.currentCandle = null;
  }

  // Called on each trade from SignalR
  processTrade(trade) {
    // trade = {price, volume, side, timestamp}
    
    const bucketTs = Math.floor(trade.timestamp / this.timeframe) * this.timeframe;

    // Check candle boundary
    if (this.currentCandle && bucketTs > this.currentCandle.time) {
      // New candle → finalize old one
      this.emit('candle-closed', this.currentCandle);
      this.initCandle(bucketTs, trade.price);
    } else if (!this.currentCandle) {
      this.initCandle(bucketTs, trade.price);
    }

    // Add trade to current candle
    this.updateCandle(this.currentCandle, trade);
  }

  initCandle(ts, firstPrice) {
    const pt = this.priceToTick(firstPrice);
    
    this.currentCandle = {
      symbol: this.symbol,
      timeframe: this.timeframe,
      time: ts,
      t0: new Date(ts).toISOString(),
      t1: new Date(ts + this.timeframe).toISOString(),
      
      ohlc_pt: { o: pt, h: pt, l: pt, c: pt },
      ohlc: { o: firstPrice, h: firstPrice, l: firstPrice, c: firstPrice },
      
      vol: 0,
      delta: 0,
      bid_vol: 0,
      ask_vol: 0,
      profile: {},
      
      trade_stats: {
        count: 0, buy_count: 0, sell_count: 0,
        size_sum: 0, size_max: 0, large_trades: 0, large_vol: 0
      },
      quote_stats: {
        updates: 0, spread_min: Infinity, spread_max: 0, spread_sum: 0, ...
      },
      speed_stats: {
        first_trade_ts: 0, last_trade_ts: 0, ...
      },
      quality: { aggressor_confidence: 0, late_trades: 0 },
      
      flushed: false,
      closed: false
    };
  }

  updateCandle(c, trade) {
    const pt = this.priceToTick(trade.price);

    // Update OHLC
    c.ohlc_pt.h = Math.max(c.ohlc_pt.h, pt);
    c.ohlc_pt.l = Math.min(c.ohlc_pt.l, pt);
    c.ohlc_pt.c = pt;
    c.ohlc.c = trade.price;

    // Volume aggregates
    c.vol += trade.volume;
    if (trade.side === 'BUY') {
      c.delta += trade.volume;
      c.ask_vol += trade.volume;
      c.trade_stats.buy_count++;
    } else {
      c.delta -= trade.volume;
      c.bid_vol += trade.volume;
      c.trade_stats.sell_count++;
    }

    // Profile (footprint)
    if (!c.profile[pt]) c.profile[pt] = { bid: 0, ask: 0 };
    if (trade.side === 'BUY') {
      c.profile[pt].ask += trade.volume;
    } else {
      c.profile[pt].bid += trade.volume;
    }

    // Trade stats
    c.trade_stats.count++;
    c.trade_stats.size_sum += trade.volume;
    c.trade_stats.size_max = Math.max(c.trade_stats.size_max, trade.volume);
    if (trade.volume > LARGE_TRADE_THRESHOLD) {
      c.trade_stats.large_trades++;
      c.trade_stats.large_vol += trade.volume;
    }

    // Speed stats
    if (c.speed_stats.first_trade_ts === 0) {
      c.speed_stats.first_trade_ts = trade.timestamp;
    }
    c.speed_stats.last_trade_ts = trade.timestamp;
  }

  finalizeCandle(c) {
    // Calculate POC
    let maxVol = -1, pocPt = 0;
    const levels = [];
    const tickKeys = Object.keys(c.profile).map(Number).sort((a, b) => a - b);

    for (const pt of tickKeys) {
      const stats = c.profile[pt];
      const total = stats.bid + stats.ask;
      if (total > maxVol) {
        maxVol = total;
        pocPt = pt;
      }
      levels.push({
        pt,
        p: this.tickToPrice(pt),
        bv: stats.bid,
        av: stats.ask
      });
    }

    c.poc = this.tickToPrice(pocPt);
    c.poc_pt = pocPt;
    c.levels = levels;

    // Calculate value area (70% of volume)
    let vaVol = 0, vahPt = pocPt, valPt = pocPt;
    const vaTarget = c.vol * 0.7;
    const sortedByVol = [...levels].sort((a, b) => (b.av + b.bv) - (a.av + a.bv));

    for (const lv of sortedByVol) {
      vaVol += lv.av + lv.bv;
      vahPt = Math.max(vahPt, lv.pt);
      valPt = Math.min(valPt, lv.pt);
      if (vaVol >= vaTarget) break;
    }

    c.vah = this.tickToPrice(vahPt);
    c.val = this.tickToPrice(valPt);
    c.va_vol = vaVol;

    // Calculate VWAP
    let vwapNum = 0, vwapDenom = 0;
    for (const lv of levels) {
      const lvVol = lv.av + lv.bv;
      vwapNum += lv.p * lvVol;
      vwapDenom += lvVol;
    }
    c.vwap = vwapDenom > 0 ? vwapNum / vwapDenom : 0;

    // Finalize stats
    if (c.trade_stats.count > 0) {
      c.trade_stats.size_avg = c.trade_stats.size_sum / c.trade_stats.count;
    }
    if (c.quote_stats.updates > 0) {
      c.quote_stats.spread_avg = c.quote_stats.spread_sum / c.quote_stats.updates;
    }

    c.closed = true;
    return c;
  }

  priceToTick(price) {
    return Math.round((price / this.tickSize) + 1e-9);
  }

  tickToPrice(pt) {
    return parseFloat((pt * this.tickSize).toFixed(2));
  }
}
```

---

## 3. Footprint Visualization (Dashboard)

### **Text-based Footprint (Terminal style)**

```
┌──────────────────────────────────────────────────────────┐
│ ENQ 5m │ 14:30:00 - 14:35:00 │ OHLC: 4850.00 4851.25 4850.00 4850.75
├──────────────────────────────────────────────────────────┤
│ P  │ Volume│ Bid Vol │ Ask Vol │ Total │ % of Total      │
├──────────────────────────────────────────────────────────┤
│4851.25│   │         │  150    │  150  │ 12% ▓▓▓░░░░░░░░ │  VAH
│4851.00│   │   100   │  200    │  300  │ 24% ▓▓▓▓▓▓░░░░░ │  
│4850.75│   │   200   │  100    │  300  │ 24% ▓▓▓▓▓▓░░░░░ │  POC
│4850.50│   │   150   │   50    │  200  │ 16% ▓▓▓▓░░░░░░░ │  
│4850.25│   │    50   │    0    │   50  │  4% ▓░░░░░░░░░░ │  VAL
│4850.00│   │     0   │    0    │    0  │  0% ░░░░░░░░░░░ │

Volume Profile: 1250 contracts │ Delta: +750 │ VWAP: 4850.68
```

### **Canvas-based Chart (Web)**

For the right pane dashboard, use a library like:
- **TradingView Lightweight Charts** (for candle + volume)
- **Chart.js** (for volume bars)
- **Custom Canvas** (for footprint rectangle)

---

## 4. Export Format (R2 Storage)

```json
{
  "v": 3,
  "symbol": "F.US.ENQ",
  "timeframe": "5m",
  "time": 1707567000000,
  "t0": "2025-02-10T14:30:00Z",
  "t1": "2025-02-10T14:35:00Z",
  "ohlc": { "o": 4850.00, "h": 4851.25, "l": 4850.00, "c": 4850.75 },
  "vol": 1250,
  "delta": 750,
  "poc": 4850.75,
  "vah": 4851.00,
  "val": 4850.50,
  "vwap": 4850.68,
  "levels": [
    { "p": 4851.25, "bv": 0, "av": 150 },
    { "p": 4851.00, "bv": 100, "av": 200 },
    { "p": 4850.75, "bv": 200, "av": 100 },
    { "p": 4850.50, "bv": 150, "av": 50 },
    { "p": 4850.25, "bv": 50, "av": 0 }
  ],
  "trade_stats": { "count": 85, "buy_count": 50, "sell_count": 35, ... },
  "quality": { "aggressor_confidence": 0.85, "late_trades": 0 }
}
```

---

## 5. Checklist

- [ ] `FootprintAggregator` class
- [ ] Multi-timeframe support (1m, 5m, 15m, 30m, 1h)
- [ ] Integer tick index conversion
- [ ] Volume profile calculation
- [ ] POC, VAH, VAL, VWAP calculation
- [ ] Trade statistics (count, size, large trades)
- [ ] Quote statistics (spread, mid price)
- [ ] Speed analysis (trades/sec, gaps)
- [ ] Candle finalization & export
- [ ] R2 persistence
- [ ] Chart rendering (TradingView or custom)
- [ ] Unit tests

---

> **See also:**  
> - [0002 SignalR WebSocket](./0002_signalr_websocket.md)  
> - [0001 Architecture](./0001_architecture_futures.md)
