// stream.js - Buffer management for Time & Sales
class TapeStream {
    constructor() {
        this.buffer = [];
    }
    push(trade) {
        this.buffer.push(trade);
    }
}
module.exports = new TapeStream();
