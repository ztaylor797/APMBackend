#!/usr/bin/env node

// let log; // Rolling file logger

const amqp = require('amqplib');
const fs = require("fs");
const md5 = require('md5');
const sqlite3 = require('sqlite3').verbose();
const EventEmitter = require('events');
const { PerformanceObserver, performance } = require('perf_hooks');
const Path = require('path'); 

const https = require('https');
const axios = require('axios');
var stringify = require('json-stringify-safe');

const heapdump = require('heapdump');
// let path = require('path');
// let nodeOomHeapdump = require('node-oom-heapdump')({
//     path: Path.resolve((__filename.split('.').slice(0, -1)).join('.')),
//     heapdumpOnOOM: true,
// 	addTimestamp: true
// });

const { QueueManager } = require('./queue.js');
let UtilMethods = require('./util_methods.js')(); // Imports a bunch of methods into this namespace and on certain prototypes
const { EntryFactory, AlertEntry } = require('./entries.js');

const instance = axios.create({
    timeout: 1000,
    httpsAgent: new https.Agent({
        rejectUnauthorized: false // Ignore self-signed certificate error
    })
});

// START GLOBALS ///////////////////////////////////
let APMCONFIG;
let ALERTSCONFIG;

let isConsuming = false;

// let queueFull = false;
// let buffer = [];

// const queueStats = new QueueStats(true, false);
//  END  GLOBALS ///////////////////////////////////

class MyEmitter extends EventEmitter {}

function sendAlertEmail(subj, html, imagePath) {
    sendEmail(ALERTSCONFIG.fromEmail, ALERTSCONFIG.emailList, subj, html, imagePath);
}

function sendTestEmail(subj, html, imagePath) {
    sendEmail(ALERTSCONFIG.fromEmail, ALERTSCONFIG.testEmailList, subj, html, imagePath);
}

// Returns a Path on successful download
async function renderGraph(renderURL) {
    logger.info(`Rendering graph...`);
    try {

        const imagePath = Path.resolve(APMCONFIG.grafana.renderDir, `alert_${new Date().toISOString()}.png`);
        const writer = fs.createWriteStream(imagePath);

        // const response = await instance.get(renderURL, config);
        const response = await instance({
            headers: { Authorization: APMCONFIG.grafana.bearerToken },
            url: renderURL,
            method: 'GET',
            responseType: 'stream',
            timeout: APMCONFIG.grafana.renderTimeout
        });

        response.data.pipe(writer);

        return new Promise((resolve, reject) => {
            writer.on('finish', resolve(imagePath));
            writer.on('error', reject());
        });                

    } catch (error) {
        logger.error(`Error rendering graph! ${stringify(error, undefined, 2)}`);
    };
}

let alertsTimeoutHandle;

class AlertsManager { 
    constructor(alerts, alertBuffer) {
        this.entryFactory = new EntryFactory();
        if (arguments.length === 1)
            this.setProperties(alerts, []);
        else if (arguments.length === 2)
            this.setProperties(alerts, alertBuffer);
        else
            this.setProperties({}, []);
    }

    setProperties(alerts = {}, alertBuffer = []) {
        // if (!alerts) alerts = {};
        // if (!alertBuffer) alertBuffer = [];

        this.alerts = alerts;
        this.alertBuffer = alertBuffer;

        this.recentAlertCounts = {};
        // this.recentAlertCount = 0;
    }

    saveToResumeFile(resumeFile, quiet) {
		if (!quiet) logger.info(`Saving data to resume file: ${resumeFile}`);

		const json = JSON.stringify(this, undefined, 2);

        try {
        fs.writeFileSync(resumeFile, json);
        } catch (e) {
            logger.error(e);
        }

		if (!quiet) logger.info(`Resume file has been saved: ${resumeFile}`);
	}

