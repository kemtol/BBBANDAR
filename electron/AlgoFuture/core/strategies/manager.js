const bekti = require('./bekti');
const john = require('./john');

class StrategyManager {
    constructor() {
        this.strategies = { bekti, john };
    }
    evaluate(strategyName, data) {
        const strategy = this.strategies[strategyName];
        return strategy ? strategy.evaluate(data) : null;
    }
}
module.exports = new StrategyManager();
