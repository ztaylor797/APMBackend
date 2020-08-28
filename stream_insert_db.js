#!/usr/bin/env node

// NOTE: It is normal for the fs type entry inserts to be the same count every time as a set number of records is generated for every window
//       As of creating this, it generates 760 records every 10 seconds.

const amqp = require('amqplib');
const fs = require("fs");
// const sqlite3 = require('sqlite3').verbose();
const pgp = require('pg-promise')({
    capSQL: true // generate capitalized SQL 
});    
const EventEmitter = require('events');
const { PerformanceObserver, performance } = require('perf_hooks');

const heapdump = require('heapdump');
let path = require('path');
let nodeOomHeapdump = require('node-oom-heapdump')({
    path: path.resolve((__filename.split('.').slice(0, -1)).join('.')),
    heapdumpOnOOM: true,
	addTimestamp: true
});

const { QueueManager } = require('./queue.js');
const UtilMethods = require('./util_methods.js')();
const { EntryFactory } = require('./entries.js');
const { DBStats } = require('./dbstats.js');

// START GLOBALS ///////////////////////////////////
let APMCONFIG;
let INSERTDBCONFIG;
let isConsuming = false;

const dbStats = new DBStats();
//  END  GLOBALS ///////////////////////////////////

// class MyEmitter extends EventEmitter {}



// async function setUpDB(db, tableName, dbBusyTimeout) {  
//     await db.run( 'PRAGMA journal_mode = WAL;' );
//     await db.configure("busyTimeout", 500);

//     await sleep(1000);

//     await db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (
//             Timestamp DATETIME,
//             Type TEXT,
//             Server TEXT,
//             Service TEXT,
//             Data TEXT
//         )`, err => {
//             if (err) {
//                 logger.info(`Could not create table: ${tableName}! Exiting.`);
//                 exit();
//             }
//     });

//     await sleep(1000);

//     await db.run(`CREATE INDEX IF NOT EXISTS ${tableName}_ix0 on ${tableName} (Timestamp)`, err => {
//             if (err) {
//                 logger.info(`Could not create index: ${tableName}_ix0! Exiting.`);
//                 exit();
//             }
//     });
// }



//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////
// MAIN
//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////

const args = process.argv.slice(2); // First two args are node path and this script's path, so ignore them

// queueStats.logQueueStatsRecurs();

