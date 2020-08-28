#!/usr/bin/env node
const { execSync } = require('child_process');

const { QueueManager } = require('./queue.js');
const { JmxEntry } = require('./entries.js');
const UtilMethods = require('./util_methods.js')();

// START GLOBALS ///////////////////////////////////
let APMCONFIG;
let PULLJVMCONFIG;
let paused = false;
let dbQueue;
//  END  GLOBALS ///////////////////////////////////

function cliToJSON(resources, output) {
    // Create shallow copy of array so we can shift without affecting the original array
    const resCopy = resources.slice();
    const fOutput = `${output}`.replace(/\n}\n{/g, '\n},\n{');
    const arr = fOutput.split('\n');
    nArr = arr.map(line => {
        if (line.match(/^[a-zA-Z]/)) {
            // Discard warning messages
            return;
        } else if (line.match(/^{/)) {
            return `"${resCopy.shift()}" : {`
        } else {
            return line;
        }
    });

    // Add extra braces around the whole thing for proper json format
    return JSON.parse(`{${nArr.join('\n')}}`);
}

function pullJvmStats(jvmHost, statNameList, cmdList) {

    try {
        const cliCmd = `java -jar ${PULLJVMCONFIG.clientJarFullPath} --output-json --timeout=${PULLJVMCONFIG.clientTimeoutMs} --controller=${jvmHost}:${PULLJVMCONFIG.jmxPort} --user=${PULLJVMCONFIG.adminUser} --password=${PULLJVMCONFIG.adminPass} --connect commands="${cmdList}"`;

        // logger.info(cliCmd);

        // Ignore standard error
        const rawOutput = execSync(cliCmd, {stdio: ['pipe','pipe','ignore']});
        // logger.error(`${rawOutput}`);

        // const stats = cliToJSON(['ds', 'heap', 'meta'], rawOutput);
        const stats = cliToJSON(statNameList, rawOutput);
        stats.server = jvmHost;
        // logger.warn("++++++++++++++++++++++++++++");
        // logger.info(JSON.stringify(stats, undefined, 2));    
        // logger.warn("----------------------------");
        return stats;
    } catch (err) {
        // logger.error(`Error connecting to remote WildFly client: ${err}`);
        return;
    }
}

function pullAllJvmStats(ts) {
    
    let statNameList = [];
    let cmdList;
    for (const [ statName, statCmd ] of Object.entries(PULLJVMCONFIG.statCmdMap)) {
        statNameList.push(statName);
        cmdList = cmdList ? `${cmdList},${statCmd}` : statCmd;
    }

    // logger.info(`statNameList: ${statNameList}`);
    // logger.info(`cmdList: ${cmdList}`);

    const statList = [];
    PULLJVMCONFIG.jvmHosts.forEach(jvmHost => {
        const statObj = pullJvmStats(jvmHost, statNameList, cmdList);
        if (statObj) statList.push(statObj);
    });
    statList.forEach(stats => {
        // logger.info(`${ts} ::: ${stats.server} => Datasource ${stats.ds.result.InUseCount} / ${stats.ds.result.AvailableCount} nodes used`);
        // TODO
        const jmxEntry = new JmxEntry(ts, PULLJVMCONFIG.shortenHostname ? stats.server.replace(/\..*/,'') : stats.server, stats);
        // logger.error(jmxEntry.toCSVString());
        // When writing to queue, check the hostname shorten variable
        dbQueue.writeLineToQueue(jmxEntry.toCSVString(), PULLJVMCONFIG.verboseQueueWrite);
    });
}

(async () => {

    try {
        APMCONFIG = readAPMConfig();
        PULLJVMCONFIG = APMCONFIG.pullJvmStats;
        await setGlobalLogger(APMCONFIG.logDir, PULLJVMCONFIG.logFilePrefix); // This sets global.logger for use here and in modules

        const qm = new QueueManager(APMCONFIG.amqpConnectionString, APMCONFIG.statLogIntervalInSeconds);

        watchAPMConfig(
            APMCONFIG, 
            async (newAPMCONFIG) => {
                APMCONFIG = newAPMCONFIG;
                PULLJVMCONFIG = APMCONFIG.pullJvmStats;
                await setGlobalLogger(APMCONFIG.logDir, PULLJVMCONFIG.logFilePrefix); // This sets global.logger for use here and in modules
                qm.setInterval(APMCONFIG.statLogIntervalInSeconds);
            },
            [ 'apmConfigFilePath', 'amqpConnectionString', 'dbInsertQueue' ]
        );

        dbQueue = await qm.getQueue(APMCONFIG.dbInsertQueue, 'p');

        let timeoutHandler;

        async function exit(rc = 0) {
            if (timeoutHandler) {
                clearTimeout(timeoutHandler);
            }
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
        
        function pullAllJvmStatsRecurs(notFirstTime) {
            let now = new Date();
            let ts = now.getTime();     
            if (notFirstTime) pullAllJvmStats(ts);
            let currentSec = new Date().getSeconds();
            const timeoutSec = PULLJVMCONFIG.pollingIntervalSeconds - (currentSec % PULLJVMCONFIG.pollingIntervalSeconds);    
            timeoutHandler = setTimeout(pullAllJvmStatsRecurs.bind(this, true), timeoutSec * 1000); // Try to start it on the :00 second of every minute
        }
        pullAllJvmStatsRecurs();

    } catch (error) {
        logger.error(`Caught error: ${error}\n${new Error().stack}`);
    }
})();



