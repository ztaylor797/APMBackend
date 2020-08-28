#!/usr/bin/env node

const amqp = require('amqplib');
const fs = require("fs");

const heapdump = require('heapdump');
let path = require('path');
let nodeOomHeapdump = require('node-oom-heapdump')({
    path: path.resolve((__filename.split('.').slice(0, -1)).join('.')),
	heapdumpOnOOM: true,
	addTimestamp: true
});

const { QueueManager } = require('./queue.js');
const BinaryHeap = require('./binary_heap.js');
const { TxEntry, StatEntry, EntryFactory } = require('./entries.js');
const UtilMethods = require('./util_methods.js')();

// START GLOBALS ///////////////////////////////////
// let queueFull = false;
// let buffer = [];
let entryFactory;
let isConsuming = false;

// const queueStats = new QueueStats(true, false);
//  END  GLOBALS ///////////////////////////////////

class StatParser {
	constructor(servers, latestBucket, minHeap) {
		if(arguments.length === 3) { // Currently not using this
			this.setProperties(servers, latestBucket, minHeap);
		} else {
			this.setProperties({}, 0, new BinaryHeap(txEntry => {
				// Scoring method, convert timestamp to milliseconds integer, lower (earlier) timestamp will be a lower number
				return txEntry.endTs;
			}));
		}
	}

	setProperties(servers, latestBucket, minHeap) {
		this.servers = servers;
        this.latestBucket = latestBucket;
		this.minHeap = new BinaryHeap(txEntry => {
			// Scoring method, convert timestamp to milliseconds integer, lower (earlier) timestamp will be a lower number
			return txEntry.endTs;
		});

		// When reading in saved data, the json data is converted as raw Objects instead of as the entry class objects, so we convert each item in the heap array to its respective entry class type by using the factory below, then push it back onto the heap to guarantee the resumed data is sorted
		minHeap.content.forEach(obj => {
            this.minHeap.push(entryFactory.getEntryFromObject(obj));
		});
	}

	saveToResumeFile(resumeFile, quiet) {
		if (!quiet) logger.info(`Saving data to resume file: ${resumeFile}`);

		const json = JSON.stringify(this);

		fs.writeFileSync(resumeFile, json);

		if (!quiet) logger.info(`Resume file has been saved: ${resumeFile}`);
	}

	resumeFromFileIfExists(resumeFile) {

		// Check if the file exists in the directory, and if it is writable.
		// fs.access(resumeFile, fs.constants.F_OK | fs.constants.W_OK, (err) => {
        try {
            fs.accessSync(resumeFile, fs.constants.F_OK | fs.constants.W_OK);
            logger.info(`Resume file found! Resuming data from file: ${resumeFile}`);
            const content = fs.readFileSync(resumeFile);
            try {
                const jsonContent = JSON.parse(content);
                try {
                    this.setProperties(jsonContent.servers, jsonContent.latestBucket, jsonContent.minHeap);
                    
                } catch (e) {
                    logger.error(`Could not setProperties from resumed data. This is usually from failures in parsing the minHeap entries.`);
                }
            } catch (e) {
                logger.error(`Could not parse JSON content from resume file: ${resumeFile}`);
            }	
        } catch (err) {
            logger.warn(`Resume file does not exist or is not writeable, will not resume data: ${resumeFile}`);
            // process.exit(2); // TODO maybe change this?
        }
	}

	generateBucketLabel(stringMsTs) {
        // Truncate all after the '10s of seconds' column
        return stringMsTs.toString().slice(0,-4);

        // const ts = new Date(parseInt(stringMsTs)).convertDateToLogDate();
		// // Replace the last second digit with 0 so that each timestamp can be associated with a 10 second interval bucket
		// return parseInt(new Date(ts.replace(/.$/, '0')).getTime().toString().slice(0, -4));
	}

	generateTsFromBucketLabel(bucketLab) {
		// return new Date(parseInt(`${bucketLab}0000`)).getTime();
		return parseInt(`${bucketLab}0000`);
	}

	removeOldBuckets(numKeepIntervals) {
		Object.entries(this.servers).forEach(([server, serverObj]) => {
			Object.entries(serverObj.services).forEach(([service, serviceObj]) => {
				Object.entries(serviceObj.buckets).forEach(([bucketLab, bucketObj]) => {
					if (bucketLab < this.latestBucket - numKeepIntervals) {
						delete serviceObj.buckets[bucketLab];
					}
				});
			});
		});
	}