    resumeFromFileIfExists(resumeFile) {
        // Check if the file exists in the directory, and if it is writable.
        try {
		    fs.accessSync(resumeFile, fs.constants.F_OK | fs.constants.W_OK);

            logger.info(`Resume file found! Resuming data from file: ${resumeFile}`);
            var content = fs.readFileSync(resumeFile);
            try {
                var jsonContent = JSON.parse(content);
                this.setProperties(jsonContent.alerts, jsonContent.alertBuffer);
            } catch (e) {
                logger.error(`Could not parse JSON content from resume file: ${resumeFile}`);
            }	
        } catch (err) {
            logger.warn(`Resume file does not exist or is not writeable, will not resume data: ${resumeFile}`);
        }
		
    }
    
    addToAlertBuffer(sqliteObj) {
        this.alertBuffer.push(sqliteObj);
    }

    // Should be called once at the beginning of the script
    startAlertSender() {
        setTimeout(this.sendAlertsRecurse.bind(this), ALERTSCONFIG.alertCollectionIntervalInSeconds * 1000);
    }

    generateGrafanaURLParams() {
        const servers = [];
        const services = [];
        const lags = [];
        this.alertBuffer.forEach(el => {
            const entry = this.entryFactory.getEntryFromCSV(el.entry, '&');
            if (!servers.includes(entry.server)) servers.push(entry.server);
            if (!services.includes(entry.service)) services.push(entry.service);
            if (!lags.includes(entry.lag)) lags.push(entry.lag);
        });

        const firstTs = this.entryFactory.getEntryFromCSV(this.alertBuffer[0].entry, '&').timestamp;
        const lastTs = this.entryFactory.getEntryFromCSV(this.alertBuffer[this.alertBuffer.length - 1].entry, '&').timestamp;

        const nowMs = new Date().getTime();

        // Keep in mind we can have several alerts on one email spanning potentially maxCollectionIntervalInSeconds + a bit extra
        let from, to;

        // Set "from" timestamp to first alert timestamp - 5 minutes
        from = firstTs - 300000;

        // Set "to" timestamp to last alert timestamp + 5 minutes
        to = lastTs + 300000

        // If the "to" timestamp is within the last 90 seconds (or the future), set it to the last 90 seconds (built in delay of data getting into grafana)
        if (nowMs - to <= APMCONFIG.grafana.grafanaNowDelayIntervalMs) {
            to = nowMs - APMCONFIG.grafana.grafanaNowDelayIntervalMs;
        }

        let params = `from=${from}&to=${to}`;

        servers.forEach(server => params += `&var-server=${server}`);
        services.forEach(service => params += `&var-service=${service}`);
        lags.forEach(lag => params += `&var-lag=${lag}`);

        // First set is for zscore graphs, the + services.length is for the transaction graph at the beginning of each service block
        const heightFactor = servers.length * services.length * lags.length + services.length;

        return { params, heightFactor };
    }

    generateGrafanaURL() {
        const { params, heightFactor } = this.generateGrafanaURLParams();
        const URL = `${APMCONFIG.grafana.grafanaURL}${APMCONFIG.grafana.alertInspectorRelativeURL}?${params}`;

        // 100 pixels for header
        const renderHeight = 100 + APMCONFIG.grafana.renderHeightMultiple * heightFactor;

        const extraRenderParams = `&width=${APMCONFIG.grafana.renderWidth}&height=${renderHeight}${APMCONFIG.grafana.renderExtraParams}`;
        const renderURL = `${APMCONFIG.grafana.grafanaURL}/render${APMCONFIG.grafana.alertInspectorRelativeURL}?${params}${extraRenderParams}`;

        return { URL, renderURL };
    }

