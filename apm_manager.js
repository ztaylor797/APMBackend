#!/usr/bin/env node

const { fork, execSync } = require('child_process');
const { PerformanceObserver, performance } = require('perf_hooks');
const fs = require("fs");
var ps = require('ps-node');

const https = require('https');
const axios = require('axios');
var stringify = require('json-stringify-safe');

const heapdump = require('heapdump');
let path = require('path');
let nodeOomHeapdump = require('node-oom-heapdump')({
    path: path.resolve((__filename.split('.').slice(0, -1)).join('.')),
    heapdumpOnOOM: true,
	addTimestamp: true
});

let UtilMethods = require('./util_methods.js')(); // Imports a bunch of methods into this namespace and on certain prototypes

const instance = axios.create({
    timeout: 1000,
    httpsAgent: new https.Agent({
        rejectUnauthorized: false // Ignore self-signed certificate error
    })
});

// START GLOBALS ///////////////////////////////////
let APMCONFIG;
let MANAGERCONFIG;

let alertsManager;

let modules;
//  END  GLOBALS ///////////////////////////////////

function sendManagerEmail(subj, html) {
    sendEmail(MANAGERCONFIG.fromEmail, MANAGERCONFIG.emailList, subj, html);
}

class AlertsManager { 
    constructor(alerts, alertBuffer) {
        if (arguments.length === 1)
            this.setProperties(alerts, []);
        else if (arguments.length === 2)
            this.setProperties(alerts, alertBuffer);
        else
            this.setProperties({}, []);
    }

    setProperties(alerts, alertBuffer) {
        if (!alerts) alerts = {};
        if (!alertBuffer) alertBuffer = [];

        this.alerts = alerts;
        this.alertBuffer = alertBuffer;
    }

    // saveToResumeFile(resumeFile, quiet) {
	// 	if (!quiet) logger.info(`Saving data to resume file: ${resumeFile}`);

	// 	const json = JSON.stringify(this, undefined, 2);

    //     try {
    //     fs.writeFileSync(resumeFile, json);
    //     } catch (e) {
    //         logger.error(e);
    //     }

	// 	if (!quiet) logger.info(`Resume file has been saved: ${resumeFile}`);
	// }

    // resumeFromFileIfExists(resumeFile) {
    //     // Check if the file exists in the directory, and if it is writable.
    //     try {
	// 	    fs.accessSync(resumeFile, fs.constants.F_OK | fs.constants.W_OK);

    //         logger.info(`Resume file found! Resuming data from file: ${resumeFile}`);
    //         var content = fs.readFileSync(resumeFile);
    //         try {
    //             var jsonContent = JSON.parse(content);
    //             this.setProperties(jsonContent.alerts, jsonContent.alertBuffer);
    //         } catch (e) {
    //             logger.error(`Could not parse JSON content from resume file: ${resumeFile}`);
    //         }	
    //     } catch (err) {
    //         logger.warn(`Resume file does not exist or is not writeable, will not resume data: ${resumeFile}`);
    //     }
		
    // }
    
    addToAlertBuffer(string) {
        this.alertBuffer.push(`${new Date().convertDateToLogDate()} ::: ${string}`);
    }

    // Should be called once at the beginning of the script
    startAlertSender() {
        setTimeout(this.sendAlertsRecurse.bind(this), MANAGERCONFIG.alertCollectionIntervalInSeconds * 1000);
    }

    sendAlertsRecurse(intervalInSeconds = MANAGERCONFIG.alertCollectionIntervalInSeconds, exiting) {

        let intervalOpt = undefined;

        if (this.alertBuffer.length > 0) {
            let emailBody = "";
            this.alertBuffer.forEach(el => {
                emailBody += `Alert: ${JSON.stringify(el, undefined, 2)}\n`;
            });
            // logger.info(`--- EMAIL BODY ---\n${emailBody}---  END  BODY ---`);

            if (MANAGERCONFIG.increaseCollectionIntervalAfterAlert) {
                if (intervalInSeconds < MANAGERCONFIG.minCollectionIntervalInSeconds) {
                    intervalInSeconds = intervalInSeconds * 2;
                    logger.info(`Increasing alert collection interval to ${intervalInSeconds} seconds.`); 
                }
            }

            emailBody += `\n\nCooldown until further alerts are sent: ${intervalInSeconds} seconds\n`;

            if (MANAGERCONFIG.emailsEnabled)
                sendManagerEmail(`APM Manager Alerts`, `<pre>${emailBody}</pre>`);

            this.alertBuffer = [];
            intervalOpt = intervalInSeconds;
        }

        if (!exiting)
            setTimeout(this.sendAlertsRecurse.bind(this, intervalOpt), intervalInSeconds * 1000);
    }
}

