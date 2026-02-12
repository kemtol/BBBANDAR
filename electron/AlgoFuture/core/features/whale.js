// whale.js - Big transaction filter
class WhaleTracker {
    isWhale(trade, threshold) {
        return trade.value >= threshold;
    }
}
module.exports = new WhaleTracker();