	addData(txEntry, bucketLabel) {

		const server = txEntry.server;
        const service = txEntry.service;
        
        // if (txEntry.server == undefined || txEntry.server == 'undefined') {
        //     logger.error(`Server was undefined! bucketLabel: ${bucketLabel} txEntry: ${JSON.stringify(txEntry, undefined, 2)}`);
        // }

		// Initialize all the nested structures if they aren't already
		if (!this.servers[server]) this.servers[server] = { services: {} };
		if (!this.servers[server].services[service]) this.servers[server].services[service] = { buckets: {} };
		if (!this.servers[server].services[service].buckets[bucketLabel]) {
			this.servers[server].services[service].buckets[bucketLabel] = [];
		}

		this.servers[server].services[service].buckets[bucketLabel].push(parseInt(txEntry.elapsed));

		this.minHeap.push(txEntry);
	}

	writeHeapToQueue(ts, outQueue) {
		// writeStringToQueue(channel, outQueue, `LETS: ${ts} heapBefore: ${this.minHeap.size()}`);
		// logger.info(`\nLETS: ${ts} heapBefore: ${this.minHeap.size()}`);
		let prevTsInt = 0;
		let prevEntry = undefined;
		this.minHeap.popAllLessOrEqualToScore(this.minHeap.scoreFunction({ endTs: ts })).forEach(el => {
			// let tsInt = parseInt(new Date(el.timestamp).getTime());
			// // logger.info(`tsInt: ${tsInt} ${el.toCSVString()}`);
			// if (tsInt < prevTsInt) {
			// 	logger.info(`+++ ERROR1 +++ ${prevEntry.toCSVString()}\n+++ ERROR2 +++ ${el.toCSVString()}\n\n`);
			// }
			// prevTsInt = tsInt;
			// prevEntry = el;
			// logger.info(`QUEUE ${tsInt} ${el.toCSVString()}`);
            // writeStringToQueue(channel, outQueue, el.toCSVString());
            outQueue.writeLineToQueue(el.toCSVString(), CALCSTATSCONFIG.verboseQueueWrite);
		});
		// writeStringToQueue(channel, outQueue, `POST: ${ts} heapAfter: ${this.minHeap.size()}`);
		// logger.info(`POST: ${ts} heapAfter: ${this.minHeap.size()}`);
	}

	generateAllStatsToQueue(ts, intervalLengthSec, windowSz, numKeepIntervals, intervalBufferSz, outQueue) {

		Object.entries(this.servers).forEach(([server, serverObj]) => {
			Object.entries(serverObj.services).forEach(([service, serviceObj]) => {
			
				let windowCntSum = 0; // Total of all counts in this window, so total transaction count
				let windowRtTotalSum = 0; // Total of all transaction response times in this window
				const windowSortedElapTimes = []; // Sorted array of all elapsed times in this window

				let windowRtSimpleAvg = undefined;
				let windowPer75 = undefined;
				let windowPer95 = undefined;

				// let numBuckets = 0; // Counting actual buckets so we know how many to use in tps calculation in case we are < window size (aka script just started recently)
				Object.entries(serviceObj.buckets).forEach(([bucketLab, bucketArr]) => {
					if (bucketLab >= this.latestBucket - numKeepIntervals && bucketLab <= this.latestBucket - intervalBufferSz) {
						// numBuckets++;
						windowCntSum += bucketArr.length;
						bucketArr.forEach(el => windowRtTotalSum += el);
						windowSortedElapTimes.binaryConcat(bucketArr, true); // We do want to insert duplicate elapsed times, so second param is "true"
					}
				});

				if (windowCntSum !== 0) {
					windowRtSimpleAvg = windowRtTotalSum / windowCntSum;
					windowPer75 = windowSortedElapTimes.calcPercentile(75);
					windowPer95 = windowSortedElapTimes.calcPercentile(95);
				}

				const windowTpm = windowCntSum / (windowSz * intervalLengthSec / 60.0); // A bucket is equivalent to a single interval

				// if (server === 'xcla9571');
				// 	logger.info(`${service} ::: windowTpm = ${windowCntSum} / (${windowSz} * ${intervalLengthSec} / 60.0) = ${windowTpm}`);

				const statEntry = new StatEntry(ts, server, service, windowTpm, windowRtSimpleAvg, windowPer75, windowPer95);

				if (statEntry.tpm == null || statEntry.tpm == undefined || isNaN(statEntry.tpm)) {
					logger.error(`StatEntry TPM was not a valid number, this should not happen!: ${JSON.stringify(statEntry, undefined, 2)}`);
				}
				// if (service === 'S:getReactiveCLIPreDecision') {
				// 	logger.info(statEntry.toCSVString());
				// }
                // writeStringToQueue(channel, outQueue, statEntry.toCSVString());
                outQueue.writeLineToQueue(statEntry.toCSVString(), CALCSTATSCONFIG.verboseQueueWrite);
			});
		});
	}
};

