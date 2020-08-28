class TxEntry {
    // start and endTs should be passed as millisecond timestamps, IE new Date().getTime()
	constructor(server, service, logId, acctNum, startTs, endTs, elapsed, topLevel) {
		// super(timestamp);
		this.server = server;
        this.service = service;
        this.logId = logId;
        this.acctNum = parseInt(acctNum);
        this.startTs = parseInt(startTs);
        this.endTs = parseInt(endTs);
        this.elapsed = parseInt(elapsed);
        this.topLevel = topLevel;
        this.type = 'tx';
	}

	toCSVString() {
        // return `${this.timestamp}|${this.type}|${this.server}|${this.service}|${this.elapsed}`;
        // Not including type here like on other entry objects because we will only have tx type entries on this queue, save a bit of space
        return `${this.type}|${this.server}|${this.service}|${this.logId}|${this.acctNum}|${this.startTs}|${this.endTs}|${this.elapsed}|${this.topLevel}`;
		// return `${this.timestamp}|${this.type}|${this.server}|${this.service}|${this.elapsed}`;
	}

	toPostgresObject() {
        return {
            endts: new Date(this.endTs),
            startts: new Date(this.startTs),
            server: this.server,
            service: this.service,
            logid: this.logId,
            acctnum: isNaN(this.acctNum) ? undefined : this.acctNum,
            elapsed: this.elapsed,
            toplevel: this.topLevel
        };
        // return this;
	// 	return {
	// 		timestamp: this.timestamp,
	// 		type: this.type,
	// 		server: this.server,
	// 		service: this.service,
	// 		data: `${this.elapsed}`
	// 	};
	}
}

class BaseEntry {
	constructor(timestamp) {
		this.timestamp = parseInt(timestamp);
        this.type = 'bs';
	}
}

class StatEntry extends BaseEntry {
    // timestamp should be passed as millisecond timestamps, IE new Date().getTime()
	constructor(timestamp, server, service, tpm, average, per75, per95) {
		super(timestamp);
		this.server = server;
		this.service = service;
		this.tpm = parseFloat(tpm);
		this.average = parseFloat(average);
		this.per75 = parseFloat(per75);
		this.per95 = parseFloat(per95);
        this.type = 'st';
	}

	nf(num, fixedVal = 1) {
		if (!num && num !== 0) 
			return undefined; // Removed quotes
		return parseFloat(num).toFixed(fixedVal);
	}

	toCSVString() {
		return `${this.type}|${this.timestamp}|${this.server}|${this.service}|${this.nf(this.tpm,2)}|${this.nf(this.average)}|${this.nf(this.per75)}|${this.nf(this.per95)}`;
	}

	// Shouldn't be called on StatEntry
	// toSqliteRecord() {
	// 	return {
	// 		timestamp: this.timestamp,
	// 		server: this.server,
	// 		service: this.service,
	// 		data: `${this.tpm}|${this.average}|${this.per75}|${this.per95}`
	// 	};
	// }
}

class FullStatEntry extends StatEntry {
	constructor(timestamp, server, service, tpm, lag, average, averageAvg, averageLB, averageUB, averageSignal, per75, per75Avg, per75LB, per75UB, per75Signal, per95, per95Avg, per95LB, per95UB, per95Signal) {
		super(timestamp, server, service, tpm, average, per75, per95);

		this.lag = lag;

		this.averageAvg = parseFloat(averageAvg);
		this.averageLB = parseFloat(averageLB);
		this.averageUB = parseFloat(averageUB);
		this.averageSignal = parseInt(averageSignal);

		this.per75Avg = parseFloat(per75Avg);
		this.per75LB = parseFloat(per75LB);
		this.per75UB = parseFloat(per75UB);
		this.per75Signal = parseInt(per75Signal);

		this.per95Avg = parseFloat(per95Avg);
		this.per95LB = parseFloat(per95LB);
		this.per95UB = parseFloat(per95UB);
		this.per95Signal = parseInt(per95Signal);

        this.type = 'fs';
	}