function startRabbitMQ() {
    logger.info(`Attempting to start RabbitMQ...`);
    try {
        const server = path.join(MANAGERCONFIG.rabbitSbinPath, 'rabbitmq-server');
        let output = execSync(`${server} -detached`);
        logger.info(`RabbitMQ started! Output: ${output}`)
    } catch (err) {
        logger.error(`Start of RabbitMQ threw an error: ${err}`);
        sendManagerEmail(`APM Manager Alerts`, `<pre>Start of RabbitMQ threw an error: ${err}</pre>`);
    }
}

function rabbitMQIsRunning() {
    try {
        const ctl = path.join(MANAGERCONFIG.rabbitSbinPath, 'rabbitmqctl');
        let output = execSync(`${ctl} status`);
    } catch (err) {
        logger.warn(`RabbitMQ does not appear to be running: ${err}`);
        return false;
    }
    return true;
}

function getRabbitDataDirectory() {
    try {
        const ctl = path.join(MANAGERCONFIG.rabbitSbinPath, `rabbitmqctl`);
        let output = execSync(`${ctl} eval 'rabbit_mnesia:dir().'`);
    } catch (err) {
        logger.warn(`Could not retrieve persistent data dir from RabbitMQ: ${err}`);
        return undefined;
    }
    return output.replace(/\"/g,'');
}

function lookupPids() {
    const output = execSync(MANAGERCONFIG.pidListCommand);
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

function lookupPidsByRelativeScriptPath(relativePath) {
    const resultList = lookupPids();
    return resultList.filter(el => {
        // Only return records whose command contains 'node' and arguments match a regex of the relativePath string
        if (el.command.match(/node/) && el.arguments.filter(arg => arg.match(new RegExp(relativePath))).length > 0) {
            return el;
        }
    })
}

// async function lookupPidsByRelativeScriptPath(relativePath) {
//     return new Promise((resolve, reject) => {
//         ps.lookup({
//             command: 'node',
//             arguments: new RegExp(relativePath),
//         }, (err, resultList) => {

//             // logger.info(`${relativePath} -> err: ${err}`);
//             // logger.info(`${relativePath} -> resultList: ${resultList}`);

//             if (err !== null) reject(err);
//             else resolve(resultList);
//         });
//     });
// }

async function killPid(pid) {
    return new Promise((resolve, reject) => {
        logger.warn(`Killing PID: ${pid}`);
        ps.kill(pid.toString(), 'SIGTERM', (err) => {
            if (err) reject(err);
            else resolve(pid);
        });
    });
}

async function sendAnnotation(text, tags) {
    const config = {
        headers: { Authorization: APMCONFIG.grafana.bearerToken }
    };
    
    const now = new Date().getTime();
    const bodyParameters = {
        time: now,
        timeEnd: now,
        text,
        tags
    }
    
    logger.info(`Submitting annotation...`);
    try {
        const response = await instance.post(`${APMCONFIG.grafana.grafanaURL}/api/annotations`, bodyParameters, config);
        logger.info(`Annotation submitted: ${stringify(response.data, undefined, 2)}`);
    } catch (error) {
        logger.error(`Annotation submission failure! ${stringify(error, undefined, 2)}`);
    };
}

class Module {
    constructor(appDirectory, sharedNodeOpts, moduleSettingEl) {
        if (!appDirectory)
            logger.error(`Module constructor: appDirectory must be passed!`);

        if (!moduleSettingEl.relativePath)
            logger.error(`Module constructor: relativePath must be defined!`);
        
        this.appDirectory = appDirectory;
        if (sharedNodeOpts) {
            // The JSON is to deep copy sharedNodeOpts since that array is passed by reference to this constructor
            this.opts = JSON.parse(JSON.stringify(sharedNodeOpts));
        } else {
            this.opts = [];
        }
        this.relativePath = moduleSettingEl.relativePath;

        if (moduleSettingEl.heapInspectPort) {
            this.heapInspectPort = moduleSettingEl.heapInspectPort;
            this.heapInspectOpt = `--inspect=${this.heapInspectPort}`;
            this.opts.push(this.heapInspectOpt);
        }

        // this.pid = undefined;

        logger.info(`New module created:\n${this.pprint()}`);
    }

    async killExistingPIDs() {
        logger.info(`Killing any PIDs found for ${this.relativePath}`);
        try {
            const resultList = await lookupPidsByRelativeScriptPath(this.relativePath);

            logger.info(`${this.relativePath} PID count: ${resultList.length}`);

            if (resultList.length > 0) {
                for await (const el of resultList) {
                    try {
                        const pid = await killPid(el.pid);
                        logger.warn(`Process PID: ${pid} has been killed intentionally: ${el.pprint()}`);
                    } catch (err) {
                        logger.error(`Could not kill pid: ${el.pid} Error: ${err}`);
                    }
                }
            }

        } catch (err) {
            throw new Error( err );
        }
    }

    childErrorCB(err) {
        logger.error(`Child errored: ${err}`);
        // Do something, alert and restart?
        sendManagerEmail(`APM manager error`, `Child module error  module: ${this.relativePath} : ${err}`)
    }

    async childExitCB(code, signal) {
        logger.error(`Child exited:  code:${code}  signal: ${signal}`);
        const now = new Date().getTime();

        sendAnnotation(`Module exited: ${this.relativePath}`, [ "maintenance" ]);
        
        sendManagerEmail(`APM manager error`, `Child module exited:   code:${code}  signal: ${signal}  module: ${this.relativePath}`);
        // if (code == 1) {
        
        if (now - this.lastStartTime < 5000) {
            logger.warn(`Time since last restart is under 5 seconds, something is wrong with the code most likely (rather than a one off process kill or similar).`);
            await sleep(60000);
        } else {
            await sleep(1000);
        }

        try {
            this.startProcess();
            sendManagerEmail(`APM manager alert`, `Process restarted via startProcess: ${this.relativePath}`);
        } catch (err) {
            logger.error(`Restart of process via startProcess threw an error  module: ${this.relativePath} : ${err}`);
            sendManagerEmail(`APM manager error`, `Restart of process via startProcess threw an error  module: ${this.relativePath} : ${err}`);
        }
        // }
    }
    
    async startProcess(childErrorCB = this.childErrorCB, childExitCB = this.childExitCB) {
        logger.info(`Starting process for ${this.relativePath}...`);
        const outFd = fs.openSync(`${APMCONFIG.logDir}/${path.basename(this.relativePath)}.start.log`, 'w');
        this.lastStartTime = new Date().getTime();
        this.child = fork(`${this.appDirectory}/${this.relativePath}`, {
            execArgv: this.opts,
            detached: true,
            stdio: [
                'ignore', // doesn't use stdin
                outFd, // direct child's stdout to a file
                outFd, // direct child's stderr to a file
                'ipc' // Required for parent<->child communication since we are using fork
              ]
        });
        this.child.on('error', childErrorCB.bind(this));
        this.child.on('exit', childExitCB.bind(this));

        this.child.unref();
        logger.info(`Child process started via PID: ${this.child.pid}`);


        // mod.child.on('error', childErrorCB);
        //         logger.error(`Child errored: ${err}`);
        //         // Do something, alert and restart?
        //         sendManagerEmail(`APM manager error`, `Child module error  module: ${mod.relativePath} : ${err}`)
        //     });
            // mod.child.on('exit', async (code, signal) => {
    }
}

function getPIDMemSwapUsage(pid) {
    let output;
    try {
        output = execSync(MANAGERCONFIG.pidInspectionCommand.replace('%PID%',pid));
    } catch (err) {
        logger.error(`Could not execute PID inspection command: ${err}`);
        alertsManager.addToAlertBuffer(`Could not inspect PID memory/swap usage: ${err}`);
        return { mem: undefined, swap: undefined };
    }
    let arr = output.toString().split(/\s+/);
    return { mem: parseFloat(arr[0]), swap: parseFloat(arr[2]) }
}

async function killAllModules() {
    sendAnnotation(`Restarting all modules`, [ "maintenance" ]);

    // Kill existing module processes
    for await (const mod of modules) {
        try {
            await mod.killExistingPIDs();
        } catch (err) {
            logger.error(`Kill pid for mod: ${mod.relativePath} errored: ${err}`);
        }
    }
}

async function startAllModules() {
    // Startup all module processes
    for await (const mod of modules) {
        try {
            await mod.startProcess();
        } catch (err) {
            logger.error(`startProcess threw an error: ${err}`);
        }
    }
    logger.info(`Processes started.`);
}

function inspectDiskSpace() {
    // const dirList = [];

    // const rabbitDataDir = getRabbitDataDirectory();
    // if (rabbitDataDir) dirList.push(rabbitDataDir);
    
    let mountPath = path.join('/', path.dirname(APMCONFIG.appDirectory).split(path.sep)[1]);
    if (mountPath) {
        const { size, used, avail, percent } = df(mountPath);
        if (avail <= MANAGERCONFIG.diskSpaceGBAvailableThreshold) {
            alertsManager.addToAlertBuffer(`Available disk space is low on mount: ${mountPath} - Size: ${size} GB, Used: ${used} GB, Available: ${avail} GB, PercentUsed: ${percent}%`);
        }
        if (percent > MANAGERCONFIG.diskSpacePercentageUsedThreshold) {
            alertsManager.addToAlertBuffer(`Disk space percentage used is high on mount: ${mountPath} - Size: ${size} GB, Used: ${used} GB, Available: ${avail} GB, PercentUsed: ${percent}%`);
        }
    }
}

function df(mountPath) {
    let output;
    try {
        output = execSync(MANAGERCONFIG.mountInspectionCommand.replace('%MOUNT%', mountPath));
    } catch (err) {
        logger.error(`Could not read mount disk usage: ${err}`);
        alertsManager.addToAlertBuffer(`Could not inspect mount disk usage via df command: ${err}`);
        return { size: undefined, used: undefined, avail: undefined, percent: undefined };
    }

    let arr = output.toString().split(/\s+/).filter(Boolean);
    return { size: parseFloat(arr[0]), used: parseFloat(arr[1]), avail: parseFloat(arr[2]), percent: parseFloat(arr[3]) };
}

function inspectQueues() {
    let output;
    try {
        const ctl = path.join(MANAGERCONFIG.rabbitSbinPath, 'rabbitmqctl');
        output = execSync(`${ctl} list_queues --quiet --no-table-headers name messages_ram message_bytes_ram messages_persistent message_bytes_persistent memory`);
    } catch (err) {
        alertsManager.addToAlertBuffer(`Could not inspect queues via rabbit controller: ${err}`);
        return;
    }
    let lines = output.toString().match(/[^\r\n]+/g);;
    lines.forEach(line => {
        // These values are strings until casted
        let [ name, messages_ram, message_bytes_ram, messages_persistent, message_bytes_persistent, memory ] = line.split(/\s+/);
        let msgCntTotal = parseInt(messages_ram) + parseInt(messages_persistent);
        let queueMemMb = parseInt(memory) / 1024.0 / 1024.0;
        logger.debug(`QUEUE: ${name} Count: ${msgCntTotal} MemMb: ${queueMemMb.toFixed(1)}`);

        if (msgCntTotal > MANAGERCONFIG.queueMessageAlertThreshold) {
            alertsManager.addToAlertBuffer(`Queue exceeded the message count threshold - Queue: ${name} Threshold: ${MANAGERCONFIG.queueMessageAlertThreshold} MessageCount: ${msgCntTotal}`);
        }
        if (queueMemMb > MANAGERCONFIG.queueMemoryAlertThreshold) {
            alertsManager.addToAlertBuffer(`Queue exceeded the memory threshold - Queue: ${name} Threshold: ${MANAGERCONFIG.queueMemoryAlertThreshold} MemoryUsed(Mb): ${queueMemMb.toFixed(1)}`);
        }
    });
}

function getModuleSetting(settingName, moduleRelativePath) {
    const moduleSettingObj = MANAGERCONFIG.moduleSettings.find(mod => mod.relativePath == moduleRelativePath);
    // logger.error(moduleSettingObj.pprint());
    // logger.warn(`${moduleSettingObj[settingName]} <=> ${MANAGERCONFIG[settingName]}`)
    if (moduleSettingObj[settingName] || moduleSettingObj[settingName] === 0) {
        return moduleSettingObj[settingName];
    } else {
        return MANAGERCONFIG[settingName];
    }
}

function pidExists(pid) {
    try {
        process.kill(pid, 0); // Doesn't actually kill it
        return true;
    } catch (err) {
        return false;
    }
}

async function inspectModules() {
    for (const mod of modules) {
        let triggerGC = false;
        // logger.warn(mod.child.pprint());

        if (!pidExists(mod.child.pid)) {
            // TODO add logging and such
            logger.error(`Module PID is no longer running - PID: ${mod.child.pid} module: ${mod.relativePath} - Will attempt to restart...`);
            sendManagerEmail(`APM manager error`, `Child module PID is no longer running - PID: ${mod.child.pid} module: ${mod.relativePath} - Will attempt to restart...`);
            await mod.startProcess();   
        } else {
            let { mem, swap } = getPIDMemSwapUsage(mod.child.pid);
            logger.debug(`PID: ${mod.child.pid} Memory: ${mem} Swap: ${swap}`);

            if (mem === undefined || swap === undefined) return;

            const moduleMemoryAlertThreshold = parseFloat(getModuleSetting("moduleMemoryAlertThreshold", mod.relativePath));
            // logger.warn(`module memory setting obtained: ${moduleMemoryAlertThreshold} for ${mod.relativePath}`);
            if (mem > moduleMemoryAlertThreshold) {
                alertsManager.addToAlertBuffer(`Child module exceeded the memory threshold - Module: ${mod.relativePath} Threshold(Mb): ${moduleMemoryAlertThreshold} MemoryUsed(Mb): ${mem.toFixed(1)}`);
                triggerGC = true;
            }

            const moduleSwapAlertThreshold = parseFloat(getModuleSetting("moduleSwapAlertThreshold", mod.relativePath));
            // logger.warn(`module swap setting obtained: ${moduleSwapAlertThreshold} for ${mod.relativePath}`);
            if (swap > moduleSwapAlertThreshold) {
                alertsManager.addToAlertBuffer(`Child module exceeded the swap threshold - Module: ${mod.relativePath} Threshold(Mb): ${moduleSwapAlertThreshold} SwapUsed(Mb): ${swap.toFixed(1)}`);
                triggerGC = true;
            }

            if (triggerGC) { // Does this need throttling? Probably won't hurt much if the GC is requested a few times
                // Send GC trigger message to child
                logger.info(`Sending garbage collection request to module: ${mod.relativePath}`);
                mod.child.send('requestGC');
            }
        }
    }
}

async function monitorResourcesRecurs() {
    logger.debug(`Inspecting resources...`);

    if (!rabbitMQIsRunning()) { 
        alertsManager.addToAlertBuffer(`RabbitMQ is down, attempting to restart it.`);
        startRabbitMQ();
        await sleep(30 * 1000); 
    }

    inspectDiskSpace();
    inspectQueues();
    await inspectModules();

    let currentSec = new Date().getSeconds();
    const timeoutSec = MANAGERCONFIG.inspectionFrequencySeconds - (currentSec % MANAGERCONFIG.inspectionFrequencySeconds);
    setTimeout(monitorResourcesRecurs.bind(this), timeoutSec * 1000); // Try to start it on a second multiple
} 

async function removeOldLogs() {
    logger.info(`Removing logs older than ${MANAGERCONFIG.appLogRetentionDays} days...`);

    fs.readdir( APMCONFIG.logDir, (err, files) => {
        if ( err ) {
            logger.error(`Error reading directory: ${APMCONFIG.logDir} - ${err}`);
            return;
        }
        files.forEach(file => {
            var filePath = path.join(APMCONFIG.logDir, file);
            fs.stat( filePath, function( err, stat ) {
                if ( err ) {
                    logger.error(`Error reading file: ${filePath} - ${err}`);
                    return;
                }

                let minDate = new Date();
                minDate.setDate(minDate.getDate() - parseInt(MANAGERCONFIG.appLogRetentionDays));
                const minDay = minDate.convertDateToYYYYMMDDNumber();

                const fileDay = stat.ctime.convertDateToYYYYMMDDNumber();

                if (fileDay < minDay) {
                    logger.warn(`Removing file due to age: ${filePath}`);
                    fs.unlink( filePath, function( err ) {
                        if ( err ) {
                            logger.error(`Error unlinking file: ${filePath} - ${err}`);
                            return;
                        }
                    });
                }
            });
        });
    });
}

function cleanupAppLogsRecurse() {
    removeOldLogs();
    setTimeout(cleanupAppLogsRecurse.bind(this), 12 * 60 * 60 * 1000); // Every 12 hours after startup, try to remove old logs
}

//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////
// MAIN
//////////////////////////////////////////////////////////////////////////////
//////////////////////////////////////////////////////////////////////////////

const args = process.argv.slice(2); // First two args are node path and this script's path, so ignore them

(async () => {

    try {
        APMCONFIG = readAPMConfig(true);
        MANAGERCONFIG = APMCONFIG.applicationManager;
        setGlobalLogger(APMCONFIG.logDir, MANAGERCONFIG.logFilePrefix); // This sets global.logger for use here and in modules

        watchAPMConfig(
            APMCONFIG, 
            async (newAPMCONFIG) => { // Callback to update local variables on APM config file update
                APMCONFIG = newAPMCONFIG; 
                MANAGERCONFIG = APMCONFIG.applicationManager; 
                setGlobalLogger(APMCONFIG.logDir, MANAGERCONFIG.logFilePrefix); // This sets global.logger for use here and in modules
            }, 
            [ 'apmConfigFilePath', 'logDir',  'applicationManager.sharedNodeOpts', 'applicationManager.moduleSettings' ]
        );

        alertsManager = new AlertsManager();
        alertsManager.startAlertSender();

        async function exit() {
            //TODO
            // Kill the child here
            process.exit();
        }

        process.on('SIGINT', function() {
			logger.warn(`Caught SIGINT signal`);
			exit();
        })
        .on('SIGTERM', function() {
			logger.warn(`Caught SIGTERM signal`);
			exit();
        });

        if (!rabbitMQIsRunning()) { 
            startRabbitMQ(); 
            await sleep(30 * 1000); 
        }

        const moduleSettings = MANAGERCONFIG.moduleSettings;
        modules = moduleSettings.map(el => new Module(APMCONFIG.appDirectory, MANAGERCONFIG.sharedNodeOpts, el));

        await killAllModules();
        await startAllModules();

        // // Kill existing module processes
        // for await (const mod of modules) {
        //     await mod.killExistingPIDs();
        // }

        // // Startup all module processes
        // for await (const mod of modules) {
        //     try {
        //         // await mod.startProcess(childErrorCB, childExitCB);
        //         await mod.startProcess();
        //     } catch (err) {
        //         logger.error(`startProcess threw an error: ${err}`);
        //     }
        // }
        // logger.info(`Processes started.`);

        monitorResourcesRecurs();
        cleanupAppLogsRecurse();

    } catch (error) {
        logger.error(`Caught error: ${error}\n${new Error().stack}`);
    }
})();