#!/usr/bin/env node

const amqp = require('amqplib');
const fs = require("fs");

const { QueueManager } = require('./queue.js');
const { StatEntry, FullStatEntry, EntryFactory } = require('./entries.js');
const UtilMethods = require('./util_methods.js')();

const heapdump = require('heapdump');
let path = require('path');
let nodeOomHeapdump = require('node-oom-heapdump')({
    path: path.resolve((__filename.split('.').slice(0, -1)).join('.')),
    heapdumpOnOOM: true,
	addTimestamp: true
});

// START GLOBALS ///////////////////////////////////
// let queueFull = false;
// let buffer = [];
let isConsuming = false;

// const queueStats = new QueueStats(true, false);
//  END  GLOBALS ///////////////////////////////////

class ZScoreParser { 
    constructor() {
        this.setProperties();
    }

    setProperties(servers = {}) {
        if (servers) { 
            this.servers = servers;
        }
    }

    saveToResumeFile(resumeFile, quiet) {
        // const json = JSON.stringify(this, undefined, 2);
        const json = JSON.stringify(this);

        if (!quiet) logger.info(`Saving data to resume file: ${resumeFile}`);
        fs.writeFileSync(resumeFile, json);
		if (!quiet) logger.info(`Resume file has been saved: ${resumeFile}`);
    }
    
    resumeFromFileIfExists(resumeFile) {
		// Check if the file exists in the directory, and if it is writable.
		fs.access(resumeFile, fs.constants.F_OK | fs.constants.W_OK, (err) => {
			if (err) {
				logger.warn(`Resume file does not exist or is not writeable, will not resume data.`);
			} else {
				logger.info(`Resume file found! Resuming data from file: ${resumeFile}`);
				var content = fs.readFileSync(resumeFile);
				try {
					var jsonContent = JSON.parse(content);
					this.setProperties(jsonContent.servers);
				} catch (e) {
					logger.error(`Could not parse JSON content from resume file: ${resumeFile}`);
				}	
			}
        });
        
        this.updateAllServiceSettings();
    }

    processZScoreStats(lag, threshold, influence, newValue, prevValuesList) {
        let inflNewValue = newValue;
        
        let avg = undefined;
        let stdDev = undefined;
        let lb = undefined;
        let ub = undefined;
        let signal = 0;

        if (prevValuesList.length >= lag) { // IS THIS THE PROBLEM???????
            avg = prevValuesList.average();
            stdDev = prevValuesList.standardDeviation();

            // Calculate upper and lower bounds for graphing
            if ((avg || avg == 0) && (stdDev || stdDev == 0)) {
                lb = avg - threshold * stdDev; // Can go below 0
                ub = avg + threshold * stdDev;
            }

            if ((avg == null || avg == undefined || isNaN(avg)) || (stdDev == null || stdDev == undefined || isNaN(stdDev))) {
                signal = 0;
            } else if (!newValue && newValue != 0) {
                signal = 0;
            } else if (Math.abs(newValue - avg) > threshold * stdDev) {
                if (newValue > avg) {
                    signal = 1;
                } else {
                    signal = -1;
                }
                // Make influence lower, if the previous value on the array is defined
                if (prevValuesList[prevValuesList.length - 1] || prevValuesList[prevValuesList.length - 1] == 0)
                    inflNewValue = influence * newValue + (1 - influence) * prevValuesList[prevValuesList.length - 1];
            } else {
                signal = 0;
            }
        }

        return [ inflNewValue, avg, lb, ub, signal ];
    }

