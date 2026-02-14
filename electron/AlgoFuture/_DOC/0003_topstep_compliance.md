# 0003 — Topstep Compliance Rules Engine

> **Layer:** Risk Management  
> **Module:** [`core/risk/compliance.js`](../core/risk/compliance.js)  
> **Depends on:** Position tracker, Daily P&L monitor

---

## 1. Account Limits (Step 1 Challenge)

### **Primary Rules**

| Rule | Threshold | Trigger | Action |
|------|-----------|---------|--------|
| **Daily Loss Limit** | -$1,000 | Cumulative P&L for the day | STOP trading |
| **Trailing Drawdown** | -$2,000 | Peak balance - current balance | ACCOUNT LOCKED |
| **Profit Target** | +$3,000 | Daily cumulative profit | PASS to Step 2 |
| **Min Trading Days** | 5 | Calendar days with trades | Consistency check |
| **Max Position Size** | 5 contracts | Per symbol | REJECT order |
| **No 30% Rule** | No single day > 30% | Monthly profit consistency | WARN only |

---

## 2. Rule Hierarchy & Enforcement

### **Priority Order**

1. **HARD STOP** (Account Lockout)
   - Trailing drawdown > $2,000
   - → Close all positions IMMEDIATELY
   - → Block all new orders
   - → Alert user

2. **DAILY STOP** (Trading Pause)
   - Daily P&L < -$700 (70% of limit)
   - → Stop new entries
   - → Allow exits only
   - → Alert user

3. **POSITION LIMIT** (Order Rejection)
   - Position size > 5 contracts
   - → Reject order
   - → Log violation

4. **SOFT WARNING** (UI Alert)
   - No 30% rule breached
   - Daily loss approaching limit
   - → Display in UI
   - → Non-blocking

---

## 3. Compliance State Object

```javascript
compliance = {
  // Account basics
  accountId: "TOPSTEP_ENQ_001",
  startDate: "2025-02-10",
  startBalance: 100000,  // Prop firm initial capital
  
  // Current session
  currentBalance: 99500,
  peakBalance: 100000,
  dailyPnL: -500,
  trailingDrawdown: 0,     // Peak - Current
  
  // Tracking
  tradingDaysCount: 3,
  totalPnL: 1000,          // Month-to-date
  dailyPnLHistory: [
    { date: "2025-02-10", pnl: 500 },
    { date: "2025-02-11", pnl: 300 },
    { date: "2025-02-12", pnl: 200 }
  ],
  
  // Status flags
  accountStatus: "ACTIVE",  // ACTIVE | PAUSED | LOCKED
  dailyStatus: "TRADING",   // TRADING | PAUSE | STOP
  
  // Violations
  violations: [
    {
      rule: "DAILY_LOSS_LIMIT",
      timestamp: "2025-02-10T14:30:00Z",
      threshold: -1000,
      actual: -500,
      action: "LOGGED"
    }
  ],
  
  // Progress
  profitProgress: 1000,     // Current P&L vs $3000 target
  progressPercent: 33,      // % of target
}
```

---

## 4. Implementation: Core Methods

### **4.1 Initialize**

```javascript
class ComplianceEngine {
  constructor(startBalance = 100000) {
    this.startBalance = startBalance;
    this.startDate = new Date().toISOString().split('T')[0];
    this.peakBalance = startBalance;
    this.currentBalance = startBalance;
    
    this.dailyPnL = 0;
    this.dailyPnLHistory = {};
    this.violations = [];
    this.accountStatus = 'ACTIVE';  // ACTIVE | PAUSED | LOCKED
  }

  // Called when position fills
  onPositionUpdate(position) {
    // position = {symbol, qty, entryPrice, currentPrice, pnl}
    
    // Recalc total P&L
    const totalPnL = sumAllPnL();
    this.currentBalance = this.startBalance + totalPnL;
    
    // Update trailing drawdown
    if (this.currentBalance > this.peakBalance) {
      this.peakBalance = this.currentBalance;
    }
    this.trailingDrawdown = this.peakBalance - this.currentBalance;
    
    // Check rules
    this.evaluateRules();
  }

  evaluateRules() {
    const today = new Date().toISOString().split('T')[0];
    this.dailyPnL = this.dailyPnLHistory[today] || 0;

    // Rule 1: Trailing Drawdown (ACCOUNT LOCKOUT)
    if (this.trailingDrawdown > 2000) {
      this.accountStatus = 'LOCKED';
      this.violations.push({
        rule: 'TRAILING_DRAWDOWN',
        threshold: 2000,
        actual: this.trailingDrawdown,
        action: 'ACCOUNT_LOCKED',
        timestamp: new Date()
      });
      return;  // Stop checking other rules
    }

    // Rule 2: Daily Loss (TRADING PAUSE)
    if (this.dailyPnL < -700) {
      this.accountStatus = 'PAUSED';
      this.violations.push({
        rule: 'DAILY_LOSS_LIMIT',
        threshold: -700,
        actual: this.dailyPnL,
        action: 'TRADING_PAUSED',
        timestamp: new Date()
      });
      return;
    }

    // Rule 3: Position Size checked at order submission (see executor.js)

    // Rule 4: Soft warning for 30% rule
    if (this.dailyPnL > this.totalPnL * 0.3) {
      this.violations.push({
        rule: 'NO_30_PCT_RULE',
        threshold: `${(this.totalPnL * 0.3).toFixed(0)}`,
        actual: this.dailyPnL,
        action: 'LOGGED',
        timestamp: new Date()
      });
    }

    // If we got here, no hard stops
    this.accountStatus = 'ACTIVE';
  }
}
```