    formatAlertsHTML() {
        const css = `<style type="text/css" media="all">`
        + ` table { border-collapse: collapse; }`
        + ` td { font-family: "Calibri"; font-size: 11pt; white-space: nowrap; }`
        + ` td, th { padding: 7px; }`
        + ` td.bb, th.bb { border-bottom: 2px solid black }`
        + ` td.center { text-align: center; }`
        + ` td.right { text-align: right; }`
        + ` td.bbcenter { border-bottom: 2px solid black; text-align: center; }  </style>`; // Outlook doesn't like multiple classes on a single element... hence this

        // const tdWidth = "750px";
        const deepBlue = "#1ab2ff";
        const medBlue = "#94DBFF";
        const lightBlue = "#e5f8ff";

        // let html = "";
        let tableHeader = `<table><tr bgcolor="${deepBlue}">`
            + `<th>Server</th>`
            + `<th>Service</th>`
            + `<th>Timestamp</th>`
            + `<th>Lag</th>`
            + `<th>Cause</th>`
            + `</tr>`
            + `<tr bgcolor="${medBlue}">`
            + `<th class="bb">TPM</th>`
            + `<th class="bb">Avg</th>`
            + `<th class="bb">Avg UB</th>`
            + `<th class="bb">75%</th>`
            + `<th class="bb">75% UB</th>`
            + `</tr>`;

        const tableFooter = "</table>";

        function formatDate(msNumber) {
            return new Date(msNumber).convertDateToLogDate();
        }

        let tableRows = [];
        this.alertBuffer.forEach(el => {
            const entry = this.entryFactory.getEntryFromCSV(el.entry, '&');
            const rowX2 = `<tr bgcolor="white">`
            + `<td>${entry.server}</td>`
            + `<td>${entry.service}</td>`
            + `<td>${formatDate(entry.timestamp)}</td>`
            + `<td class="center">${entry.lag}</td>`
            + `<td>${el.cause}</td>`
            + `</tr>`
            + `<tr bgcolor="${lightBlue}">`
            + `<td class="bbcenter">${entry.tpm.toFixed(1)}</td>`
            + `<td class="bbcenter">${entry.average.toFixed(1)}</td>`
            + `<td class="bbcenter">${entry.averageUB.toFixed(1)}</td>`
            + `<td class="bbcenter">${entry.per75.toFixed(1)}</td>`
            + `<td class="bbcenter">${entry.per75UB.toFixed(1)}</td>`
            + `</tr>`;
            tableRows.push(rowX2);
        });

        const html = `${css}${tableHeader}${tableRows.join('')}${tableFooter}`;
        return html;
    }