    getServiceSettingsFromConfig(service) {
        const settings = ZSCORECONFIG.defaults;

        if (ZSCORECONFIG.overrides.services[service]) {
            const serviceOverrides = ZSCORECONFIG.overrides.services[service];
            settings.forEach((el, index) => {
                Object.keys(serviceOverrides).forEach(lag => {
                    if (el.LAG == lag) {
                        if (serviceOverrides[lag].THRESHOLD) {
                            logger.debug(`Service: ${service} setting override for lag: ${lag} to THRESHOLD: ${serviceOverrides[lag].THRESHOLD}`);
                            settings[index].THRESHOLD = serviceOverrides[lag].THRESHOLD;
                        }
                        if (serviceOverrides[lag].INFLUENCE) {
                            logger.debug(`Service: ${service} setting override for lag: ${lag} to INFLUENCE: ${serviceOverrides[lag].INFLUENCE}`);
                            settings[index].INFLUENCE = serviceOverrides[lag].INFLUENCE;
                        }
                    }
                });
                // if (el.LAG == serviceOverrides.LAG) {
                //     if (serviceOverrides.THRESHOLD) settings[index].THRESHOLD = serviceOverrides.THRESHOLD;
                //     if (serviceOverrides.INFLUENCE) settings[index].INFLUENCE = serviceOverrides.INFLUENCE;
                // }
            });
        }

        return settings;
    }

    updateServiceSettings(server, service) {
        // logger.info(`updateServiceSettings(${server},${service})`);
        const settings = this.getServiceSettingsFromConfig(service);
        // logger.info(settings.pprint());
        // Loop over each settings block, basically by LAG value
        settings.forEach(el => {
            if (this.servers[server].services[service].lags[el.LAG]) {
                this.servers[server].services[service].lags[el.LAG].THRESHOLD = el.THRESHOLD;
                this.servers[server].services[service].lags[el.LAG].INFLUENCE = el.INFLUENCE;
            } else {
                this.servers[server].services[service].lags[el.LAG] = {
                    "THRESHOLD": el.THRESHOLD,
                    "INFLUENCE": el.INFLUENCE
                };
            }
        });
    }

    updateAllServiceSettings() {
        Object.entries(this.servers).forEach(([server, serverObj]) => {
			Object.entries(serverObj.services).forEach(([service, serviceObj]) => {
                this.updateServiceSettings(server, service);
            });
        });

        // Object.entries(this.servers).forEach(([server, serverObj]) => {
		// 	Object.entries(serverObj.services).forEach(([service, serviceObj]) => {
        //         Object.entries(serviceObj.lags).forEach(([lag, lagObj]) => {
        //             if (service === 'S:getLateFeeWaiver')
        //             logger.info(`${server} ${service} | ${lagObj.THRESHOLD} ${lagObj.INFLUENCE}`);
        //         });
        //     });
        // });
    }

    
    removeStaleLagData() {
        Object.entries(this.servers).forEach(([server, serverObj]) => {
			Object.entries(serverObj.services).forEach(([service, serviceObj]) => {
                const settings = this.getServiceSettingsFromConfig(service);
                // if (service === 'S:getPromoInfo') {
                //     logger.info(`Length: ${settings.length}`);
                //     settings.forEach(el => logger.info(`LAG: ${el.LAG}`)); //TODO remove
                //     Object.entries(serviceObj.lags).forEach(([lag, lagObj]) => {
                //         logger.info(`lag: ${lag}`);
                //         logger.info(`some: ${settings.some(el => el.LAG === lag)}`);
                //         logger.info(`some2: ${settings.some(el => el.LAG == lag)}`);
                //     });
                //     // logger.info(`some: ${settings.some(el => el.LAG === lag)}`);
                // }
                // For each lag value in the service object, if its lag value is not in the service config, delete it as it is stale, this happens when lag settings are changed
                Object.entries(serviceObj.lags).forEach(([lag, lagObj]) => {
                    if (!settings.some(el => parseInt(el.LAG) === parseInt(lag))) {
                        logger.info(`Deleting LAG data for ${server} ${service} Lag:${lag}`);
                        delete serviceObj.lags[lag];
                    }
                });
            });
        });
    }
    