	nf(num, fixedVal = 1) {
		if (!num && num !== 0) 
			return undefined; // Removed quotes
		return parseFloat(num).toFixed(fixedVal);
	}

	toCSVString() {
		return `${this.type}|${this.timestamp}|${this.server}|${this.service}|${this.lag}|${this.nf(this.tpm,2)}|${this.nf(this.average)}:${this.nf(this.averageAvg)}:${this.nf(this.averageLB)}:${this.nf(this.averageUB)}:${this.averageSignal}|${this.nf(this.per75)}:${this.nf(this.per75Avg)}:${this.nf(this.per75LB)}:${this.nf(this.per75UB)}:${this.nf(this.per75Signal)}|${this.nf(this.per95)}:${this.nf(this.per95Avg)}:${this.nf(this.per95LB)}:${this.nf(this.per95UB)}:${this.nf(this.per95Signal)}`;
	}

	toPostgresObject() {
        // return this;

		return {
			timestamp: new Date(this.timestamp),
			server: this.server,
            service: this.service,
            tpm: this.tpm,
            lag: this.lag,
            stats: {
                average: this.average,
                averageavg: this.averageAvg,
                averagelb: this.averageLB,
                averageub: this.averageUB,
                averagesignal: this.averageSignal,

                per75: this.per75,
                per75avg: this.per75Avg,
                per75lb: this.per75LB,
                per75ub: this.per75UB,
                per75signal: this.per75Signal,
                
                per95: this.per95,
                per95avg: this.per95Avg,
                per95lb: this.per95LB,
                per95ub: this.per95UB,
                per95signal: this.per95Signal
            }
            
            // `${this.lag}|${this.nf(this.tpm,2)}|${this.nf(this.average)}:${this.nf(this.averageAvg)}:${this.nf(this.averageLB)}:${this.nf(this.averageUB)}:${this.averageSignal}|${this.nf(this.per75)}:${this.nf(this.per75Avg)}:${this.nf(this.per75LB)}:${this.nf(this.per75UB)}:${this.nf(this.per75Signal)}|${this.nf(this.per95)}:${this.nf(this.per95Avg)}:${this.nf(this.per95LB)}:${this.nf(this.per95UB)}:${this.nf(this.per95Signal)}`
		};
	}
}

class EntryFactory {
	constructor() {
	}
	
	getEntryFromObject(obj) {
		if (obj && (obj.timestamp || obj.startTs)) {
			// if (obj.type === 'bs')
			// 	return new BaseEntry(obj.timestamp);
			if (obj.type === 'tx')
				return new TxEntry(obj.server, obj.service, obj.logId, obj.acctNum, obj.startTs, obj.endTs, obj.elapsed, obj.topLevel);
			// else if (obj.type === 'st')
			// 	return new StatEntry(obj.timestamp, obj.server, obj.service, obj.tpm, obj.average, obj.per75, obj.per95);
			// else if (obj.type === 'fs')
			// 	return new FullStatEntry(obj.timestamp, obj.server, obj.service, obj.tpm, obj.lag, obj.average, obj.averageAvg, obj.averageLB, obj.averageUB, obj.averageSignal, obj.per75, obj.per75Avg, obj.per75LB, obj.per75UB, obj.per75Signal, obj.per95, obj.per95Avg, obj.per95LB, obj.per95UB, obj.per95Signal);
			else
				return undefined;
		} else 
			return undefined;
	}