    async sendAlertsRecurse(intervalInSeconds = ALERTSCONFIG.alertCollectionIntervalInSeconds, exiting) {

        let intervalOpt = undefined;

        if (this.alertBuffer.length > 0 && ALERTSCONFIG.emailsEnabled) {
            let emailBody = "";

            emailBody += this.formatAlertsHTML();

            // emailBody += `\n\n${this.generateGrafanaURL()}`;
            
            ////// TODO remove this block
            // emailBody += "\n\n";
            // this.alertBuffer.forEach(el => {
            //     emailBody += `Alert: ${JSON.stringify(el, undefined, 2)}\n`;
            // });
            //////////

            // logger.info(`--- EMAIL BODY ---\n${emailBody}---  END  BODY ---`);

            if (ALERTSCONFIG.increaseCollectionIntervalAfterAlert) {
                if (intervalInSeconds < ALERTSCONFIG.maxCollectionIntervalInSeconds) {
                    intervalInSeconds = intervalInSeconds * 2;
                    logger.info(`Increasing alert collection interval to ${intervalInSeconds} seconds.`); 
                }
            }

            const windowLengthSeconds = APMCONFIG.streamCalcStats.intervalLengthInSeconds * APMCONFIG.streamCalcStats.windowSizeInIntervals;
            const windowMinutes = Math.floor(windowLengthSeconds / 60);
            const tpmExample = 1 / windowMinutes;

            const legend = `<b>Avg</b>: ${windowLengthSeconds} second rolling average of elapsed transaction times.`
            + `\n<b>Avg UB</b>: Average upper bound. Determined from the Lag value. A Lag of 360 means the upper bound is generated from a one hour period of data.`
            + `\n\n<b>75%</b>: ${windowLengthSeconds} second rolling 75th percentile of elapsed transaction times.`
            + `\n<b>75% UB</b>: 75th percentile upper bound. Determined from the Lag value. A Lag of 360 means the upper bound is generated from a one hour period of data.`
            + `\n\n<b>Lag</b>: Number of intervals (interval = ${APMCONFIG.streamCalcStats.intervalLengthInSeconds} seconds) over which the z-score algorithm is applied. The z-score determines the upper and lower bounds outside of which an alert is triggered.`
            + `\n<b>TPM</b>: Transactions per minute. Note this value is calculated over a ${windowLengthSeconds} second interval so a single transaction in the window will show a value of ${tpmExample} TPM.`;

            const { URL, renderURL } = this.generateGrafanaURL();
            const grafanaURL = URL;
            const lhGrafanaURL = grafanaURL.replace(APMCONFIG.grafana.grafanaHostname, 'localhost');

            emailBody += `<pre>\n\n<a href="${lhGrafanaURL}">(Citi) View Alert Graphs</a> - <i>Requires tunnel</i>\n<a href="${grafanaURL}">(Acxiom) View Alert Graphs</a>\n\nCooldown until further alerts are sent out: ${(intervalInSeconds/60).toFixed(0)} minutes\n\n${legend}</pre>`;

            // if (ALERTSCONFIG.emailsEnabled)
            // sendAlertEmail(`APM Alerts Triggered!`, `${emailBody}`);

            // TESTING
            try {
                const imagePath = await renderGraph(renderURL);
                sendAlertEmail(`APM Alerts Triggered!`, `${emailBody}`, imagePath);
            } catch (err) {
                logger.error(`Error while trying to render graph`);
                logger.error(err);
                sendTestEmail('APM Alerts Triggered!', `${emailBody}`);
            }
            // END TESTING

            this.alertBuffer = [];
            intervalOpt = intervalInSeconds;
        }

        if (!exiting)
            alertsTimeoutHandle = setTimeout(this.sendAlertsRecurse.bind(this, intervalOpt), intervalInSeconds * 1000);
    }

    getServiceSettingsFromConfig(service) {
        // "overrides": { // These LAG values MUST match a LAG value in the defaults section
        //     "services": { 
        //         "Provider:cb-util-comm-provider": {
        //                 "hardMaxMsAlertThreshold":
        let serviceOverrides = null;
        if (ALERTSCONFIG.overrides.services[service]) {
            serviceOverrides = ALERTSCONFIG.overrides.services[service];
        }

        return serviceOverrides;
    }
    
