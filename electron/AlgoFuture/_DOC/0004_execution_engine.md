# 0004 — Execution Engine (Order Management)

> **Layer:** Engine  
> **Module:** [`core/engine/executor.js`](../core/engine/executor.js)  
> **Depends on:** Compliance rules, Position manager

---

## 1. Purpose

Convert strategy signals into orders and manage order lifecycle:

```
Strategy Signal
  ↓
Pre-check: Compliance + Position limits
  ↓
Build Order Payload
  ↓
Submit to Broker API (NinjaTrader stub)
  ↓
Wait for Fill Confirmation
  ↓
Update Position Manager
  ↓
Emit Events to Dashboard
```

---

## 2. Order Types

### **Supported**
- [ ] Market Order
- [ ] Limit Order
- [ ] Stop Loss (phantom, local management)
- [ ] Take Profit (phantom, local management)

### **Not Supported (MVP)**
- Cancel/Amend
- OCO (One-Cancels-Other)
- Bracket Orders

---

## 3. Order Lifecycle

```
PENDING
  ↓
ACCEPTED (broker ack)
  ↓
FILLED (at price)
  ↓
CLOSED (via exit)
```

---

## 4. API Signatures

### **Place BUY Order**

```javascript
executor.placeBuy({
  symbol: 'ENQ',           // Or 'ES', 'GC'
  qty: 2,                  // Contracts
  price: 4850.25,          // For limit orders
  type: 'LIMIT',           // 'LIMIT' | 'MARKET'
  stopPrice: 4840.00,      // Optional: phantom stop loss
  takeProfit: 4860.00,     // Optional: phantom TP
})
→ Promise<{orderId, status, ...}>
```

### **Place SELL Order**

```javascript
executor.placeSell({
  symbol: 'ENQ',
  qty: 1,  // Liquidate 1 contract
  price: 4851.00,
  type: 'LIMIT'
})
→ Promise<{orderId, status}>
```

### **Close All Positions**

```javascript
executor.flattenAll()
→ Promise<{closedPositions: [{symbol, qty, exitPrice}]}>
```

---

## 5. Implementation Sketch

```javascript
class ExecutionEngine extends EventEmitter {
  constructor(compliance, positionManager, brokerAPI) {
    super();
    this.compliance = compliance;
    this.positions = positionManager;
    this.broker = brokerAPI;  // NinjaTrader stub or real API
    this.orderId = 0;
    this.orders = {};  // {orderId -> order state}
  }

  async placeBuy(params) {
    // 1. Pre-check
    const check = this.compliance.canSubmitOrder({
      symbol: params.symbol,
      side: 'BUY',
      qty: params.qty
    });

    if (!check.allowed) {
      this.emit('order-rejected', {
        params,
        reason: check.reason,
        message: check.message
      });
      return { orderId: null, status: 'REJECTED', ...check };
    }

    // 2. Build order
    const orderId = ++this.orderId;
    const order = {
      orderId,
      symbol: params.symbol,
      side: 'BUY',
      qty: params.qty,
      price: params.price,
      type: params.type,
      status: 'PENDING',
      submitTime: Date.now(),
      stopPrice: params.stopPrice,
      takeProfit: params.takeProfit
    };

    // 3. Submit
    console.log(`[EXECUTOR] Submitting order #${orderId}:`, order);
    this.orders[orderId] = order;

    try {
      const result = await this.broker.submitOrder(order);
      order.status = 'ACCEPTED';
      order.brokerOrderId = result.orderId;
      this.emit('order-accepted', order);

      // Monitor fill
      this.waitForFill(orderId);
      return { orderId, status: 'ACCEPTED' };
    } catch (err) {
      order.status = 'FAILED';
      this.emit('order-failed', { orderId, error: err.message });
      return { orderId, status: 'FAILED', error: err.message };
    }
  }

  async placeSell(params) {
    // Same as placeBuy but side: 'SELL'
    // Also: check if position exists
  }

  async waitForFill(orderId) {
    // Poll broker API or listen to stream
    // When filled, call onOrderFilled()
  }

  onOrderFilled(orderId, fillPrice) {
    const order = this.orders[orderId];
    order.status = 'FILLED';
    order.fillPrice = fillPrice;
    order.fillTime = Date.now();

    // Update position
    this.positions.updatePosition({
      symbol: order.symbol,
      side: order.side,
      qty: order.qty,
      entryPrice: fillPrice,
      orderId
    });

    // Trigger risk management
    if (order.stopPrice) {
      this.attachPhantomStop(orderId, order.stopPrice);
    }

    this.emit('order-filled', order);
  }

  attachPhantomStop(orderId, stopPrice) {
    // Start watching price for auto-exit
    // If price hits stopPrice, auto-sell
    console.log(`[EXECUTOR] Phantom stop attached: ${stopPrice}`);
  }

  async flattenAll() {
    const positions = this.positions.getAll();
    const closedPositions = [];

    for (const pos of positions) {
      if (pos.qty > 0) {
        const result = await this.placeSell({
          symbol: pos.symbol,
          qty: pos.qty,
          type: 'MARKET'
        });
        closedPositions.push({
          symbol: pos.symbol,
          qty: pos.qty,
          orderId: result.orderId
        });
      }
    }

    this.emit('flatten-executed', { closedPositions });
    return { closedPositions };
  }
}
```

---

## 6. Mock Broker API (MVP)

For testing without real broker:

```javascript
class MockBrokerAPI {
  async submitOrder(order) {
    // Simulate order submission
    const orderId = Math.random().toString(36).substr(2, 9);
    console.log(`[MOCK-BROKER] Order ${orderId} submitted`);

    // Simulate fill after random delay (100-500ms)
    const delay = Math.random() * 400 + 100;
    setTimeout(() => {
      // Add slight slippage
      const slippage = Math.random() * 0.05 - 0.025;
      const fillPrice = order.price + slippage;
      this.emit('order-filled', { orderId, fillPrice });
    }, delay);

    return { orderId };
  }
}
```

---

## 7. Real Broker Integration (NinjaTrader)

Stub for future implementation:

```javascript
class NinjaTraderAPI {
  constructor(config) {
    // config = {host, port, account, username, password}
    this.api = new NTConnection(config);
  }