	getEntryFromCSV(line, delim = '|') {
        const arr = line.toString().split(delim);
		if (arr[0] == 'tx')
			return new TxEntry(arr[1], arr[2], arr[3], arr[4], arr[5], arr[6], arr[7], arr[8]);
			// return new TxEntry(arr[1], arr[2], arr[3], arr[4]);
		else if (arr[0] == 'st')
			return new StatEntry(arr[1], arr[2], arr[3], arr[4], arr[5], arr[6], arr[7]);
		else if (arr[0] == 'fs') {
			let [ avg, avgAvg, avgLB, avgUB, avgSignal ] = arr[6].split(/:/);
			let [ per75, per75Avg, per75LB, per75UB, per75Signal ] = arr[7].split(/:/);
			let [ per95, per95Avg, per95LB, per95UB, per95Signal ] = arr[8].split(/:/);
			return new FullStatEntry(arr[1], arr[2], arr[3], arr[5], arr[4], avg, avgAvg, avgLB, avgUB, avgSignal, per75, per75Avg, per75LB, per75UB, per75Signal, per95, per95Avg, per95LB, per95UB, per95Signal);
		} else if (arr[0] == 'al') {
            return new AlertEntry(arr[1], arr[2], arr[3], arr[4], arr[5], arr[6]);
        } else if (arr[0] == 'jx') {
            const jmxEntry = new JmxEntry();
            jmxEntry.alternateConstructor(arr[1], arr[2], arr[3], arr[4], arr[5], arr[6], arr[7], arr[8], arr[9], arr[10], arr[11], arr[12], arr[13], arr[14], arr[15], arr[16], arr[17], arr[18]);
            return jmxEntry;
        }
	}

	// getEntryFromSqlite(sqliteObj) {
	// 	return this.getEntryFromCSV(`${sqliteObj.Timestamp}|${sqliteObj.Type}|${sqliteObj.Server}|${sqliteObj.Service}|${sqliteObj.Data}`);
	// }
}

const entryFactory = new EntryFactory();

class AlertEntry {
	constructor(alertTimestamp, entryTimestamp, server, service, cause, entry) {
		this.alertTimestamp = parseInt(alertTimestamp);
		this.entryTimestamp = parseInt(entryTimestamp);
		this.server = server;
		this.service = service;
		this.cause = cause; // CSV list of causes
        // We are already using pipes to delimit this object when it is converted to a delimited string, so for the "entry" field, we replace its pipes with & so we can split those separately later
		this.entry = entry.replace(/\|/g,'&'); // Pipe-delimited entry object (already called toCSVString() before passing to this constructor)
        this.type = 'al';
	}

	toCSVString() {
		return `${this.type}|${this.alertTimestamp}|${this.entryTimestamp}|${this.server}|${this.service}|${this.cause}|${this.entry}`;
	}

	toPostgresObject() {
        // return this; // Format is the same for sqlite
        // TODO change this to handle postgres format of this table

        // "entry" is a nested postgres object inside this postgres object, stored as jsonb in the db
		return {
			alerttimestamp: new Date(this.alertTimestamp),
			entrytimestamp: new Date(this.entryTimestamp),
			server: this.server,
            service: this.service,
            cause: this.cause,
            entry: entryFactory.getEntryFromCSV(this.entry, '&').toPostgresObject()
        }

		// return {
		// 	alertTimestamp: this.alertTimestamp,
		// 	entryTimestamp: this.entryTimestamp,
		// 	server: this.server,
		// 	service: this.service,
		// 	cause: this.cause,
		// 	entry: this.entry
		// };
	}
}

class JmxEntry {
    // timestamp should be passed as millisecond timestamps, IE new Date().getTime()
    // This constructor is used when we initially insert a new JmxEntry to the insert queue, the stats object comes directly from our JMX response data
	constructor(timestamp, server, stats) {
        if (timestamp) {
            this.timestamp = parseInt(timestamp);
            this.server = server;
                    
            this.dsInUseNodes = parseInt(stats.ds.result.InUseCount);
            this.dsActiveNodes = parseInt(stats.ds.result.ActiveCount);
            this.dsAvailableNodes = parseInt(stats.ds.result.AvailableCount);
            
            this.heapUsed = parseInt(stats.heap.result.used);
            this.heapCommitted = parseInt(stats.heap.result.committed);
            this.heapMax = parseInt(stats.heap.result.max);
            
            this.metaUsed = parseInt(stats.meta.result.used);
            this.metaCommitted = parseInt(stats.meta.result.committed);
            this.metaMax = parseInt(stats.meta.result.max);     
            
            this.sysLoad = parseFloat(stats.sysload.result);

            this.classCnt = parseInt(stats.classcnt.result);

            this.threadCnt = parseInt(stats.threading.result["thread-count"])
            this.daemonThreadCnt = parseInt(stats.threading.result["daemon-thread-count"])
                    
            this.beanPoolAvailableCount = parseInt(stats.bean.result[0].result["pool-available-count"]);
            this.beanPoolCurrentSize = parseInt(stats.bean.result[0].result["pool-current-size"]);
            this.beanPoolMaxSize = parseInt(stats.bean.result[0].result["pool-max-size"]);
        }
        this.type = 'jx';
    }
    