    processFSEntry(en) {
        let triggerAlert = false;
        // let shouldIncrRecentCounter = false;
        let incremented = false;
        const causes = [];

        let returnObj = undefined;

        const serviceOverrides = this.getServiceSettingsFromConfig(en.service);

        if (!this.recentAlertCounts) this.recentAlertCounts = {};
        if (!this.recentAlertCounts[en.server]) this.recentAlertCounts[en.server] = {};
        if (!this.recentAlertCounts[en.server][`${en.service}`]) this.recentAlertCounts[en.server][`${en.service}`] = {};

        if (!this.recentAlertCounts[en.server][`${en.service}`][en.lag]) this.recentAlertCounts[en.server][`${en.service}`][en.lag] = 0;
        // else (this.recentAlertCounts[en.server][`${en.service}`][en.lag] > 0) this.recentAlertCounts[en.server][`${en.service}`][en.lag]--;

        // const consecutiveSetting = parseInt(ALERTSCONFIG.consecutiveAlertCountRequiredToTrigger);
        const alertWindowSz = parseInt(ALERTSCONFIG.rollingAlertWindowSizeInIntervals);
        const alertIntThreshold = parseInt(ALERTSCONFIG.requiredNumberBadIntervalsInAlertWindowToTrigger);

        // START Alert method ////////////////////////////////////////////
        const alert = (alertString) => {
            // shouldIncrRecentCounter = true;
            if (!incremented) { // Only increment once even if multiple alert causes are detected for a single entry
                // Only increase the rolling total if it is < the window size, otherwise it would increase forever if we kept getting alerts
                if (this.recentAlertCounts[en.server][`${en.service}`][en.lag] <= alertWindowSz)
                    this.recentAlertCounts[en.server][`${en.service}`][en.lag]++;
                incremented = true; // But we always set the flag to true
            }

            if (alertWindowSz && alertWindowSz > 1 && alertIntThreshold && alertIntThreshold > 1) {

                if (this.recentAlertCounts[en.server][`${en.service}`][en.lag] >= alertIntThreshold) {
                    triggerAlert = true;
                    causes.push(alertString);
                } else
                    logger.warn(`Alert suppressed due to alert window threshold requirement. ${en.server} ${en.service} ${en.lag} ::: ${this.recentAlertCounts[en.server][`${en.service}`][en.lag]} bad intervals / ${alertWindowSz} total intervals. Required: ${alertIntThreshold}`);
            } else {
                triggerAlert = true;
                causes.push(alertString);
            }

        }
        // END Alert method ////////////////////////////////////////////

        // Only alert on lag values included in the config
        if (!ALERTSCONFIG.suppressedLags.includes(parseInt(en.lag))) {
            if (!ALERTSCONFIG.suppressedServices.includes(en.service)) {

                let hardMaxMsAlertThreshold = (serviceOverrides != null && serviceOverrides.hardMaxMsAlertThreshold && serviceOverrides.hardMaxMsAlertThreshold != 0) ? serviceOverrides.hardMaxMsAlertThreshold : ALERTSCONFIG.hardMaxMsAlertThreshold;
                // logger.warn(`hardMaxMsAlertThreshold: ${hardMaxMsAlertThreshold}`);

                if (en.average > hardMaxMsAlertThreshold) {
                    logger.warn(`en.average: ${en.average}   hardMaxMsAlertThreshold: ${hardMaxMsAlertThreshold}`);
                    alert('average exceeded hard ms threshold');
                }
                if (en.per75 > hardMaxMsAlertThreshold) {
                    logger.warn(`en.per75: ${en.per75}   hardMaxMsAlertThreshold: ${hardMaxMsAlertThreshold}`);
                    alert('per75 exceeded hard ms threshold');
                }

                let bothFlag = 0;
                if (en.averageSignal > 0 && en.average > ALERTSCONFIG.hardMinMsAlertThreshold && en.tpm > ALERTSCONFIG.hardMinTpmAlertThreshold) {
                    if (!ALERTSCONFIG.alertOnBothOnly)
                        alert(`average UB exceeded`);
                    else bothFlag++;
                }
                if (en.per75Signal > 0 && en.per75 > ALERTSCONFIG.hardMinMsAlertThreshold && en.tpm > ALERTSCONFIG.hardMinTpmAlertThreshold) {
                    if (!ALERTSCONFIG.alertOnBothOnly)
                        alert(`per75 UB exceeded`);
                    else bothFlag++;
                }
                if (ALERTSCONFIG.alertOnBothOnly && bothFlag >= 2) {
                    alert(`average and per75 UB exceeded`);
                }
            }
        }

        if (!incremented && this.recentAlertCounts[en.server][`${en.service}`][en.lag] > 0) {
            this.recentAlertCounts[en.server][`${en.service}`][en.lag]--;
        }

        // Just a catch to make sure it never goes below 0
        if (this.recentAlertCounts[en.server][`${en.service}`][en.lag] < 0) {
            this.recentAlertCounts[en.server][`${en.service}`][en.lag] = 0;
        }

        if (triggerAlert) {
            const newAlertTimestamp = new Date().getTime();
            // const newAlertMs = parseInt(new Date(newAlertTimestamp).getTime());

            const alert = new AlertEntry(
                newAlertTimestamp, 
                en.timestamp, 
                en.server, 
                en.service, 
                causes.join(','), 
                en.toCSVString() // The pipes in this will get converted to & by the AlertEntry constructor
            );

            if (!this.alerts[en.service]) { // If we don't have a prior alert for this service
                this.alerts[en.service] = alert;
                returnObj = alert;
            } else { // Compare timestamp from last alert to see if this one should be suppressed or not
                const lastServiceAlert = this.alerts[en.service];
                const lastAlertTimestamp = lastServiceAlert.alertTimestamp;

                // const lastAlertMs = parseInt(new Date(lastAlertTimestamp).getTime());

                const intervalSeconds = (newAlertTimestamp - lastAlertTimestamp) / 1000;
                const perServiceAlertCooldownInSeconds = ALERTSCONFIG.perServiceAlertCooldownInMinutes * 60;

                if (intervalSeconds > perServiceAlertCooldownInSeconds) {
                    this.alerts[en.service] = alert;
                    returnObj = alert;
                } else {
                    // logger.info(`Alert suppressed due to interval too short: ${intervalSeconds} seconds from ${lastAlertTimestamp} - ${newAlertTimestamp}`);
                }
            }
        }

        return returnObj;
    }