### **4.2 Order Pre-Check**

```javascript
canSubmitOrder(orderParams) {
  // orderParams = {symbol, side, qty, price}

  if (this.accountStatus === 'LOCKED') {
    return {
      allowed: false,
      reason: 'ACCOUNT_LOCKED',
      message: 'Trailing drawdown exceeded. Account locked.'
    };
  }

  if (this.accountStatus === 'PAUSED' && orderParams.side === 'BUY') {
    return {
      allowed: false,
      reason: 'TRADING_PAUSED',
      message: 'Daily loss limit approaching. No new entries allowed.'
    };
  }

  // Check position size
  const currentQty = getPositionQty(orderParams.symbol);
  if (currentQty + orderParams.qty > 5) {
    return {
      allowed: false,
      reason: 'MAX_POSITION_EXCEEDED',
      message: `Position size limit: max 5 contracts, would be ${currentQty + orderParams.qty}`
    };
  }

  return {
    allowed: true
  };
}
```

### **4.3 Daily Reset (Scheduled)**

```javascript
onNewTradingDay() {
  const today = new Date().toISOString().split('T')[0];
  
  // Reset daily P&L
  this.dailyPnL = 0;
  this.dailyPnLHistory[today] = 0;
  this.tradingDaysCount++;
  
  // Reset account status (unless locked)
  if (this.accountStatus !== 'LOCKED') {
    this.accountStatus = 'ACTIVE';
  }
  
  console.log(`[COMPLIANCE] New trading day: ${today}. Account status: ${this.accountStatus}`);
}
```

### **4.4 Get Status for UI**

```javascript
getStatus() {
  return {
    accountStatus: this.accountStatus,
    dailyPnL: this.dailyPnL,
    trailingDrawdown: this.trailingDrawdown,
    totalPnL: sumAllPnL(),
    profitTarget: 3000,
    profitProgress: sumAllPnL(),
    progressPercent: Math.round((sumAllPnL() / 3000) * 100),
    
    // Flags for UI
    canTrade: this.accountStatus !== 'LOCKED' && this.accountStatus !== 'PAUSED',
    canEntry: this.accountStatus === 'ACTIVE',
    canExit: this.accountStatus !== 'LOCKED',
    
    // Warnings
    warningLevel: {
      daily: this.dailyPnL < -500 ? 'YELLOW' : this.dailyPnL < -700 ? 'RED' : 'OK',
      drawdown: this.trailingDrawdown > 1500 ? 'YELLOW' : this.trailingDrawdown > 2000 ? 'RED' : 'OK'
    },
    
    // Latest violations
    lastViolations: this.violations.slice(-5)
  };
}
```

---

## 5. Integration Points

### **5.1 With Executor Engine**

```javascript
// In executor.js, before submitting order:
const check = compliance.canSubmitOrder({
  symbol: 'ENQ',
  side: 'BUY',
  qty: 2,
  price: 4850.25
});

if (!check.allowed) {
  console.warn(`[EXECUTOR] Order rejected: ${check.message}`);
  emitter.emit('order-rejected', { reason: check.reason });
  return;
}

// Order approved, proceed
submitOrder(...);
```

### **5.2 With Position Manager**

```javascript
// In position_manager.js, on trade fill:
const position = {
  symbol: 'ENQ',
  qty: 2,
  entryPrice: 4850.25,
  currentPrice: 4851.00,
  pnl: (4851.00 - 4850.25) * 2 * 20  // ENQ multiplier
};

compliance.onPositionUpdate(position);

// Compliance auto-evaluates rules
```