  async submitOrder(order) {
    const payload = {
      Action: order.side === 'BUY' ? 'BUY' : 'SELL',
      Instrument: this.symbolToNT(order.symbol),  // 'NQ' for ENQ
      Quantity: order.qty,
      OrderType: order.type === 'LIMIT' ? 'Limit' : 'Market',
      LimitPrice: order.price,
      Account: this.account
    };

    const response = await this.api.send(payload);
    return { orderId: response.OrderId };
  }

  symbolToNT(symbol) {
    const map = { 'ENQ': 'NQ', 'ES': 'ES', 'GC': 'GC' };
    return map[symbol] || symbol;
  }
}
```

---

## 8. Phantom Stop/TP Management

```javascript
class PhantomRiskManager {
  constructor(priceFeed) {
    this.priceFeed = priceFeed;  // Realtime trade stream
    this.stops = {};  // {orderId -> {stopPrice, type}}
  }

  attachStop(orderId, stopPrice, takeProfit) {
    this.stops[orderId] = {
      stopPrice,
      takeProfit,
      triggered: false
    };

    // Listen to price feed
    this.priceFeed.on('trade', (trade) => {
      this.checkStops(trade);
    });
  }

  checkStops(trade) {
    for (const [orderId, stop] of Object.entries(this.stops)) {
      if (stop.triggered) continue;

      // Check stop loss
      if (trade.price <= stop.stopPrice) {
        console.log(`[PHANTOM] Stop hit! Price ${trade.price} <= ${stop.stopPrice}`);
        this.emit('stop-triggered', { orderId, price: trade.price });
        stop.triggered = true;
        // Auto-sell via executor
      }

      // Check take profit
      if (trade.price >= stop.takeProfit) {
        console.log(`[PHANTOM] TP hit! Price ${trade.price} >= ${stop.takeProfit}`);
        this.emit('tp-triggered', { orderId, price: trade.price });
        stop.triggered = true;
      }
    }
  }
}
```

---

## 9. Integration with Dashboard

```javascript
// From main.js:
executor.on('order-submitted', (order) => {
  mainWindow.getBrowserViews()[1].webContents.send('order-log', {
    orderId: order.orderId,
    action: 'SUBMIT',
    symbol: order.symbol,
    side: order.side,
    qty: order.qty,
    price: order.price,
    timestamp: new Date().toISOString()
  });
});

executor.on('order-filled', (order) => {
  mainWindow.getBrowserViews()[1].webContents.send('order-log', {
    orderId: order.orderId,
    action: 'FILL',
    fillPrice: order.fillPrice,
    timestamp: new Date().toISOString()
  });

  // Also update position display
  const pos = positions.get(order.symbol);
  mainWindow.getBrowserViews()[1].webContents.send('position-update', {
    symbol: order.symbol,
    qty: pos.qty,
    avgPrice: pos.avgPrice,
    unrealizedPnL: pos.pnl
  });
});
```

---

## 10. Checklist

- [ ] `ExecutionEngine` class with buy/sell/flatten
- [ ] Order state tracking (PENDING → ACCEPTED → FILLED)
- [ ] Compliance check before order submission
- [ ] Position update on fill
- [ ] Phantom stop/TP attachment
- [ ] Mock broker API for testing
- [ ] NinjaTrader API stub (for future)
- [ ] Order log emission to dashboard
- [ ] Error handling & retry logic
- [ ] Unit tests

---

> **See also:**  
> - [0003 Compliance Rules](./0003_topstep_compliance.md)  
> - [0001 Architecture](./0001_architecture_futures.md)