    shutdown() {
        logger.info(`Alerts shutdown method called.`);
        if (alertsTimeoutHandle) {
            logger.info(`Clearing recursive alert timeout.`);
            clearTimeout(alertsTimeoutHandle);
        } else {
            logger.info(`No handle to clear`);
        }
    }
}

// async function setUpDB(db, tableName, dbBusyTimeout) {  
//     await db.run( 'PRAGMA journal_mode = WAL;' );
//     await db.configure("busyTimeout", parseInt(dbBusyTimeout));

//     await sleep(1000);

//     await db.run(`CREATE TABLE IF NOT EXISTS ${tableName} (
//             AlertTimestamp DATETIME,
//             EntryTimestamp DATETIME,
//             Server TEXT,
//             Service TEXT,
//             Cause TEXT,
//             Entry TEXT
//         )`, err => {
//             if (err) {
//                 logger.info(`Could not create table: ${tableName}! Exiting.`);
//                 exit();
//             }
//     });

//     await sleep(1000);

//     await db.run(`CREATE INDEX IF NOT EXISTS ${tableName}_ix0 on ${tableName} (AlertTimestamp)`, err => {
//         if (err) {
//             logger.info(`Could not create index: ${tableName}_ix0! Exiting.`);
//             exit();
//         }
//     });

//     await db.run(`CREATE INDEX IF NOT EXISTS ${tableName}_ix1 on ${tableName} (EntryTimestamp)`, err => {
//         if (err) {
//             logger.info(`Could not create index: ${tableName}_ix1! Exiting.`);
//             exit();
//         }
//     });
// }

//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////
// MAIN
//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////

const args = process.argv.slice(2); // First two args are node path and this script's path, so ignore them