### **5.3 With Dashboard (IPC)**

```javascript
// From main.js, on every position update:
const status = compliance.getStatus();
mainWindow.getBrowserViews()[1].webContents.send('compliance-status', status);

// Dashboard renders:
// - "Account Status: ACTIVE" (green) / "PAUSED" (yellow) / "LOCKED" (red)
// - Progress bar: 1000 / 3000 profit target
// - Daily P&L: -500 / -1000 limit
// - Drawdown: 500 / 2000 limit
```

---

## 6. Daily Reconciliation (EOD)

```javascript
onEndOfDay() {
  const today = new Date().toISOString().split('T')[0];
  const dailyResult = calculateDailyPnL(today);
  
  // Save to compliance log
  this.dailyPnLHistory[today] = dailyResult;
  this.totalPnL += dailyResult;
  
  // Update progress
  if (this.totalPnL >= 3000) {
    console.log("[COMPLIANCE] ✅ PASSED STEP 1! Profit target reached.");
    this.accountStatus = 'PASSED';
  }
  
  // Log to file
  fs.appendFileSync('data/compliance-log.json', JSON.stringify({
    date: today,
    dailyPnL: dailyResult,
    totalPnL: this.totalPnL,
    peakBalance: this.peakBalance,
    currentBalance: this.currentBalance,
    violations: this.violations.filter(v => v.timestamp.startsWith(today))
  }, null, 2) + ',\n');
}
```

---

## 7. Monitoring Dashboard UI (Right Pane)

### **Risk Indicators**

```html
<div class="risk-panel">
  <!-- Account Status -->
  <div class="status-badge" id="accountStatus">
    Account: <span class="status-active">ACTIVE</span>
  </div>
  
  <!-- Profit Progress -->
  <div class="progress-bar">
    <label>Profit Target: $3,000</label>
    <progress value="1000" max="3000"></progress>
    <span id="progressText">$1,000 / $3,000 (33%)</span>
  </div>
  
  <!-- Daily P&L -->
  <div class="limit-tracker">
    <label>Daily P&L</label>
    <div class="limit-bar" style="background: linear-gradient(...)">
      <span id="dailyPnL">-$500 / -$1,000</span>
    </div>
  </div>
  
  <!-- Trailing Drawdown -->
  <div class="limit-tracker">
    <label>Trailing Drawdown</label>
    <div class="limit-bar">
      <span id="drawdown">$500 / $2,000</span>
    </div>
  </div>
  
  <!-- Warnings -->
  <div id="violationsLog" class="log">
    <h4>Rule Violations</h4>
    <div id="violationsList"></div>
  </div>
</div>
```

---

## 8. Testing Scenarios

### **Test 1: Daily Loss Limit**
```javascript
// Start with $100k
// Trade 1: Buy 2 ENQ @ 4850, sell @ 4849
// Loss: (4849 - 4850) * 2 * 20 = -$40
// Daily P&L: -$40

// Trade 20: Each loses $50 → Total: -$1000
// Expected: canTrade() = false
assert.equal(compliance.accountStatus, 'PAUSED');
```

### **Test 2: Trailing Drawdown**
```javascript
// Start: Peak $100k, Current $98.5k
// Drawdown: 1.5k (OK)

// Trade more losses...
// Current falls to $98k, Drawdown = $2k
// Expected: accountStatus = 'LOCKED', all positions closed
assert.equal(compliance.accountStatus, 'LOCKED');
```

### **Test 3: Position Size Limit**
```javascript
// Try to buy: ENQ 3 contracts
// Current position: 3 contracts
// Total would be: 6 > max 5
// Expected: order rejected
assert.equal(executor.canSubmitOrder(...), false);
```

---

## 9. Checklist

- [ ] `compliance.js` created with all rule checks
- [ ] Integration with executor (pre-order validation)
- [ ] Integration with position manager (post-fill updates)
- [ ] Daily reset scheduler (midnight WIB)
- [ ] IPC messaging to dashboard
- [ ] Compliance log saved to JSON file
- [ ] UI dashboard updated with status badges
- [ ] EOD reconciliation logic
- [ ] Unit tests for all rules

---

> **See also:**  
> - [0001 Architecture](./0001_architecture_futures.md)  
> - [0004 Execution Engine](./0004_execution_engine.md)  
> - [0006 Risk Management](./0006_risk_management.md)