    processData(statEntry) {

		const server = statEntry.server;
        const service = statEntry.service;

		// Initialize all the nested structures if they aren't already
		if (!this.servers[server]) this.servers[server] = { services: {} };
        if (!this.servers[server].services[service]) {
            // TODO when loading data form resume file, set all settings from ZSCORECONFIG
            // const settings = getServiceSettings(service);
            this.servers[server].services[service] = { lags: {} }; // Contains objects keyed on LAG value
            this.updateServiceSettings(server, service);
            // this.servers[server].services[service].settings = settings;
        }

        // logger.info(`server: ${server} service: ${service}`);
        // logger.info(`------------------`);
        // logger.info(this.pprint());
        // logger.info(`------------------`);

        const fsReturnArray = [];

        Object.entries(this.servers[server].services[service].lags).forEach(([lag, lagObj]) => {

            // logger.info(`LAG: ${lag}`);
            // logger.info(this.servers[server].services[service].lags[lag].pprint());
            const threshold = this.servers[server].services[service].lags[lag].THRESHOLD;
            const influence = this.servers[server].services[service].lags[lag].INFLUENCE;

            if (!this.servers[server].services[service].lags[lag].avgList)
                this.servers[server].services[service].lags[lag].avgList = [];
            if (!this.servers[server].services[service].lags[lag].per75List)
                this.servers[server].services[service].lags[lag].per75List = [];
            if (!this.servers[server].services[service].lags[lag].per95List)
                this.servers[server].services[service].lags[lag].per95List = [];

            // These values may be modified by the signal before getting pushed onto their array for aggregate calculations in the next round
            let average = parseFloat(statEntry.average);
            let per75 = parseFloat(statEntry.per75);
            let per95 = parseFloat(statEntry.per95);

            let inflAverage = average;
            let inflPer75 = per75;
            let inflPer95 = per95;

            // Do calculations first, then add current values and remove old values

            const avgList = this.servers[server].services[service].lags[lag].avgList;
            const per75List = this.servers[server].services[service].lags[lag].per75List;
            const per95List = this.servers[server].services[service].lags[lag].per95List;

            let fullStatEntry;

            // These should only be undefined after zscore stats if the entire lag period is empty, not if just the most recent avg or perxx values are undefined/null
            let averageAvg = undefined;
            let averageLB = undefined;
            let averageUB = undefined;
            let averageSignal = 0;

            let per75Avg = undefined;
            let per75LB = undefined;
            let per75UB = undefined;
            let per75Signal = 0;

            let per95Avg = undefined; 
            let per95LB = undefined;
            let per95UB = undefined;
            let per95Signal = 0;

            //TODO remove these 6 lines
            // if (avgList.length < this.lag && this.lag == 360) { 
            //     logger.info(`${server} ${service} AvgList length < ${this.lag} ::: Length: ${avgList.length}`);
            // }
            // if (per75List.length < this.lag && this.lag == 360) { 
            //     logger.info(`${server} ${service} per75List length < ${this.lag} ::: Length: ${per75List.length}`);
            // }
            // if (server == 'xcla9571' && service == 'S:getLogActivity' && this.lag == 360) {
            //     logger.info()
            // }
            //END TODO

            [ inflAverage, averageAvg, averageLB, averageUB, averageSignal ] = this.processZScoreStats(lag, threshold, influence, average, avgList);
            [ inflPer75, per75Avg, per75LB, per75UB, per75Signal ] = this.processZScoreStats(lag, threshold, influence, per75, per75List);
            [ inflPer95, per95Avg, per95LB, per95UB, per95Signal ] = this.processZScoreStats(lag, threshold, influence, per95, per95List);

            // if (server == 'xcla9571' && (service == 'S:getLogActivity' || service == 'getSalesServiceOffersFromDBAdvAction') && this.lag == 360) {
            //     logger.info(`service:${service} | ts:${statEntry.timestamp} - average:${average} - inflAverage:${inflAverage} - averageAvg:${averageAvg} - averageLB:${averageLB} - averageUB:${averageUB} - averageSignal:${averageSignal}`);
            // }

            // Remove old values if we are at the max save-intervals (LAG)
            if (avgList.length >= lag) {
                // [ inflAverage, averageAvg, averageLB, averageUB, averageSignal ] = this.processZScoreStats(average, avgList);
                this.servers[server].services[service].lags[lag].avgList.shift();
            }
            if (per75List.length >= lag) {
                // [ inflPer75, per75Avg, per75LB, per75UB, per75Signal ] = this.processZScoreStats(per75, per75List);
                this.servers[server].services[service].lags[lag].per75List.shift();
            }
            if (per95List.length >= lag) {
                // [ inflPer95, per95Avg, per95LB, per95UB, per95Signal ] = this.processZScoreStats(per95, per95List);
                this.servers[server].services[service].lags[lag].per95List.shift();
            }

            fullStatEntry = new FullStatEntry(statEntry.timestamp, statEntry.server, statEntry.service, statEntry.tpm, lag, statEntry.average, averageAvg, averageLB, averageUB, averageSignal, statEntry.per75, per75Avg, per75LB, per75UB, per75Signal, statEntry.per95, per95Avg, per95LB, per95UB, per95Signal);

            fsReturnArray.push(fullStatEntry);
            // }

            // Add new (influenced) data to lists
            this.servers[server].services[service].lags[lag].avgList.push(inflAverage);
            this.servers[server].services[service].lags[lag].per75List.push(inflPer75);
            this.servers[server].services[service].lags[lag].per95List.push(inflPer95);

        });

        return fsReturnArray;
	}
}

