#!/usr/bin/env node

/* ztaylo - 202001 - Created with blood, sweat, and tears

   Input: All live JVM logs (excluding a couple log types like secure and hibernate_info)
   Output: For every common timing or audit trail entry, output a record with start and end timestamps, elapsed, and account number.
   * OUTPUT IS NOT IN CHRONOLOGICAL ORDER. Only roughly in order (variance of up to 3 minutes due to maximum timeout in the caches of 180 seconds).
   
   The input log files are tailed using a perl tail on the net mounted log files. Regular tail and inotify-based node tail variants do not function properly.
   GNU tail in particular truncates data and inserts null characters. Each perl tail (one for each log file, currently about 70 total) has its own internal buffer that can be adjusted in the script. Setting them too large will consume high amounts of CPU due to constant buffer processing/management. 

   NOTE: The perl tail library used has been compiled/installed locally. Also went in and modified the Tail lib script as it was throwing errors on net-mounted files since they don't have inode info available.

   Each of the log has its own tail command executed in a separate shell. The stdout of that script is read in by the readline lib in this script. There is a separate readline interface for each of the tails (roughly 70 tails and readlines at the moment). They are all parsed asynchronouslybundleRenderer.renderToStream

   From there, we use a variety of parsing methods to handle SOAP log, EJB common timing (from Delegation EAR top level), standard common timing, and audit trail parsing. The end result of parsing one of these types (other than soap) is a single output record as mentioned above.

   The soap log entries are parsed to create a Map of logId -> accountNumber.
   For each non-soap entry, we use that map to get the account number for a given transaction service.

   On common timing entry, we store a partial record in the record cache. When we find the matching exit line, we combine the partial record from the cache with the exit line's info to create a full record. If at this point the account number is still not available in the account cache, we output an incomplete record. If the exit line is coming from a BAF log, we can usually pull the account number from the BAF [] metadata on the log line so we try to do that as well (see salvage method).

   Audit trail entries are parsed differently and are much more complex. There are two stages.
   1. Audit trail prints a single line that has the logId available as well as the autrId. We store those in a Map very similar to the account number map.
   2. After that first line, we have another line that starts the huge audit trail printout. This line does not have logId set and it is also not guaranteed to be the next line after the first line above, but the first instance of this type of line encountered will always map to the first instance of the first line. So that let's us simplify the mapping logic to having an active audit entry even as we encounter new instances of the first line.
   On second line, we use the autr map to get the logId. We then parse each elapsed entry from stopWatch. Then further down, we get the start and end timestamps from the stopWatch XML entries. A single transaction can have multiple instances of the same sub-service (bcottag in particular does this frequently). So we maintain these subservices as an array for a single audit trail entry.
   At the end of the audit trail entry, we print out all subservice entries for that transaction. If they are missing account number, we try to salvage it from the BAF [] metadata.

   NOTES:

   Not all common timing entries have logId set, they start with []. For BAF entries, we can usually salvage the account number, but not the logId.
   For these entries, we cannot reliably get the logId which means they cannot be associated with an overall transaction. That means any given transaction cannot be guaranteed to contain all subservices. This is something we have to live with until the logs are fixed (by putting the logId on the appropriate NDC stack or similar).

   Due to issues above, an output record can have a missing logId, accountNumber, or startTs. All other fields should always be available.
   We try to set the startTimestamp via subtracting elapsed from the endTimestamp. It isn't guaranteed to be exactly correct though.

   FLOW CONTROL NOTES:

   Generally speaking, the pause variable is used to control whether or not input should be streamed in or paused instead.
   In order not to just spam tail input into this script whenever the queue buffer fills up, we create a PAUSE file. This pause file is detected by each of the instances of the perl tail script running. When they see the pause file, they stop tailing the log, but hold their last read position.
   Once the queue emits a drain event, we try to re-enqueue the buffered records, then remove the PAUSE file. The perl tails then start reading from their last location again.
   We do not actually pause the readlines in this script.

*/

// var amqp = require('amqplib');
var readline = require('readline');
const { spawn, execSync } = require('child_process');
const NodeCache = require( "node-cache" );
const Tail = require('tail-file');
var glob = require("multi-glob").glob;
const fs = require('fs');
var ps = require('ps-node');

const heapdump = require('heapdump');
let path = require('path');
let nodeOomHeapdump = require('node-oom-heapdump')({
    path: path.resolve((__filename.split('.').slice(0, -1)).join('.')),
    heapdumpOnOOM: true,
	addTimestamp: true
});

const { QueueManager } = require('./queue.js');
const { TxEntry } = require('./entries.js');
const UtilMethods = require('./util_methods.js')();

// START GLOBALS ///////////////////////////////////
let paused = false;
// let buffer = [];
// let dbBuffer = [];

// const queueStats = new QueueStats(true, false);
//  END  GLOBALS ///////////////////////////////////

// queueStats.logQueueStatsRecurs();

function lookupPids() {
    const output = execSync(APMCONFIG.applicationManager.pidListCommand);
    const resultList = output.toString().split(/\n+/).filter(Boolean).map(line => {
        line = line.trim();
        const a = line.trim().split(/\s+/);

        const pid = a.shift();
        const ppid = a.shift();
        const command = a.shift();
        // Remaining array comprises the arguments list
        return {
            pid,
            ppid,
            command,
            arguments: a
        }
    });
    return resultList;
}