(async () => {

    try {
        APMCONFIG = readAPMConfig(true);
        ALERTSCONFIG = APMCONFIG.streamProcessAlerts;
        await setGlobalLogger(APMCONFIG.logDir, ALERTSCONFIG.logFilePrefix); // This sets global.logger for use here and in modules

        // queueStats.logQueueStatsRecurs(APMCONFIG.statLogIntervalInSeconds);
        const qm = new QueueManager(APMCONFIG.amqpConnectionString, APMCONFIG.statLogIntervalInSeconds);

        watchAPMConfig(
            APMCONFIG, 
            async (newAPMCONFIG) => { // Callback to update local variables on APM config file update
                APMCONFIG = newAPMCONFIG; 
                ALERTSCONFIG = APMCONFIG.streamProcessAlerts; 
                await setGlobalLogger(APMCONFIG.logDir, ALERTSCONFIG.logFilePrefix); // This sets global.logger for use here and in modules
                // queueStats.setInterval(APMCONFIG.statLogIntervalInSeconds);
                qm.setInterval(APMCONFIG.statLogIntervalInSeconds);
                if (!ALERTSCONFIG.consumeQueue && isConsuming) {
                    logger.info(`Stopping consume!`);
                    stopConsume(); // Might need await
                }
                if (ALERTSCONFIG.consumeQueue && !isConsuming) {
                    logger.info(`Starting consume!`);
                    startConsume();
                }
            }, 
            [ 'apmConfigFilePath', 'dbInsertQueue', 'amqpConnectionString', 'streamProcessAlerts.inQueue' ]
        );

        // Connect to local rabbitmq queue to stream in data
        const inQueue = await qm.getQueue(ALERTSCONFIG.inQueue, 'c', consumeMsg);
        const dbQueue = await qm.getQueue(APMCONFIG.dbInsertQueue, 'p');

        qm.on('pause', () => {
            stopConsume();
        });
        
        qm.on('resume', () => {
            startConsume();
        });

        async function exit() {
            logger.info(`exit() method entered`);
            alertsManager.shutdown();
            logger.info(`Calling sendAlertsRecurse with exiting=true`);
            await alertsManager.sendAlertsRecurse(0, true); // Send out any alerts in the alert buffer
            logger.info(`await on sendAlertsRecurse finished`);
            // saveToResumeFile(ALERTSCONFIG.bufferResumeFileFullPath, insertBuffer);
            try {
                await qm.shutdown();
            } catch (err) {
                logger.error(`qm.shutdown() error: ${err}`);
            }            
            alertsManager.saveToResumeFile(ALERTSCONFIG.alertsResumeFileFullPath, false);
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

        sendTestEmail('Test APM alert email', 'If you get this email, emails are working!');

        const alertsManager = new AlertsManager();
        alertsManager.resumeFromFileIfExists(ALERTSCONFIG.alertsResumeFileFullPath);
        alertsManager.startAlertSender();
        
		// Every minute, save the current data in case the process terminates unexpectedly (IE kill -9 instead of kill)
		setInterval(() => {
			alertsManager.saveToResumeFile(ALERTSCONFIG.alertsResumeFileFullPath, true);
        }, ALERTSCONFIG.resumeFileSaveFrequencyInSeconds * 1000);

        const entryFactory = new EntryFactory();

        const myEmitter = new MyEmitter();

        function consumeMsg(msg) {
            // queueStats.incrMsgInCounter();
            // inChannel.ack(msg);
            const entry = entryFactory.getEntryFromCSV(msg.content.toString());

            // Write it back to the db queue while we process the alerts
            dbQueue.writeLineToQueue(msg.content.toString(), ALERTSCONFIG.verboseQueueWrite);
            // writeStringToQueue(outChannel, outQueue, msg.content.toString());

            // if (entry.type === 'tx') {
                // Do nothing atm
            if (entry.type === 'fs') {
                // Process alerts here
                const alert = alertsManager.processFSEntry(entry);
                if (alert) {
                    logger.info(`Alert: ${JSON.stringify(alert, undefined, 2)}`);
                    alertsManager.addToAlertBuffer(alert); // Add to alert sender for emailing/paging out
                    dbQueue.writeLineToQueue(alert.toCSVString(), ALERTSCONFIG.verboseQueueWrite);
                    // addToInsertBuffer(alert); // Add to alert db table
                }
            } else {
                // Shouldn't be anything else on the queue
            }
        }

        // enable this to send a fake test alert on start up
        // alertsManager.addToAlertBuffer(new AlertEntry(new Date().getTime(), new Date().getTime() + 5592, 'xcla9571', 'fakeservice', 'fakecause', 'fs&1579895320000&undefined&reportAbilityToPay&6&0.00&undefined:undefined:undefined:undefined:0&undefined:undefined:undefined:undefined:0.0&undefined:undefined:undefined:undefined:0.0'));

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
                await inQueue.stopConsume();
            } catch (err) {
                logger.error(`inQueue.stopConsume() threw an error: ${err}`);
            }
        }
        
        if (ALERTSCONFIG.consumeQueue) startConsume();

    } catch (error) {
        logger.error(`Caught error: ${error}\n${new Error().stack}`);
    }
})();
