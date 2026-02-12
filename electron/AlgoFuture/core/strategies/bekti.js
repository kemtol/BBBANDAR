const zScore = require('../features/z_score');
const wallCheck = require('../dom/walls');

class BektiStrategy {
    evaluate(data) {
        // "Ramuan" Bekti: Freq + Z-Score
        // if (zScore.calculate(data.val, history) > 2.5 && !wallCheck.isTooThick(data)) {
        //     return "BUY_SIGNAL";
        // }
        return null;
    }
}
module.exports = new BektiStrategy();