    // This constructor is used when we pull data off the insert queue to prepare for database insert
    alternateConstructor(timestamp, server, dsInUseNodes, dsActiveNodes, dsAvailableNodes, heapUsed, heapCommitted, heapMax, metaUsed, metaCommitted, metaMax, sysLoad, classCnt, threadCnt, daemonThreadCnt, beanPoolAvailableCount, beanPoolCurrentSize, beanPoolMaxSize) {
        this.timestamp = parseInt(timestamp);
        this.server = server;
        this.dsInUseNodes = parseInt(dsInUseNodes);
        this.dsActiveNodes = parseInt(dsActiveNodes);
        this.dsAvailableNodes = parseInt(dsAvailableNodes);
        this.heapUsed = parseInt(heapUsed);
        this.heapCommitted = parseInt(heapCommitted);
        this.heapMax = parseInt(heapMax);
        this.metaUsed = parseInt(metaUsed);
        this.metaCommitted = parseInt(metaCommitted);
        this.metaMax = parseInt(metaMax);
        this.sysLoad = parseFloat(sysLoad);
        this.classCnt = parseInt(classCnt);
        this.threadCnt = parseInt(threadCnt);
        this.daemonThreadCnt = parseInt(daemonThreadCnt);
        this.beanPoolAvailableCount = parseInt(beanPoolAvailableCount);
        this.beanPoolCurrentSize = parseInt(beanPoolCurrentSize);
        this.beanPoolMaxSize = parseInt(beanPoolMaxSize);
        this.type = 'jx';
    }

	nf(num, fixedVal = 1) {
		if (!num && num !== 0) 
			return undefined; // Removed quotes
		return parseFloat(num).toFixed(fixedVal);
	}

	toCSVString() {
		return `${this.type}|${this.timestamp}|${this.server}|${this.dsInUseNodes}|${this.dsActiveNodes}|${this.dsAvailableNodes}|${this.heapUsed}|${this.heapCommitted}|${this.heapMax}|${this.metaUsed}|${this.metaCommitted}|${this.metaMax}|${this.sysLoad}|${this.classCnt}|${this.threadCnt}|${this.daemonThreadCnt}|${this.beanPoolAvailableCount}|${this.beanPoolCurrentSize}|${this.beanPoolMaxSize}`;
    }
    
	toPostgresObject() {
		return {
			timestamp: new Date(this.timestamp),
			server: this.server,
            dsinusenodes: this.dsInUseNodes,
            dsactivenodes: this.dsActiveNodes,
            dsavailablenodes: this.dsAvailableNodes,
            heapused: this.heapUsed,
            heapcommitted: this.heapCommitted,
            heapmax: this.heapMax,
            metaused: this.metaUsed,
            metacommitted: this.metaCommitted,
            metamax: this.metaMax,
            sysload: this.sysLoad,
            classcnt: this.classCnt,
            threadcnt: this.threadCnt,
            daemonthreadcnt: this.daemonThreadCnt,
            beanpoolavailablecnt: this.beanPoolAvailableCount,
            beanpoolcurrentsize: this.beanPoolCurrentSize,
            beanpoolmaxsize: this.beanPoolMaxSize
        }
	}
}

module.exports = {
    BaseEntry,
    TxEntry,
	StatEntry,
	FullStatEntry,
	EntryFactory,
    AlertEntry,
    JmxEntry
}