(async () => {

    try {
        APMCONFIG = readAPMConfig(true);
        INSERTDBCONFIG = APMCONFIG.streamInsertDb;
        await setGlobalLogger(APMCONFIG.logDir, INSERTDBCONFIG.logFilePrefix); // This sets global.logger for use here and in modules

        dbStats.logDBStatsRecurs(APMCONFIG.statLogIntervalInSeconds);
        // queueStats.logQueueStatsRecurs(APMCONFIG.statLogIntervalInSeconds);
        const qm = new QueueManager(APMCONFIG.amqpConnectionString, APMCONFIG.statLogIntervalInSeconds);

        let bufferLimit = parseInt(INSERTDBCONFIG.dbInsertBufferLimit);

        watchAPMConfig(
            APMCONFIG,
            async (newAPMCONFIG) => { // Callback to update local variables on APM config file update
                prevAPMCONFIG = APMCONFIG;
                APMCONFIG = newAPMCONFIG; 
                INSERTDBCONFIG = APMCONFIG.streamInsertDb;
                await setGlobalLogger(APMCONFIG.logDir, INSERTDBCONFIG.logFilePrefix); // This sets global.logger for use here and in modules
                // queueStats.setInterval(APMCONFIG.statLogIntervalInSeconds);
                dbStats.setInterval(APMCONFIG.statLogIntervalInSeconds);
                bufferLimit = parseInt(INSERTDBCONFIG.dbInsertBufferLimit);
                qm.setInterval(APMCONFIG.statLogIntervalInSeconds);
                if (!INSERTDBCONFIG.consumeQueue && isConsuming) {
                    logger.info(`Stopping consume from watcher!`);
                    await stopConsume(); // Might need await
                }
                if (INSERTDBCONFIG.consumeQueue && !isConsuming) {
                    logger.info(`Starting consume from watcher!`);
                    await startConsume();
                }
            },
            [ 'apmConfigFilePath', 'amqpConnectionString', 'dbInsertQueue',
              'streamInsertDb.dbUser', 'streamInsertDb.dbHost', 'streamInsertDb.dbDatabase',    
              'streamInsertDb.dbTxTable', 'streamInsertDb.dbStatTable', 'streamInsertDb.dbAlertTable', 'streamInsertDb.dbJmxTable' ]
        );

        // Connect to local rabbitmq queue to stream in data
        const inQueue = await qm.getQueue(APMCONFIG.dbInsertQueue, 'c', consumeMsg);

        qm.on('pause', () => {
            stopConsume();
        });
        
        qm.on('resume', () => {
            startConsume();
        });

        // Default open mode is OPEN_READWRITE | OPEN_CREATE
        // let db = openDB(APMCONFIG.dbFileFullPath);

        function openDB() {
            const db = pgp({
                user: INSERTDBCONFIG.dbUser,
                host: INSERTDBCONFIG.dbHost,
                database: INSERTDBCONFIG.dbDatabase
                // password: 'secretpassword',
                // port: 3211,
            });
            // = new pgp.helpers.ColumnSet(['col_a', 'col_b'], {table: 'tmp'});
            return db;
        }

        function closeDB(db) {
            if (db) db.$pool.end;  
        }

        function getColumnSets() {
            const map = new Map();
            let txCs = new pgp.helpers.ColumnSet(['endts', 'startts', 'server', 'service', 'logid', 'acctnum', 'elapsed', 'toplevel'], {table: INSERTDBCONFIG.dbTxTable});
            map.set('tx', txCs);
            let statCs = new pgp.helpers.ColumnSet(['timestamp', 'server', 'service', 'tpm', 'lag', 'stats'], {table: INSERTDBCONFIG.dbStatTable});
            map.set('fs', statCs);
            let alertCs = new pgp.helpers.ColumnSet(['entrytimestamp', 'alerttimestamp', 'server', 'service', 'cause', 'entry'], {table: INSERTDBCONFIG.dbAlertTable});
            map.set('al', alertCs);
            let jmxCs = new pgp.helpers.ColumnSet(['timestamp', 'server', 'dsinusenodes', 'dsactivenodes', 'dsavailablenodes', 'heapused', 'heapcommitted', 'heapmax', 'metaused', 'metacommitted', 'metamax', 'sysload', 'classcnt', 'threadcnt', 'daemonthreadcnt', 'beanpoolavailablecnt', 'beanpoolcurrentsize', 'beanpoolmaxsize'], {table: INSERTDBCONFIG.dbJmxTable});
            map.set('jx', jmxCs);
            return map;
        }

        const db = openDB();
        const columnSetMap = getColumnSets();

        // Map<entryType, arrayOfEntries>
        let insertBufferMap = resumeBufferFromFileIfExists(INSERTDBCONFIG.bufferResumeFileFullPath);
        // console.warn(insertBufferMap);
        if (!insertBufferMap) {
            insertBufferMap = new Map();
            insertBufferMap.set('tx', []);
            insertBufferMap.set('fs', []);
            insertBufferMap.set('al', []);
            insertBufferMap.set('jx', []);
        }

        for (type of columnSetMap.keys()) {
            if (!insertBufferMap.type) {
                insertBufferMap.set(type, []);
            }
        }

        // This map will contain a single setTimeout handler for each buffer type that we use to insert records if they haven't been inserted for a while (mainly for alerts which are very infrequent), the timeout is initialized on first entry into a fresh buffer
        const bufferTimeoutMap = new Map();

        // Initialize a timeout on each buffer
        for (type of columnSetMap.keys()) {
            if (bufferTimeoutMap.has(type)) {
                const oldTimeout = bufferTimeoutMap.get(type);
                if (oldTimeout) {
                    clearTimeout(oldTimeout);
                }
            }
            const newTimeout = setTimeout(() => {
                processBuffer(type, 'timeout');
            }, INSERTDBCONFIG.dbMaxTimeBetweenInsertsMs);
            bufferTimeoutMap.set(type, newTimeout);
        }
        // setInterval(() => {
        //     logger.info(`fs buffer length: ${insertBufferMap.get('fs').length}`);
        // }, 2000)

        // function clearBufferTimeout(type) {
        //     if (bufferTimeoutMap.has(type)) {
        //         const timeout = bufferTimeoutMap.get(type);
        //         if (timeout) {
        //             clearTimeout(timeout);
        //         }
        //     }
        // }

        function clearAllBufferTimeouts() {
            let cleared = 0;
            bufferTimeoutMap.forEach((timeout, type) => {
                if (timeout) {
                    clearTimeout(timeout);
                    cleared++;
                }
            });
            logger.info(`Timeouts cleared: ${cleared}`);
        }

        async function exit() {
            clearAllBufferTimeouts();
            await processAllBuffers();
            saveToResumeFile(INSERTDBCONFIG.bufferResumeFileFullPath, insertBufferMap);
            try {
                await qm.shutdown();
            } catch (err) {
                logger.error(`qm.shutdown() error: ${err}`);
            }
            closeDB(db);

            // try {
            //     await db.close((err) => {
            //         if (err) {
            //             logger.error(err.message);
            //         }
            //     });
            // } catch (err) {
            //     logger.error(`db.close() error: ${err}`);
            // }
			logger.info(`Exiting...`);
			process.exit(0);
		}

		process.on('SIGINT', function() {
			logger.info(`Caught SIGINT signal`);
			exit();
		});
		process.on('SIGTERM', function() {
			logger.info(`Caught SIGTERM signal`);
			exit();
        });
        
        const entryFactory = new EntryFactory();

        // await setUpDB(db, INSERTDBCONFIG.dbDataTable, INSERTDBCONFIG.dbBusyTimeout);

        // const myEmitter = new MyEmitter();

        async function processAllBuffers() {
            logger.info(`Processing all buffers before exiting...`);
            // insertBufferMap.forEach(async (arr, type) => {
            for (type of insertBufferMap.keys()) {
                logger.info(`Buffer: ${type} Length: ${insertBufferMap.get(type).length}`);
            };
            for await (type of insertBufferMap.keys()) {
                await processBuffer(type);
            };
            logger.info(`Buffers processed!`);
            // insertBufferMap.forEach(async (arr, type) => {
            for (type of insertBufferMap.keys()) {
                logger.info(`Buffer: ${type} Length: ${insertBufferMap.get(type).length}`);
            };
        }

        async function processBuffer(type, source = undefined) {
            if (insertBufferMap.get(type).length <= 0) {
                return;
            }

            // if (source === 'timeout') {
            //     logger.info(`Calling processBuffer from timeout for buffer: ${type}`);
            // } else {
            //     logger.info(`Calling processBuffer from limit for buffer: ${type}`)
            // }
            
            // Not a fan of these deep copy array steps, but w/o it we keep running into async issues where this method fires many times right when the buffer fills
            // Drain all buffer elements into new tmp buffer
            const insertBuffer = [];
            while (insertBufferMap.get(type).length) {
                insertBuffer.push(insertBufferMap.get(type).shift());
            }
            // logger.info(`insertBuffer.length: ${insertBuffer.length} map length: ${insertBufferMap.get(type).length}`);
            const start = performance.now();
            try {
                // let insertedCount = 0;
                const query = () => pgp.helpers.insert(insertBuffer, columnSetMap.get(type));

                try {
                    // While this method is firing asynchronously, the input stream still fires a bunch of consumeMsg methods, hence the buffers above
                    await db.none(query);
                    // logger.info(`Insert successful: ${insertBuffer.length} records from buffer: ${type}`);
                    dbStats.addToRecInsCounter(insertBuffer.length);

                    // insertBufferMap.set(type, []); // Clear buffer
                    // logger.info(`POST map length: ${insertBufferMap.get(type).length}`);
                    dbStats.addToInsElapTotal(performance.now() - start);

                } catch (err) {
                    logger.error(`Error during insert attempt: ${err}`);
                    // logger.warn(JSON.stringify(insertBuffer.slice(0,5), undefined, 2));
                    const mapArr = insertBufferMap.get(type);
                    while (insertBuffer.length) {
                        if (!("acctnum" in insertBuffer[0])) {
                            logger.warn(JSON.stringify(insertBuffer[0], undefined, 2));
                        }
                        mapArr.unshift(insertBuffer.shift());
                    }
                }
                    //     queueStats.addToRecInsCounter(insertedCount);
            } catch (err) {
                logger.info(`Error caught on insert: ${err}`);
            }
            // queueStats.addToInsElapTotal(performance.now() - start);

        };

        async function addToInsertBuffer(type, postgresObj) {

            // On first insert to an empty buffer, create a setTimeout and store it
            if (insertBufferMap.get(type).length === 0) {
                if (bufferTimeoutMap.has(type)) {
                    const oldTimeout = bufferTimeoutMap.get(type);
                    if (oldTimeout) {
                        clearTimeout(oldTimeout);
                    }
                }
                const newTimeout = setTimeout(() => {
                    processBuffer(type, 'timeout');
                }, INSERTDBCONFIG.dbMaxTimeBetweenInsertsMs);
                bufferTimeoutMap.set(type, newTimeout);
            }

            if (insertBufferMap.get(type).length >= bufferLimit) {
                // logger.info(`buffersize: ${insertBufferMap.get(type).length}`);
                await processBuffer(type);
            }
            insertBufferMap.get(type).push(postgresObj);
            // if (insertBufferMap.get(type).length === 5) {
            //     logger.info(JSON.stringify(insertBufferMap.get(type), undefined, 2));
            // }
        }

        async function consumeMsg(msg) {
            if (msg) {
                const entry = entryFactory.getEntryFromCSV(msg.content.toString());
                if (!entry) {
                    logger.info(`Entry undefined: ${msg.content.toString()}`);
                    logger.info(JSON.stringify(entry, undefined, 2));
                } else if (entry.type == 'tx' || entry.type == 'fs' || entry.type == 'al' || entry.type == 'jx') {
                    // if (entry.type == 'jx') {
                    //     logger.warn(JSON.stringify(entry, undefined, 2));
                    // }
                    try {
                        await addToInsertBuffer(entry.type, entry.toPostgresObject());
                    } catch (err) {
                        logger.error(`addToInsertBuffer for type:${entry.type} threw an error: ${err}`);
                    }
                } else {
                    logger.info(`Not a tx, fs, al, or jx: ${msg.content.toString()}`);
                    logger.info(entry.pprint());
                    // Shouldn't get non-full stat stats in the final queue or base entry objects
                }
            }
        }

        function startConsume() {
            if (!isConsuming) {
                isConsuming = true;
                logger.info(`+++ Starting consume +++`);
                inQueue.startConsume();
            }
        }

        async function stopConsume() {
            logger.info(`--- Stopping consume ---`);
            isConsuming = false;
            try {
                // await inChannel.cancel(consumerTag);
                await inQueue.stopConsume();
            } catch (err) {
                logger.error(`inQueue.stopConsume() threw an error: ${err}`);
            }
        }

        if (INSERTDBCONFIG.consumeQueue) startConsume();

    } catch (error) {
        logger.error(`Caught error: ${error}\n${new Error().stack}`);
    }
})();