function lookupPerlTailPids() {
    const resultList = lookupPids();
    return resultList.filter(el => {
        // Only return records whose command contains 'node' and arguments match a regex of the relativePath string
        if (el.command.match(/perl/) && el.arguments.filter(arg => arg.match(new RegExp("apm.*perl_tail"))).length > 0) {
            console.log(el);
            return el;
        }
    })
}

async function killPid(pid) {
    return new Promise((resolve, reject) => {
        logger.warn(`Killing PID: ${pid}`);
        ps.kill(pid.toString(), 'SIGTERM', (err) => {
            if (err) reject(err);
            else resolve(pid);
        });
    });
}

async function killAllTailPids() {
    logger.info(`Killing all active perl_tail PIDs...`);
    try {    
        const resultList = await lookupPerlTailPids();
        let promises = [];
        if (resultList.length > 0) {
            for (const el of resultList) {
                try {
                    promises.push(killPid(el.pid));
                    // logger.warn(`Process PID: ${pid} has been killed intentionally: ${el.pprint()}`);
                } catch (err) {
                    logger.error(`Could not kill pid: ${el.pid} Error: ${err}`);
                }
            }

            try {
                await Promise.all(promises);
                logger.warn(`All tails killed.`);
            } catch (e) {
                logger.error(`Error(s) killing pids: ${e}`);
            };
        }
    } catch (err) {
        throw new Error( err );
    }
}

