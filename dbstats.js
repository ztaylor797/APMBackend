class DBStats {

    constructor() {
        this.recInsCounter = 0;
        this.insElapTotal = 0;
    }

    setInterval(newInterval) {
        this.interval = newInterval;
    }

    incrRecInsCounter() {
        this.recInsCounter++;
    }
    addToRecInsCounter(val) {
        this.recInsCounter += val;
    }
    addToInsElapTotal(elap) {
        this.insElapTotal += elap;
    }

    logDBStats() {
        let dbInsPiece = `DBRecordsIns: ${this.recInsCounter} - TotalInsTime: ${this.insElapTotal.toFixed(1)} ms - AvgDBInsTimePerRec: ${(this.insElapTotal/this.recInsCounter).toFixed(3)} ms`;

        logger.info(`${dbInsPiece}`);

        this.recInsCounter = 0;
        this.insElapTotal = 0;
    }

    logDBStatsRecurs(interval, notFirstTime) { // initial call should have no second parameter passed, successive calls should have undefined and true passed in
        if (interval) this.interval = interval;
        if (!interval && !this.interval) this.interval = 60; // Default value

        let currentSec = new Date().getSeconds();
        const timeoutSec = this.interval - (currentSec % this.interval);
        if (notFirstTime) this.logDBStats();
        // setTimeout(this.logQueueStatsRecurs.bind(this, true), interval - currentSec * 1000); // Try to start it on the :00 second of every minute
        setTimeout(this.logDBStatsRecurs.bind(this, undefined, true), timeoutSec * 1000); // Try to start it on the :00 second of every minute
    }
}

module.exports = {
    DBStats
}