// async function writeStringToQueue(channel, queue, string) {
// 	if (queueFull) {
// 		buffer.push(string);
// 		return false;
// 	} else {
// 		const hasRoom = channel.sendToQueue(queue, Buffer.from(string, 'utf8'));
// 		if (!hasRoom) {
// 			queueFull = true;
// 			buffer.push(string);
// 			logger.info(`--- QUEUE BUFFER FULL --- Cancelling consume until drain event`);
// 			try {
//                 await stopConsume();
// 				// await channel.cancel();
// 			} catch (err) {
// 				logger.error(`stopConsume()) threw an error: ${err}`);
// 			}
// 			return false;
// 		} else {
// 			queueStats.incrMsgOutCounter();
//         }
        
// 		return true;
// 	}
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
        APMCONFIG = readAPMConfig();
        ZSCORECONFIG = APMCONFIG.streamCalcZScore;
        await setGlobalLogger(APMCONFIG.logDir, ZSCORECONFIG.logFilePrefix); // This sets global.logger for use here and in modules

        // queueStats.logQueueStatsRecurs(APMCONFIG.statLogIntervalInSeconds);
        const qm = new QueueManager(APMCONFIG.amqpConnectionString, APMCONFIG.statLogIntervalInSeconds);

        const zscore = new ZScoreParser();
        zscore.resumeFromFileIfExists(ZSCORECONFIG.resumeFileFullPath);

        watchAPMConfig(
            APMCONFIG, 
            async (newAPMCONFIG) => { 
                APMCONFIG = newAPMCONFIG; 
                ZSCORECONFIG = APMCONFIG.streamCalcZScore;
                await setGlobalLogger(APMCONFIG.logDir, ZSCORECONFIG.logFilePrefix); // This sets global.logger for use here and in modules
                // queueStats.setInterval(APMCONFIG.statLogIntervalInSeconds);
                qm.setInterval(APMCONFIG.statLogIntervalInSeconds);
                zscore.updateAllServiceSettings();
                zscore.removeStaleLagData();
                if (!ZSCORECONFIG.consumeQueue && isConsuming) {
                    logger.info(`Stopping consume from watcher!`);
                    stopConsume(); // Might need await
                }
                if (ZSCORECONFIG.consumeQueue && !isConsuming) {
                    logger.info(`Starting consume from watcher!`);
                    startConsume();
                }
            },
            [ 'apmConfigFilePath', 'amqpConnectionString', 'streamCalcZScore.inQueue', 'streamCalcZScore.outQueue' ]
        );

        // Connect to local rabbitmq queue to stream in data
        // const connection = await amqp.connect(APMCONFIG.amqpConnectionString);

        // const inQueue = ZSCORECONFIG.inQueue;
        // const outQueue = ZSCORECONFIG.outQueue;

        const inQueue = await qm.getQueue(ZSCORECONFIG.inQueue, 'c', consumeMsg);
        const outQueue = await qm.getQueue(ZSCORECONFIG.outQueue, 'p');

        qm.on('pause', () => {
            stopConsume();
        });
        
        qm.on('resume', () => {
            startConsume();
        });

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
            zscore.saveToResumeFile(ZSCORECONFIG.resumeFileFullPath, false);
            try {
                await qm.shutdown();
            } catch (err) {
                logger.error(`qm.shutdown() error: ${err}`);
            }
            // try {
            //     await inChannel.close();
            // } catch (err) {
            //     logger.error(`inChannel.close() error: ${err}`);
            // }
            // try {
            //     await outChannel.close();
            // } catch (err) {
            //     logger.error(`outChannel.close() error: ${err}`);
            // }
            // try {
            //     await connection.close();
            // } catch (err) {
            //     logger.error(`connection.close() error: ${err}`);
            // }
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
            zscore.saveToResumeFile(ZSCORECONFIG.resumeFileFullPath, true)
        }, ZSCORECONFIG.resumeFileSaveFrequencyInSeconds * 1000);

        const entryFactory = new EntryFactory();

        function consumeMsg(msg) {
            // queueStats.incrMsgInCounter();
            // inChannel.ack(msg);
            const entry = entryFactory.getEntryFromCSV(msg.content.toString());
            // if (entry.type === 'tx') {
                // Pass tx data through with no changes for now
                // writeStringToQueue(outChannel, outQueue, msg.content.toString());
            if (entry.type === 'st') {
                // Process z-score algorithm here
                const fsEntries = zscore.processData(entry);
                // fsEntries.forEach(fsEntry => writeStringToQueue(outChannel, outQueue, fsEntry.toCSVString()));
                fsEntries.forEach(fsEntry => outQueue.writeLineToQueue(fsEntry.toCSVString(), ZSCORECONFIG.verboseQueueWrite));
            }
        }

        // outChannel.on('drain', () => {
		// 	queueFull = false;
		// 	logger.info(`+++ DRAIN EVENT +++ Resuming consume. Attempting to enqueue ${buffer.length} records from saved buffer first.`);
		// 	if (buffer.length > 0) {
		// 		const tmpBuffer = buffer; // To prevent writeStringToQueue() from concurrently adding to it while we call .map
		// 		buffer = []; // Reset buffer since the forEach below can add to buffer if they start failing to enqueue again
		// 		tmpBuffer.forEach(el =>	writeStringToQueue(outChannel, outQueue, el));
		// 	}
		// 	// The queue can be full again here if the buffer gets large and itself fills up the queue's buffer
		// 	startConsume();
        // });
        
        // async function writeStringToQueue(channel, queue, string) {
        //     if (ZSCORECONFIG.verboseQueueWrite) logger.info(`QUEUE: ${string}`);
        //     if (queueFull) {
        //         buffer.push(string);
        //         return false;
        //     } else {
        //         const hasRoom = channel.sendToQueue(queue, Buffer.from(string, 'utf8'));
        //         if (!hasRoom) {
        //             queueFull = true;
        //             buffer.push(string);
        //             logger.info(`--- QUEUE BUFFER FULL --- Cancelling consume until drain event`);
        //             try {
        //                 await stopConsume();
        //                 // await channel.cancel();
        //             } catch (err) {
        //                 logger.error(`stopConsume() threw an error: ${err}`);
        //             }
        //             return false;
        //         } else {
        //             queueStats.incrMsgOutCounter();
        //         }
        //         return true;
        //     }
        // }

        // const consumerTag = 'xConsumerTagx';
        // let isConsuming = false;
        // function startConsume() {
        //     // try {
        //     if (!isConsuming) {
        //         isConsuming = true;
        //         inChannel.consume(
        //             inQueue,
        //             consumeMsg,
        //             { consumerTag: consumerTag}
        //         );
        //     }
            // } catch (err) {
            //     logger.error(`Could not start consume!: ${err}`);
            // }
        // }
        // async function stopConsume() {
        //     isConsuming = false;
        //     try {
        //         await inChannel.cancel(consumerTag);
        //     } catch (err) {
        //         logger.error(`inChannel.cancel() threw an error: ${err}`);
        //     }
        // }

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

        if (ZSCORECONFIG.consumeQueue) startConsume();

    } catch (error) {
        logger.error(`Caught error: ${error}\n${new Error().stack}`);
    }
})();