//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////
// MAIN
//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////

(async () => {

	try {
		APMCONFIG = readAPMConfig();
		CALCSTATSCONFIG = APMCONFIG.streamCalcStats;
		await setGlobalLogger(APMCONFIG.logDir, CALCSTATSCONFIG.logFilePrefix); // This sets global.logger for use here and in modules

		// queueStats.logQueueStatsRecurs(APMCONFIG.statLogIntervalInSeconds);
        
        // console.log(`HERE01`);
        // logger.info(`HERE01`);
        entryFactory = new EntryFactory();

		const data = new StatParser();
		data.resumeFromFileIfExists(CALCSTATSCONFIG.resumeFileFullPath);

		function getParseSettings(CALCSTATSCONFIG) {
			return {
				INTERVAL_LENGTH_SEC: parseInt(CALCSTATSCONFIG.intervalLengthInSeconds),
				WINDOW_SZ: parseInt(CALCSTATSCONFIG.windowSizeInIntervals),
				INTERVAL_BUFFER_SZ: parseInt(CALCSTATSCONFIG.bufferSizeInIntervals),
				NUM_KEEP_INTERVALS: parseInt(CALCSTATSCONFIG.windowSizeInIntervals) + parseInt(CALCSTATSCONFIG.bufferSizeInIntervals)
			};
		}

		let { INTERVAL_LENGTH_SEC, WINDOW_SZ, INTERVAL_BUFFER_SZ, NUM_KEEP_INTERVALS } = getParseSettings(CALCSTATSCONFIG);

        const qm = new QueueManager(APMCONFIG.amqpConnectionString, APMCONFIG.statLogIntervalInSeconds);
        // console.log(`HERE03`);

		watchAPMConfig(
			APMCONFIG, 
			async (newAPMCONFIG) => { 
				APMCONFIG = newAPMCONFIG; 
				CALCSTATSCONFIG = APMCONFIG.streamCalcStats;
				await setGlobalLogger(APMCONFIG.logDir, CALCSTATSCONFIG.logFilePrefix); // This sets global.logger for use here and in modules
                // queueStats.setInterval(APMCONFIG.statLogIntervalInSeconds);
                qm.setInterval(APMCONFIG.statLogIntervalInSeconds);                
				({ INTERVAL_LENGTH_SEC, WINDOW_SZ, INTERVAL_BUFFER_SZ, NUM_KEEP_INTERVALS } = getParseSettings(CALCSTATSCONFIG));
				if (!CALCSTATSCONFIG.consumeQueue && isConsuming) {
					logger.info(`Stopping consume from watcher!`);
					await stopConsume(inChannel); // Might need await
				}
				if (CALCSTATSCONFIG.consumeQueue && !isConsuming) {
					logger.info(`Starting consume from watcher!`);
					startConsume();
				}
			},
			[ 'apmConfigFilePath', 'amqpConnectionString', 'streamParse.inQueue', 'streamParse.outQueue' ]
		);

        // console.log(`HERE3.5`);
        const inQueue = await qm.getQueue(CALCSTATSCONFIG.inQueue, 'c', consumeMsg);
        const outQueue = await qm.getQueue(CALCSTATSCONFIG.outQueue, 'p');
        const dbQueue = await qm.getQueue(APMCONFIG.dbInsertQueue, 'p');

        // console.log(`HERE04`);

        qm.on('pause', () => {
            stopConsume();
        });
        
        qm.on('resume', () => {
            startConsume();
        });

		// // Connect to local rabbitmq queue to stream in data
		// const connection = await amqp.connect(APMCONFIG.amqpConnectionString);

        // const inQueue = CALCSTATSCONFIG.inQueue;
        // const outQueue = CALCSTATSCONFIG.outQueue;

		// const inChannel = await connection.createChannel();
		// if (!inChannel) {
		// 	logger.info(`Error: connection.createChannel() failed on inChannel`);
		// }
		// await inChannel.assertQueue(inQueue, {
		// 	durable: true
		// });

		// const outChannel = await connection.createChannel();
		// if (!outChannel) {
		// 	logger.info(`Error: connection.createChannel() failed on outChannel`);
		// }
		// await outChannel.assertQueue(outQueue, {
		// 	durable: true
		// });

        // logger.info(`[*] Waiting for messages in ${inQueue}. To exit press CTRL+C`);
        // logger.info(`[*] Writing processed data to ${outQueue}.`);
		
		async function exit() {
			data.saveToResumeFile(CALCSTATSCONFIG.resumeFileFullPath);
            try {
                await qm.shutdown();
            } catch (err) {
                logger.error(`qm.shutdown() error: ${err}`);
            }  
			logger.info(`Exiting...`);
			process.exit(0);
		}

		process.on('SIGINT', function() {
			logger.warn(`Caught SIGINT signal`);
			exit();
        })
        .on('SIGTERM', function() {
			logger.warn(`Caught SIGTERM signal`);
			exit();
        });

		// Every minute, save the current data in case the process terminates unexpectedly (IE kill -9 instead of kill)
		setInterval(() => {
			data.saveToResumeFile(CALCSTATSCONFIG.resumeFileFullPath, true);
        }, CALCSTATSCONFIG.resumeFileSaveFrequencyInSeconds * 1000);

        // console.log(`HERE05`);
        // console.log(`HERE06`);

		function consumeMsg(msg) {
            const txEntry = entryFactory.getEntryFromCSV(msg.content.toString());

            if (!txEntry.server || txEntry.server == 'undefined') {
                logger.error(`Server was undefined! txEntry: ${JSON.stringify(txEntry, undefined, 2)}\n  MSG: ${msg.content.toString()}`);
            }

            const bucketLabel = data.generateBucketLabel(txEntry.endTs);
            // logger.info(`bucketLabel: ${bucketLabel}\nLINE: ${msg.content.toString()}\nTXENTRY: ${JSON.stringify(txEntry, undefined, 2)}`);
            // console.log(`bucketLabel: ${bucketLabel}\nLINE: ${msg.content.toString()}\nTXENTRY: ${JSON.stringify(txEntry, undefined, 2)}`);
            // process.exit();
            
			if (isNaN(bucketLabel)) {
				logger.error(`NaN bucket label generated from txEntry: ${JSON.stringify(txEntry, undefined, 2)}`);
			}

			// New interval detected if true, do all stat parsing, probably will block a while here
			if (bucketLabel > data.latestBucket) {
				if (CALCSTATSCONFIG.logDebug) logger.info(`New latest bucket: ${bucketLabel}`);

				data.latestBucket = bucketLabel;
				data.removeOldBuckets(NUM_KEEP_INTERVALS);

				// This timestamp is basically the end of the last bucket in the window, so if the window is 1:00-2:00, this would be 2:00
				// It is used to log all generated-stat entries like averages, percentiles, etc. so they are on the same exact timestamp
				const edgeTs = data.generateTsFromBucketLabel(data.latestBucket - INTERVAL_BUFFER_SZ - 1);

                // logger.info(`\ncurrentTs: ${new Date(ts).convertDateToLogDate()} edgeTs: ${new Date(edgeTs).convertDateToLogDate()}`);

                // At this point, we can still have transactions that sat for a long time in the node-caches in stream_parse_transactions
                // They wouldn't be sent out at the same time as the more immediate ones, might need to introduce a delay here
                // That means those stragglers won't be included in the stats that are generated by generateAllStatsToQueue
                // It should be really rare for this to happen though, mainly on startup. So leaving for now.
				data.writeHeapToQueue(edgeTs, dbQueue); // xxTODO change to dbQueue - DONE

				data.generateAllStatsToQueue(edgeTs, INTERVAL_LENGTH_SEC, WINDOW_SZ, NUM_KEEP_INTERVALS, INTERVAL_BUFFER_SZ, outQueue);
			}

			// Add elapsed data to bucket and full transaction to heap
			data.addData(txEntry, bucketLabel);
		}

        // const consumerTag = 'xConsumerTagx';
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

        if (CALCSTATSCONFIG.consumeQueue) startConsume();

	} catch (error) {
		logger.error(`Caught error: ${error}\n${new Error().stack}`);
	}
})();