(async () => {

    try {
        APMCONFIG = readAPMConfig();
        PARSETXCONFIG = APMCONFIG.streamParseTransactions;
        await setGlobalLogger(APMCONFIG.logDir, PARSETXCONFIG.logFilePrefix); // This sets global.logger for use here and in modules

        // queueStats.logQueueStatsRecurs(APMCONFIG.statLogIntervalInSeconds);
        const qm = new QueueManager(APMCONFIG.amqpConnectionString, APMCONFIG.statLogIntervalInSeconds);

        watchAPMConfig(
            APMCONFIG, 
            async (newAPMCONFIG) => {
                APMCONFIG = newAPMCONFIG;
                PARSETXCONFIG = APMCONFIG.streamParseTransactions;
                await setGlobalLogger(APMCONFIG.logDir, PARSETXCONFIG.logFilePrefix); // This sets global.logger for use here and in modules
                // queueStats.setInterval(APMCONFIG.statLogIntervalInSeconds);
                qm.setInterval(APMCONFIG.statLogIntervalInSeconds);
            },
            [ 'apmConfigFilePath', 'amqpConnectionString', 'streamParseTransactions.outQueue', 'dbInsertQueue', 'streamParseTransactions.tailCommandPath', 'streamParseTransactions.tailPauseFileFullPath', 'streamParseTransactions.appLogDirMaskPrefix', 'streamParseTransactions.maskSuffixes' ]
        );

        const outQueue = await qm.getQueue(PARSETXCONFIG.outQueue, 'p');
        const dbQueue = await qm.getQueue(APMCONFIG.dbInsertQueue, 'p');

        qm.on('pause', () => {
            pauseReads();
        });
        
        qm.on('resume', () => {
            resumeReads();
        });
        
        // let shellParser;

        async function exit(rc = 0) {
            try {
                await qm.shutdown();
            } catch (err) {
                logger.error(`qm.shutdown() error: ${err}`);
            }            

            // if (shellParser) {
            //     try {
            //         shellParser.kill("SIGINT");
            //     } catch (err) {
            //         logger.error(`Attempted SIGINT kill of shell process resulted in error: ${err}`);
            //     }
            // }

            logger.info(`Exiting...`);
            process.exit(rc);
        }

        process.on('SIGINT', function() {
			logger.warn(`Caught SIGINT signal`);
			exit();
        })
        .on('SIGTERM', function() {
			logger.warn(`Caught SIGTERM signal`);
			exit();
        });

        await killAllTailPids();

        // Note that the maximum theoretical limit for the NodeCache objects is around 1 million keys
        const context = new Map();
        // This cache contains a map of logId -> accountNumber
        const acctCache = new NodeCache( { stdTTL: 120, checkperiod: 30, deleteOnExpire: true, useClones: false, maxKeys: -1 } );
        // This cache contains partial records created on timing entry lines (CommonTiming::Start for ex.)
        const recordCache = new NodeCache( { stdTTL: 120, checkperiod: 30, deleteOnExpire: true, useClones: false, maxKeys: -1 } );
        // This cache contains records that are complete except for needing an account number
        // const needNumRecordCache = new NodeCache( { stdTTL: 120, checkperiod: 30, deleteOnExpire: true, useClones: false, maxKeys: -1 } );
        const needNumRecordCache = new NodeCache( { stdTTL: 30, checkperiod: 10, deleteOnExpire: true, useClones: false, maxKeys: -1 } );

        recordCache.on("expired", (logId, map) => {
            map.forEach((rec, service) => {
                logger.error(`Partial record expired! No matching timing exit found. Discarding. Service: ${service} Partial record: ${JSON.stringify(rec)}`);
            });
        });

        needNumRecordCache.on("expired", (logId, needMap) => {
            // Records with no account number need to be pushed to the queue with a default value that we can later flag in the website UI as missing
            needMap.forEach((rec, service) => {
                // logger.info(`QUEUE -noacctnumber- >>> ${logId},${service} -> ${JSON.stringify(rec)}`);
                // if (rec.altAcctNum) {
                //     logger.info(`ALT ACCT NUM: ${rec.altAcctNum}`);
                // }
                // altAcctNum is set by standard common timing entries if they can find account number in the [] baf info
                if (!rec.server || rec.server == 'undefined') {
                    logger.error(`server was undefined in record cache expiration! rec: ${JSON.stringify(rec, undefined, 2)}`);
                }
                outputRecord('needNumRecordCache_expired', rec.server, service, logId, rec.altAcctNum ? rec.altAcctNum : '', rec.startTs, rec.endTs, rec.elapsed, rec.insertToDb ? rec.insertToDb : false);
            });
        });

        // Returns date as a String in milliseconds or '' if date is empty or otherwise falsey
        const convertStringDateToMs = (dateStr) => {
            if (!dateStr) {
                return '';
            } else if (dateStr.match(/T.*-/)) {
                // This is a UTC formatted timestamp from audit trail with timezone, easy to parse
                // Ex: 2020-01-07T10:00:01.959-06:00
                return new Date(dateStr).getTime();
            } else {
                // This should be a standard log format date
                // Ex: 2020-01-07 10:00:02,669
                const arr = dateStr.trim().split(/-|[\s]+|:|,/);
                // Month is 0-11
                return new Date(arr[0], arr[1] - 1, arr[2], arr[3], arr[4], arr[5], arr[6]).getTime();
            }
        };

        const topLevelRx = new RegExp(/^S:/);
        const providerRx = new RegExp(/Provider\[/i);

        // IMPORTANT: We have records with empty logIds [] as well as some where we can't find account number
        // This means logId, startTs, and acctnum may be empty. We will calculate startMs if needed.
        // 'source' is just for help with debugging
        async function outputRecord(source = 'unknown', server, service, logId, acctNum, startTs, endTs, elapsed, insertToDb = false) {
            // At this point, timestamps are in two different formats, startTs/logId/acctNum can all be empty
            let startMs = convertStringDateToMs(startTs);
            const endMs = convertStringDateToMs(endTs);

            if (!server || server == 'undefined') {
                logger.error(`Server was undefined! SOURCE:${source} --> ${server}, ${service}, ${logId}, ${acctNum}, ${startTs}, ${endTs}, ${elapsed}, ${insertToDb}`);
            }

            // Replace Provider[] with Provider:
            service = service.replace(providerRx, 'Provider:').replace(']','');

            // try to calculate startMs from elapsed and end TS if we don't have it
            if (!startMs) {
                startMs = endMs - parseInt(elapsed);
            }

            // Pipe-delimited
            const line = new TxEntry(server, service, logId, acctNum, startMs, endMs, elapsed, service.match(topLevelRx) ? 'Y' : 'N').toCSVString();

            if (!insertToDb) {
                outQueue.writeLineToQueue(line, PARSETXCONFIG.verboseQueueWrite);
            } else {
                // Send straight to database instead of the next processing script in the pipeline
                dbQueue.writeLineToQueue(line, PARSETXCONFIG.verboseQueueWrite);
            }
        }

        // The source variable is just to help with debugging issues to know which type of log it was parsing
        // This can be called by the soap log parser OR by the BAF log when it tries to read the acctnum from the baf meta info
        function saveAcctNum(acctNum, currLogFp, source, altLogId) {
            acctNum = acctNum.trim();
            if (!acctNum.match(/^[0-9]+$/)) {
                logger.error(`Invalid acctNum (SRC=${source}): xxx ${acctNum} xxx pulled from currLogFp: ${$currLogFp} Source: ${source}`);
            } else {
                let logId;
                if (source === 'bafmetainfo') {
                    logId = altLogId;
                    if (!logId) {
                        return;
                    }
                    // logger.info(`SAVING NUM FROM BAFINFO: ${altLogId} -> ${acctNum}`);
                } else {
                    logId = context.get(currLogFp).logId;
                }
                // logger.info(`Setting acctCache entry: ${logId} => ${acctNum}`);
                acctCache.set(logId, acctNum);

                if (source !== 'bafmetainfo') {
                    context.delete(currLogFp);
                }
                // check here to see if entries with this logId already exist in the needAcctNum data and then process them out before proceeding
                const needMap = needNumRecordCache.get(logId);
                if (needMap) {
                    // We have unmatched partial records to process here
                    const server = currLogFp.split('/')[2];
                    needMap.forEach((rec, service) => {
                        // logger.info(`Need record fulfilled after acctNum found! AcctNum: ${acctNum}`);
                        outputRecord('saveAcctNum', server, service, logId, acctNum, rec.startTs, rec.endTs, rec.elapsed);
                        needMap.delete(service);
                    });
                }
            } 
        }

        setInterval(() => {
            logger.info(`+++ CACHE_STATS +++\n
            * ACCT *\n${JSON.stringify(acctCache.getStats(), undefined, 2)}\n
            * RECORD *\n${JSON.stringify(recordCache.getStats(), undefined, 2)}\n
            * NEED *\n${JSON.stringify(needNumRecordCache.getStats(), undefined, 2)}\n
            -------------------`);
        }, 60000);

        // let currLogFp = '';
        // let currLog = '';
        // let currServer = '';
        // let currType = '';

        // let acctNum = undefined;
        // rl.on('line', (line) => {

        // SOAP log regexes - Precompile for performance
        const soapInputRx = new RegExp(/^=== jbossId.*IO=I/);
        const soapOutputRx = new RegExp(/^=== jbossId.*IO=O/);
        const soapAcctNumRx = new RegExp(/<accountNumber>/i);
        const soapAltAcctNumRx = new RegExp(/<key>AccountNumber<\/key>/i);
        const soapAltAcctNumValueRx = new RegExp(/<value>/);

        const parseSoapLine = (line, currLogFp) => {
            if (line.match(soapInputRx)) {
                const logId = line.split(/[\s]+/)[1].split('=')[1];
                context.set(currLogFp, { logId });
            } else if (line.match(soapOutputRx)) {
                // Should already be deleted here due to early removal when account number is found
                context.delete(currLogFp);
            } else {
                if (context.has(currLogFp)) { 
                    // General case for all soap calls except riskid
                    if (line.match(soapAcctNumRx)) { // case-insensitive
                        const acctNum = line.trim().split(/<|>/)[2];
                        saveAcctNum(acctNum, currLogFp, 'standard');
                    // Special case for riskid
                    } else if (line.match(soapAltAcctNumRx)) {
                        context.set(currLogFp, { ...context.get(currLogFp), pullNextValueFlag: true } );
                    // Part 2 of special case for riskid
                    } else if (line.match(soapAltAcctNumValueRx) && context.get(currLogFp).pullNextValueFlag) {
                        const acctNum = line.trim().split(/<|>/)[2];
                        // logger.info(`Saving risk acctNum: ${acctNum} from line: ${line}`);
                        saveAcctNum(acctNum, currLogFp, 'riskStrategy');
                    }
                }
            }
        };

        const parseEjbCommonTimingEntry = (line, currServer) => {
            const arr = line.split(/[\s]+/);
            const logId = arr[0].replace(/[[\]]/g,'');
            const startTs = `${arr[1]} ${arr[2]}`;

            if (logId === '') {
                // Missing logId, discard the entry line, ideally all entries have logId
                return;
            }

            // logger.info(`startTs: ${startTs}`);
            // Prefix with S: to show it is a top-level soap transaction entry
            const service = `S:${arr[13]}`;
            // Put this partial record into recordCache
            if (!recordCache.has(logId)) {
                recordCache.set(logId, new Map());
                // logger.info(`Creating map: ${logId} currLogFp: ${currLogFp} LINE: ${line}`);
            }
            const map = recordCache.get(logId);
            map.set(service, { 
                server: currServer,
                startTs
            });
        };

        const parseEjbCommonTimingExit = (line, currServer) => {
            const arr = line.split(/[\s]+/);
            const logId = arr[0].replace(/[[\]]/g,'');
            const endTs = `${arr[1]} ${arr[2]}`;
            const service = `S:${arr[9]}`;
            const elapsed = arr[11];

            if (logId === '') {
                // Missing logId, can't pull account number or start timestamp either then
                outputRecord('parseEjbCommonTimingExit_missingLogId', currServer,service,'','','',endTs,elapsed);
                return;
            }

            const map = recordCache.get(logId);
            // logger.info(`MAP: ${JSON.stringify(map, undefined, 2)}`);

            if (!map) {
                logger.error(`EJB CommonTiming exit had no logId map associated in the recordCache! ${currServer} logId: ${logId} LINE: ${line}`);
            } else {
                // logger.info(`FOUND`);
                const partRec = map.get(service);
                if (!partRec) {
                    logger.error(`EJB CommonTiming exit had no entry line associated in the recordCache sub-map! LINE: ${line}`)
                } else {
                    const acctNum = acctCache.get(logId);
                    if (acctNum) {
                        // output completed record
                        outputRecord('parseEjbCommonTimingExit',currServer,service,logId,acctNum,partRec.startTs,endTs,elapsed);
                    } else {
                        // logger.warn(`AcctNum entry not found. Adding to needAcctNumCache. logId: ${logId} LINE: ${line}`)
                        if (!needNumRecordCache.has(logId)) {
                            needNumRecordCache.set(logId, new Map());
                        }
                        const needMap = needNumRecordCache.get(logId);
                        needMap.set(service, { 
                            ...partRec,
                            endTs,
                            elapsed
                        });
                    }
                    map.delete(service);
                }
            }
        };

        // BAF account number regex
        const bafAdditionalDataRx = new RegExp(/\[[^ ]+] +INFO /);

        const parseCommonTimingEntry = (line, currServer) => {
            // logger.info(`++ ENTRY: ${line}`);
            const arr = line.split(/[\s]+/);
            const logId = arr[0].replace(/[[\]]/g,'');
            const startTs = `${arr[1]} ${arr[2]}`;
            // logger.info(`startTs: ${startTs}`);

            // Doing an info-based split on these because some baf logs have additional [][][] identifying info before INFO, which messed up column counts
            const arrSecondHalf = line.split(/INFO/)[1].trim().split(/[\s]+/);;
            const service = arrSecondHalf[1];

            // logger.info(`ENTRY: logId:${logId} startTs:${startTs} service:${service}`)

            if (logId === '') {
                // Missing logId, discard the entry line, ideally all entries have logId. Will still output an incomplete record when we get the exit line
                return;
            }

            // Put this partial record into recordCache
            if (!recordCache.has(logId)) {
                const res = recordCache.set(logId, new Map());
                if (!res) {
                    logger.error(`Error initializing logId record in cache. LINE: ${line}`);
                }
                // logger.info(`Creating map: ${logId} currLogFp: ${currLogFp} LINE: ${line}`);
            }
            const map = recordCache.get(logId);
            // logger.info(`Set: ${logId} ${service}`);
            map.set(service, {
                server: currServer,
                startTs
            });
        };

        // This method tries to pull the account number from the BAF log [] data Citi appends before outputting the record as a last resort
        const attemptReadAccountNumberFromBAFInfo = (line, currLogFp, logId, arr) => {
            let acctNum = '';
            if (line.match(bafAdditionalDataRx)) {
                const bafInfoArr = arr[3].replace(/.*]\[/,'').replace(/[[\]]/g,'').split(':');
                acctNum = bafInfoArr[bafInfoArr.length - 1];
                // logger.info(`ALT ACCOUNTNUMBER OBTAINED: ${acctNum}`);
                if (acctNum) {
                    saveAcctNum(acctNum, currLogFp, 'bafmetainfo', logId);
                }
            }
            return acctNum;
        };

        // This method tries to pull the account number from the BAF log [] data Citi appends before outputting the record as a last resort
        const salvageRecordAndOutput = (line, currLogFp, logId, arr, currServer, service, endTs, elapsed) => {
                // Try to pull account number from baf log entry as a backup
                let acctNum = attemptReadAccountNumberFromBAFInfo(line, currLogFp, logId, arr);
                outputRecord('salvageRecordAndOutput',currServer,service,'',acctNum,'',endTs,elapsed);
        };

        const parseCommonTimingExit = (line, currLogFp, currServer) => {
            // logger.info(`--- EXIT: ${line}`);
            const arr = line.split(/[\s]+/);
            // Doing an info-based split on these because some baf logs have additional [][][] identifying info before INFO, which messes up column counts
            const arrSecondHalf = line.split(/INFO/)[1].trim().split(/[\s]+/);;
            const logId = arr[0].replace(/[[\]]/g,'');
            const endTs = `${arr[1]} ${arr[2]}`;

            const service = arrSecondHalf[1];
            const elapsed = arrSecondHalf[5];
            const map = recordCache.get(logId);
            // logger.info(`MAP: ${JSON.stringify(map, undefined, 2)}`);

            // logger.info(`EXIT: logId:${logId} endTs:${endTs} service:${service} elapsed:${elapsed}`);
            // if (elapsed == 'time') {
            //     logger.info(`TIMELINE: ${line}`);
            // }

            // With no logId, we can't match to the entry line or to the account number, so output an incomplete record, also try to pull AN from the BAF meta info
            if (logId === '') {
                salvageRecordAndOutput(line, currLogFp, logId, arr, currServer, service, endTs, elapsed);
                return;
            }

            if (!map) {
                logger.error(`Standard CommonTiming exit had no logId map associated in the recordCache! logId: ${logId} LINE: ${line}`);
                salvageRecordAndOutput(line, currLogFp, logId, arr, currServer, service, endTs, elapsed);
                return;
            } else {
                // logger.info(`FOUND`);
                const partRec = map.get(service);
                if (!partRec) {
                    logger.error(`Standard CommonTiming exit had no entry line associated in the recordCache sub-map! logId:${logId} service:${service} LINE: ${line}`);
                    salvageRecordAndOutput(line, currLogFp, logId, arr, currServer, service, endTs, elapsed);
                    return;
                } else {
                    const acctNum = acctCache.get(logId);
                    if (acctNum) {
                        // output completed record
                        outputRecord('parseCommonTimingExit',currServer,service,logId,acctNum,partRec.startTs,endTs,elapsed);
                    } else {
                        // logger.warn(`AcctNum entry not found. Adding to needAcctNumCache. logId: ${logId} LINE: ${line}`)
                        if (!needNumRecordCache.has(logId)) {
                            needNumRecordCache.set(logId, new Map());
                        }

                        const altAcctNum = attemptReadAccountNumberFromBAFInfo(line, currLogFp, logId, arr);

                        const needMap = needNumRecordCache.get(logId);
                        needMap.set(service, { 
                            ...partRec,
                            endTs,
                            elapsed,
                            altAcctNum // This will be '' if AN wasn't in the BAF info of the line 
                        });
                    }
                    map.delete(service);
                }
            }
        };

        const autrIdMapRx = new RegExp(/INFO  auditTrailId=/);
        const autrIdLineRx = new RegExp(/^Audit Trail id *:/);
        const elapsedSectionStartRx = new RegExp(/: RequestTrace \[stopWatchList=/);
        const elapsedSectionEndRx = new RegExp(/^]/);
        const stopwatchXmlStartRx = new RegExp(/<stopWatchList>/);
        const stopwatchXmlEndRx = new RegExp(/<\/stopWatchList>/);
        const stopwatchNameRx = new RegExp(/<name>/);
        const stopwatchStartTsRx = new RegExp(/<startTime>/);
        const stopwatchEndTsRx = new RegExp(/<stopTime>/);
        // const stopwatchElapsedEntryRx = new RegExp(/^[a-zA-Z0-9]+ *:\[0-9+ millis/);

        const parseAppLine = (line, currLogFp, currServer) => {
            if (line.match(autrIdMapRx)) {
                const arr = line.split(/[\s]+/);
                const logId = arr[0].replace(/[[\]]/g,'');
                const autrId = arr[5].split('=')[1];
                if (!context.has(currLogFp)) {
                    // This autrIdMap is used to link the autrId with the logId
                    context.set(currLogFp, { autrIdMap: new Map() });
                }
                const currContext = context.get(currLogFp);
                const altAcctNum = attemptReadAccountNumberFromBAFInfo(line, currLogFp, logId, arr);
                // logger.info(`altAcctNum: ${altAcctNum}`);

                currContext.autrIdMap.set(autrId, { logId, altAcctNum });

            } else if (line.match(autrIdLineRx)) {
                if (context.has(currLogFp)) {
                    const arr = line.split(':');
                    const autrId = arr[1].trim();
                    const currContext = context.get(currLogFp);
                    const autrIdMapObj = currContext.autrIdMap.get(autrId);
                    if (!autrIdMapObj) {
                        logger.error(`Could not obtain autrIdMap object from context autrId map. autrId: ${autrId} Map: ${JSON.stringify(currContext.autrIdMap, undefined, 2)}`);
                    } else {
                        const logId = autrIdMapObj.logId;
                        // logger.info(`LOGID: ${logId}`);
                        if (!logId) {
                            logger.error(`Could not obtain logId from context autrId map. autrId: ${autrId} Map: ${JSON.stringify(currContext.autrIdMap, undefined, 2)}`);
                        } else {
                            currContext.serviceMap = new Map();
                            currContext.activeAutrId = autrId;
                            currContext.activeLogId = logId;
                            currContext.activeAltAcctNum = autrIdMapObj.altAcctNum;
                            currContext.elapsedFlag = false;
                            currContext.swFlag = false;
                            currContext.activeService = undefined;

                            // We've used the link between autrId and logId, so now discard it off the map to save memory
                            currContext.autrIdMap.delete(autrId);
                        }
                    }
                } else {
                    logger.error(`Missing context entry for audit trail ID declaration line, should only happen on initial startup (sometimes): LINE: ${line}.`);
                }
            } else if (context.has(currLogFp) && context.get(currLogFp).activeLogId) { // Can probably optimize this conditional
                    const currContext = context.get(currLogFp);
                    if (line.match(elapsedSectionStartRx)) {
                        currContext.elapsedFlag = true;
                    } else if (currContext.elapsedFlag) {
                        if (line.match(elapsedSectionEndRx)) {
                            currContext.elapsedFlag = false;
                        } else {
                            const arr = line.split(':');
                            const service = arr[0].trim();
                            const elapsed = arr[1].split(/[\s]+/)[0].replace(/[[\]]/g,'');
                            // logger.info(`AUTR ELAPSED - service:${service} elapsed:${elapsed}`);

                            // Using an array here because we can have the same sub service called multiple times in one audit trail, we assume them to be printed in the same order here and in the later stopwatch section
                            if (currContext.serviceMap.has(service)) {
                                // Push object onto existing array
                                currContext.serviceMap.get(service).push(
                                    {
                                        elapsed
                                    }
                                );
                            } else {
                                // Create new array with one entry
                                currContext.serviceMap.set(service, 
                                    [
                                        {
                                            elapsed
                                        }
                                    ]
                                );
                            }
                        }
                    } else if (line.match(stopwatchXmlStartRx)) {
                        // logger.info(`STOPWATCH START`);
                        currContext.swFlag = true;
                    } else if (currContext.swFlag) {
                        if (line.match(stopwatchXmlEndRx)) {
                            // logger.info(`STOPWATCH END`);
                            currContext.activeAutrId = undefined;
                            currContext.activeLogId = undefined;
                            currContext.activeAltAcctNum = undefined;
                            currContext.elapsedFlag = false;
                            currContext.swFlag = false;
                            currContext.activeService = undefined;
                            currContext.serviceMap = undefined;
                        } else {
                            if (line.match(stopwatchNameRx)) {
                                currContext.activeService = line.replace(/<\/.*/,'').replace(/.*>/,'');
                            } else if (currContext.activeService) {
                                if (line.match(stopwatchStartTsRx)) {
                                    const mapObj = currContext.serviceMap.get(currContext.activeService)[0];
                                    if (!mapObj) {
                                        logger.error(`No serviceMap object found for service on startTs: ${currContext.activeService} logId: ${currContext.activeLogId}`);
                                        return;
                                    } else {
                                        mapObj.startTs = line.replace(/<\/.*/,'').replace(/.*>/,'');
                                    }
                                } else if (line.match(stopwatchEndTsRx)) {
                                    // logger.info(`HERE`);
                                    // No need to set this in context since it's the last entry for this sub service
                                    const endTs = line.replace(/<\/.*/,'').replace(/.*>/,'');
                                    // logger.info(`endTs: ${endTs} LINE: ${line}`);
                                    // console.log(`endTs: ${endTs} LINE: ${line}`);
                                    
                                    const service = currContext.activeService;
                                    // Take the first array entry off
                                    const mapObj = currContext.serviceMap.get(service).shift();
                                    if (!mapObj) {
                                        logger.error(`No serviceMap object found for service on endTs: ${service} logId: ${currContext.activeLogId}`);
                                        return;
                                    }
                                    const logId = currContext.activeLogId;
                                    const acctNum = acctCache.get(logId);
                                    // If this is a non-"Provider" audit trail entry, we send it straight to the db without calculating a bunch of stats on it (to save on processing resources).
                                    // These are for entries like rules processing or decisioning in BAF.
                                    const insertToDb = !service.match(/Provider\[/i) ? true : false;
                                    if (acctNum) {
                                        // logger.info(`AUTR: ${currServer}|${service}|${logId}|${acctNum}|${mapObj.startTs}|${endTs}|${mapObj.elapsed}`);
                                        // output completed record
                                        outputRecord('parseAppLine',currServer,service,logId,acctNum,mapObj.startTs,endTs,mapObj.elapsed,insertToDb);
                                    } else {
                                        // logger.warn(`AcctNum entry not found. Adding to needAcctNumCache. logId: ${logId} LINE: ${line}`)
                                        if (!needNumRecordCache.has(logId)) {
                                            needNumRecordCache.set(logId, new Map());
                                        }
                                        const needMap = needNumRecordCache.get(logId);
                                        // logger.info(`Setting needmap alt acct num: ${currContext.activeAltAcctNum}`);
                                        // logger.info(`AUTR NEED: ${currServer}|${currContext.activeService}|${logId}|${currContext.activeAltAcctNum}|${mapObj.startTs}|${endTs}|${mapObj.elapsed}`);

                                        needMap.set(service, { 
                                            server: currServer,
                                            // service,
                                            logId,
                                            startTs: mapObj.startTs,
                                            endTs,
                                            elapsed: mapObj.elapsed,
                                            altAcctNum: currContext.activeAltAcctNum,
                                            insertToDb
                                        });
                                    }
                                    // currContext.serviceMap.delete(service);
                                }
                            }
                        }
                    }
            } else {
                // This is a random log line, do nothing with it
            }

        }

        // Log line type regexes - Precompile for performance
        const soapLogRx = new RegExp(/soap_io/);
        const serverLogRx = new RegExp(/server\.log/);
        const ejbCTEntryRx = new RegExp(/INFO *\[CommonTiming] The EJB/);
        const ejbCTExitRx = new RegExp(/INFO *\[CommonTiming] Total time/);
        const ctEntryRx = new RegExp(/INFO *CommonTiming::Start/);
        const ctExitRx = new RegExp(/INFO *CommonTiming::Stop/);

        const readLine = (currLogFp, line) => {
            if (!line) {
                return;
            }
            
            let currLog = currLogFp.split('/').pop();
            let currServer = currLogFp.split('/')[2];
            let currType;

            if (!currServer || currServer == 'undefined') {
                logger.error(`currServer was undefined in readline! LINE: ${line}`);
            }

            if (currLog.match(soapLogRx)) {
                currType = 'SOAP';
            } else if (currLog.match(serverLogRx)) {
                currType = 'SERVER';
            } else {
                currType = 'APP';
            }

            if (currType === 'SOAP') {
                parseSoapLine(line, currLogFp);
            } else if (currType === 'SERVER') {
                // SERVER and APP are very similarly parsed, but each has a mutually exclusive type of log to parse so separating them will make things a little more efficient. Both have standard CommonTiming entries. server.log has top-level EJB CommonTiming which are a different format. App logs (mainly only BAF apps) have audit trail logs which are the real pain.

                // EJB common timing entry
                if (line.match(ejbCTEntryRx)) {
                    parseEjbCommonTimingEntry(line, currServer);
                // EJB common timing exit
                } else if (line.match(ejbCTExitRx)) {
                    parseEjbCommonTimingExit(line, currServer);
                // Standard common timing entry
                } else if (line.match(ctEntryRx)) {
                    parseCommonTimingEntry(line, currServer);
                // Standard common timing exit
                } else if (line.match(ctExitRx)) {
                    parseCommonTimingExit(line, currLogFp, currServer);
                }
            } else if (currType === 'APP') {
                // Standard common timing entry
                if (line.match(ctEntryRx)) {
                    parseCommonTimingEntry(line, currServer);
                // Standard common timing exit
                } else if (line.match(ctExitRx)) {
                    parseCommonTimingExit(line, currLogFp, currServer);
                // Else it is a standard APP line
                } else {
                    parseAppLine(line, currLogFp, currServer);
                }
            }
            
                // if (line.match(/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2},/)) {
                    // queueStats.incrMsgInCounter();
                    // if (paused) {
                    //     buffer.push(line);
                    // } else {
                    //     const success = outChannel.sendToQueue(outQueue, Buffer.from(line, 'utf8'));
                    //     if (!success) {
                    //         logger.info(`--- QUEUE BUFFER FULL --- Pausing readline until drain event`);
                    //         rl.pause();
                    //         buffer.push(line);
                    //     } else {
                    //         if (PARSETXCONFIG.verboseQueueWrite) logger.info(`QUEUE: ${line}`)
                    //         queueStats.incrMsgOutCounter();
                    //     }
                    // }
                // } else {
                //     logger.error(`Invalid line format detected! Did not start with valid timestampe: xxx ${line} xxx`);
                // }
        //    logger.info(" [x] Sent %s", line);
        }

        logger.info(PARSETXCONFIG.maskSuffixes.map(suffix => `${PARSETXCONFIG.appLogDirMaskPrefix}/${suffix}`));
        // const paths = await globby(PARSETXCONFIG.maskSuffixes.map(suffix => `${PARSETXCONFIG.appLogDirMaskPrefix}/${suffix}`));
        glob(PARSETXCONFIG.maskSuffixes.map(suffix => `${PARSETXCONFIG.appLogDirMaskPrefix}/${suffix}`), 
            (er, files) => {
                if (er) {
                    logger.error(`Glob error: ${er}`);
                } else {
                    // logger.info(`Files: ${JSON.stringify(files, undefined, 2)}`);
                    startTails(files);
                }
            }
        );

        const tailHandles = [];
        const rlHandles = [];

        function startTails(files) {
            files.forEach(file => tailFile(file));
        }

        function createPauseFile() {
            // logger.info(`Checking: ${PARSETXCONFIG.tailPauseFileFullPath}`);
            // logger.info(`Exists: ${fs.existsSync(PARSETXCONFIG.tailPauseFileFullPath)}`);
            fs.open(PARSETXCONFIG.tailPauseFileFullPath, "a", function (err, fd) {
                // handle error
                if (err) {
                    logger.error(`Error opening pause file in append mode.`);
                    return;
                }
                fs.close(fd, (err) => {
                    if (err) {
                        logger.error(`Error closing opened pause file.`);
                    }
                });
            });
        }

        function pauseReads() {
            if (!paused) {
                paused = true;
            }
            logger.info('Pausing all readlines.');
            createPauseFile();
            // if (!fs.existsSync(PARSETXCONFIG.tailPauseFileFullPath)) {
            //     const fd = fs.openSync(PARSETXCONFIG.tailPauseFileFullPath, 'a');
            //     fs.closeSync(fd);
            //     logger.info(`Pause file created!`);
            // }
            // logger.info('AFTER FS STUFF');
            // rlHandles.forEach(rlHandle => {
            //     rlHandle.pause();
            // });
            // logger.info('AFTER RL PAUSED');
            // }
        }

        function deletePauseFile() {
            fs.access(PARSETXCONFIG.tailPauseFileFullPath, fs.F_OK, (err) => {
                if (err) {
                    return;
                }
                
                // file exists
                fs.unlink(PARSETXCONFIG.tailPauseFileFullPath, err => {
                    if (err) logger.error(`Error deleting pause file.`)
                });
            });
        }

        function resumeReads() {
            // if (paused) {
            //     paused = false;
                logger.info('Resuming all readlines.');
                deletePauseFile();
                // if (fs.existsSync(PARSETXCONFIG.tailPauseFileFullPath)) {
                //     fs.unlink(PARSETXCONFIG.tailPauseFileFullPath, err => logger.error(`Error deleting pause file.`));
                // }


                // rlHandles.forEach(rlHandle => {
                //     rlHandle.resume();
                // });
            // }
        };

        // Make sure the pause file is cleared out on initial startup
        deletePauseFile();

        function tailFile(file) {
            logger.info(`Spawning tail on file: ${file}`);

            // logger.info(`Spawning tail: ${file}

            // const tail = spawn(`{ tail --max-unchanged-stats=1 --retry -F ${file} 2>&1 >&3 3>&- | grep -v "following end of new file" >&2 3>&-; } 3>&1`, {
            // const tail = spawn(`{ tail -s 0.2 -F ${file} 2>&1 >&3 3>&- | grep -v "following end of new file" >&2 3>&-; } 3>&1`, {
            // Without the 2 second instead of default 1 second, we're getting lots of cut up lines, probably due to update speed of the logs over net mount
            // const tail = spawn(`tail -s 5 -F ${file}`, {
                
            const tail = spawn(`${PARSETXCONFIG.tailCommandPath} ${file} ${PARSETXCONFIG.tailPauseFileFullPath}`, {
                // stdio: 'inherit',
                detached: false,
                shell: true
            });
            tailHandles.push(tail);

            tail.on('exit', function (code, signal) {
                logger.error(`Tail process exited with code ${code} and signal ${signal}`);
                exit(code);
            });

            tail.on('error', err => {
                logger.error(`Tail error for ${file}: ${err}`);
            });

            // May want to move this to &3 instead of stderr
            tail.stderr.on('data', (data) => {
                logger.warn(`Tail data (on STDERR): ${data}`);
            });

            const rl = readline.createInterface({
                input: tail.stdout,
                output: process.stdout,
                terminal: false,
                crlfDelay: Infinity
            });
            rlHandles.push(rl);

            rl.on('line', line => {
                readLine(file, line);
            });

            // function preReadLine(line) {
            //     readLine(line)
            // }

            rl.on('close', function() {
                logger.info('Input stream closed. Exiting 0 (not really).');
                // process.exit(0);
            });;

            rl.on('pause', () => {
                // paused = true;
                logger.info('Readline paused.');
            });

            rl.on('resume', () => {
                // paused = false;
                logger.info('Readline unpaused.');
                // logger.info('Readline unpaused. Attempting to write buffered entries to queue before resuming readline.');
            });

            rl.on('SIGCONT', () => {
                logger.info('Readline SIGCONT.');
            });
            rl.on('SIGINT', () => {
                logger.info('Readline SIGINT.');
            });
            rl.on('SIGTSTP', () => {
                logger.info('Readline SIGTSTP.');
            });

        }

    } catch (error) {
        logger.error(`Caught error: ${error}\n${new Error().stack}`);
    }
})();
