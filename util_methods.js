const fs = require("fs");
const md5 = require('md5');
// const sendmail = require('sendmail')({silent: true});
const nodemailer = require("nodemailer");
const sqlite3 = require('sqlite3').verbose();
const Path = require('path'); 

// These methods all expect a global logger to be initialized before calling them, see setGlobalLogger()

function average() {
    let cnt = 0; // Only average defined values, so don't use length, use a counter
    let sum = this.reduce(function(sum, value){
        if (value != null && !isNaN(parseFloat(value))) {
            cnt += 1;
            return sum + parseFloat(value);
        } else 
            return sum;
    }, 0);

    var avg = undefined;
    if (cnt > 0)
        avg = sum / cnt;
    return avg;
};

function standardDeviation() {
    var avg = this.average(this);
    if (!avg && avg !== 0) // Can happen if the array is empty or all elements are undefined
        return undefined;
    
    var squareDiffs = this.map(function(value){
        if (value != null && !isNaN(parseFloat(value))) {
            var diff = parseFloat(value) - avg;
            var sqrDiff = diff * diff;
            return sqrDiff;
        } else {
            return undefined;
        }
    });
    
    var avgSquareDiff = this.average(squareDiffs);

    var stdDev;
    if (avgSquareDiff && avgSquareDiff != 0) {
        stdDev = Math.sqrt(avgSquareDiff);
    } else {
        stdDev = undefined;
    }
    return stdDev;
};

/* 
    target: the object to search for in the array
    comparator: (optional) a method for comparing the target object type
    return value: index of a matching item in the array if one exists, otherwise the bitwise complement of the index where the item belongs
*/
function binarySearch(target, comparator) {
    var l = 0,
        h = this.length - 1,
        m, comparison;
    comparator = comparator || function (a, b) {
        return (a < b ? -1 : (a > b ? 1 : 0)); /* default comparison method if one was not provided */
    };
    while (l <= h) {
        m = (l + h) >>> 1; /* equivalent to Math.floor((l + h) / 2) but faster */
        comparison = comparator(this[m], target);
        if (comparison < 0) {
            l = m + 1;
        } else if (comparison > 0) {
            h = m - 1;
        } else {
            return m;
        }
    }
    return~l;
};
	
/*
    target: the object to insert into the array
    duplicate: (optional) whether to insert the object into the array even if a matching object already exists in the array (false by default)
    comparator: (optional) a method for comparing the target object type
    return value: the index where the object was inserted into the array, or the index of a matching object in the array if a match was found and the duplicate parameter was false 
*/
function binaryInsert(target, duplicate, comparator) {
    var i = this.binarySearch(target, comparator);
    if (i >= 0) { /* if the binarySearch return value was zero or positive, a matching object was found */
        if (!duplicate) {
            return i;
        }
    } else { /* if the return value was negative, the bitwise complement of the return value is the correct index for this object */
        i = ~i;
    }
    this.splice(i, 0, target);
    return i;
};

/*
    sourceArray: The array to binary insert into this array
    duplicate: (optional) whether to insert the object into the array even if a matching object already exists in the array (false by default)
	comparator: (optional) a method for comparing the target object type
*/
function binaryConcat(sourceArray, duplicate, comparator) {
    sourceArray.forEach(el => {
        this.binaryInsert(el, duplicate, comparator);
    });
};

/*
	percentile: number from 0-100 corresponding to percentile, E.G. 90 => 90th percentile
	The array must be sorted from lowest to highest before calling this method.
*/
function calcPercentile(percentile) {
    function isInt(n) {
        return n % 1 == 0;
    }

    if (this.length === 0) {
        return undefined;
    }

    // Edge cases
    if (percentile === 0) {
        return this[0];
    }
    if (percentile === 100) {
        return this[this.length-1];
    }

    let index = ((percentile / 100.0) * this.length) - 1.0; // -1 for zero-based array

    if (this.length === 1 || isInt(index)) {
        index = parseInt(index);
        return this[index];
    } else {
        index = parseInt(Math.ceil(index));
        if (index === (this.length-1)) {
            return this[index];
        } else {
            return (this[index] + this[index + 1]) / 2;
        }
    }
};

function replaceAll(search, replacement) {
	const target = this;
	return target.replace(new RegExp(search, 'g'), replacement);
};

function convertDateToLogDate() {
		const dt = this;

		let dd = dt.getDate();
		let mm = dt.getMonth()+1;
		const yyyy = dt.getFullYear();

		let hour = dt.getHours();
		let min = dt.getMinutes();
		let sec = dt.getSeconds();

		if(dd<10) {
			dd='0'+dd;
		}
		if(mm<10) {
			mm='0'+mm;
		} 
		if(hour<10) {
			hour='0'+hour;
		}
		if(min<10) {
			min='0'+min;
		} 
		if(sec<10) {
			sec='0'+sec;
		} 
		return `${yyyy}-${mm}-${dd} ${hour}:${min}:${sec}`;
};

function convertDateToYYYYMMDDNumber() {
    const dt = this;
    // Month is zero-based
    return parseInt(`${dt.getFullYear()}${(dt.getMonth()+1).toString().padStart(2,'0')}${dt.getDate().toString().padStart(2,'0')}`);
}

function pprint(indent = 2) {
    return JSON.stringify(this, undefined, indent);
};

// Replacer and Reviver allow us to serialize and marshal Map objects to and from JSON (not natively supported by JSON.stringify)
function replacer(key, value) {
  const originalObject = this[key];
  if(originalObject instanceof Map) {
    return {
      dataType: 'Map',
      value: Array.from(originalObject.entries()), // or with spread: value: [...originalObject]
    };
  } else {
    return value;
  }
}

function reviver(key, value) {
  if(typeof value === 'object' && value !== null) {
    if (value.dataType === 'Map') {
      return new Map(value.value);
    }
  }
  return value;
}

function saveToResumeFile(resumeFile, object) {
    logger.info(`Saving data to resume file: ${resumeFile}`);

    // const json = JSON.stringify(object, undefined, 2);
    const json = JSON.stringify(object, replacer);

    fs.writeFileSync(resumeFile, json);

    logger.info(`Resume file has been saved: ${resumeFile}`);
}

function resumeBufferFromFileIfExists(resumeFile) {
    let returnObj = undefined;
    try {
        fs.accessSync(resumeFile, fs.constants.F_OK | fs.constants.W_OK);
        logger.info(`Resume file found! Resuming data from file: ${resumeFile}`);
        const content = fs.readFileSync(resumeFile);
        // logger.warn(content);
        try {
            // const rawObj = JSON.parse(content);
            // logger.warn(rawObj);
            // returnObj = JSON.parse(content).reduce((m, [key, val])=> m.set(key, val) , new Map());;
            returnObj = JSON.parse(content, reviver);
        } catch (e) {
            logger.error(`Could not parse JSON content from resume file: ${resumeFile}`);
        }
    } catch (err) {
        logger.warn(`Resume file does not exist or is not writeable, will not resume data: ${resumeFile}`);
        // process.exit(2); // TODO maybe change this?
    }

    return returnObj;
}

const sleep = (milliseconds) => {
    return new Promise(resolve => setTimeout(resolve, milliseconds))
}

function resolve(path, obj=self, separator='.') {
    const properties = Array.isArray(path) ? path : path.split(separator)
    return properties.reduce((prev, curr) => prev && prev[curr], obj)
}

function readAPMConfig(firstRun) {

    let logger;
    if (!global.logger) {
        logger = console;
        // logger.info(`Setting logger to console!`);
    } else logger = global.logger;

    // logger.info(`logger read apm config`);

    const apmConfigFilePath = require.resolve('./config/apm_config.json');

    function JSONstrip(txt){
        var re = new RegExp("[^:]\/\/(.*)","g");
        return txt.replace(re,'');
    }

    let config = undefined;
    try {
        fs.accessSync(apmConfigFilePath, fs.constants.F_OK | fs.constants.W_OK);

        logger.info(`APM config file found! Initializing settings from file: ${apmConfigFilePath}`);
        var content = fs.readFileSync(apmConfigFilePath, 'utf8');
        try {
            var jsonContent = JSON.parse(JSONstrip(content));

            config = jsonContent;
            config.apmConfigFilePath = apmConfigFilePath;
            logger.info(`Settings read from JSON.`);
        } catch (e) {
            logger.error(`Could not parse JSON content from APM config file: ${apmConfigFilePath}`);
            return undefined;
            // process.exit(2);
        }	
    } catch (err) {
        logger.warn(`APM config file does not exist or is not writeable, can't continue: ${apmConfigFilePath}`);
        process.exit(2); // TODO maybe change this?
    }
    logger.info(`Settings read successfully. Proceeding.`);
    logger.info(JSON.stringify(config, undefined, 2));

    return config;
}

async function watchAPMConfig(APMCONFIG, updateCallback, restartRequiredVars) {
    let prevMd5 = md5(fs.readFileSync(APMCONFIG.apmConfigFilePath));
    let prevSize = undefined;
    let fsWait = false;
    fs.watch(APMCONFIG.apmConfigFilePath, async (event, filename) => {
        if (filename) {

            // Debounce signal via 500 ms delay, this is because this callback can fire multiple times on one file change
            if (fsWait) return;
            fsWait = setTimeout(() => {
                fsWait = false;
            }, 500);

            await sleep(500); // Sleep while the file normalizes

            // Compare MD5 checksums to see if file actually changed
            const currMd5 = md5(fs.readFileSync(APMCONFIG.apmConfigFilePath));
            const fileSizeInBytes = fs.statSync(APMCONFIG.apmConfigFilePath).size;
            // logger.info(`oldmd5: ${prevMd5} newmd5: ${currMd5} oldsize: ${prevSize} newsize: ${fileSizeInBytes}`);
            if (currMd5 === prevMd5 && prevSize === fileSizeInBytes) return;

            prevMd5 = currMd5;
            prevSize = fileSizeInBytes;

            logger.info(`APM config file changed, reloading settings: ${filename}`);

            const prevAPMCONFIG = APMCONFIG;
            APMCONFIG = readAPMConfig();
            if (!APMCONFIG) { // Couldn't read the config, so continue without setting anything
                logger.warn(`The config file JSON could not be processed, proceeding with NO config changes. Future config corrections will be picked up.`);
                APMCONFIG = prevAPMCONFIG;
            } else {
                // secondaryCONFIG = APMCONFIG.streamAlerts;

                // const restartRequiredVars = [
                //     'apmConfigFilePath', 'amqpConnectionString', 'dbFileFullPath', 'streamAlerts.inQueue', 'streamAlerts.outQueue',
                //     'streamAlerts.dbAlertsTable', 'streamAlerts.dbBusyTimeout'
                // ];

                restartRequiredVars.forEach(varName => {
                    const oldVal = resolve(varName, prevAPMCONFIG);
                    const newVal = resolve(varName, APMCONFIG);
                    // The JSON check is an easy way to check if the nested objects match
                    if (newVal !== oldVal && JSON.stringify(oldVal) !== JSON.stringify(newVal))
                        logger.warn(`${varName} was changed on settings reload, but this will not take effect without a restart.\n--- Old ---\n${oldVal.pprint()}\n--- New ---\n${newVal.pprint()}`);
                });

                updateCallback(APMCONFIG);
            }
        }
    });
}

// function openDB(dbFileFullPath) {
//     return new sqlite3.Database(dbFileFullPath, (err) => {
//         if (err) {
//             return logger.error(err.message);
//         }
//         logger.info(`Connected to file-based SQlite database: ${dbFileFullPath}`);
//     });
// }

async function sendEmail(from, to, subj, html, imagePath) {

    let transporter = nodemailer.createTransport({
        sendmail: true,
        newline: 'unix',
        path: '/usr/sbin/sendmail'
    });

    const mailOpts = {
        from: from,
        to: to,
        subject: subj,
        html: html
    };

    if (imagePath) {
        const cid = `graph_${new Date().getTime()}`;

        // Embed image at the bottom of the html body
        mailOpts.html += `<br><br><img src="cid:${cid}"/>`;

        mailOpts.attachments = [{
            filename: Path.basename(imagePath),
            path: imagePath,
            cid
        }]
    }

    logger.info(`Sending email! ${JSON.stringify(mailOpts, undefined, 2)}`);
    let info = await transporter.sendMail(mailOpts);

    logger.info(`Message sent: ${JSON.stringify(info, undefined, 2)}`);

    // sendmail(mailOpts, function (err, reply) {
    //     if (err) logger.error(`sendmail error: ${err} ${err.stack}\n  reply: ${reply}`);
    //     else logger.info(`sendmail reply: ${reply}`);
    // });
}

function runGC(fullMarkSweep = true) {

    function getMemoryUsage() {
        const used = process.memoryUsage();
        let str = "";
        for (let key in used) {
            str += `${key} ${Math.round(used[key] / 1024 / 1024 * 100) / 100} MB\n`;
        }
        return str.replace(/\n$/, '');
    }

    if (global.gc) {
        logger.info(`Running garbage collection!`);
        logger.info(`Memory before GC:\n${getMemoryUsage()}`);
        global.gc(fullMarkSweep); // if true, trigger mark sweep full GC rather than shallow/quick GC
        setTimeout(() => logger.info(`Memory 10 seconds after requesting GC:\n${getMemoryUsage()}`), 10 * 1000); // We can't wait on GC to finish, so try waiting 10 seconds and then printing stats, hopefully it will have finished by then
    } else {
        logger.warn(`global.gc garbage collection is not available. Is node running with the --expose-gc parameter?`);
    }
}

async function setGlobalLogger(logDir, logFilePrefix) {
    return new Promise(resolve => {
        if (!global.logger) {
            console.log(`Configuring global logger: ${logDir} / ${logFilePrefix}`);
        }
        require('./logger.js')(logDir, logFilePrefix); // Sets the global.logger object
        logger.info(`Global logger configured: ${logDir} / ${logFilePrefix}`);
        resolve();
    });
}

const methodMap = {
    average: [ Array.prototype, average ],
    standardDeviation: [ Array.prototype, standardDeviation ],
    binarySearch: [ Array.prototype, binarySearch ],
    binaryInsert: [ Array.prototype, binaryInsert ],
    binaryConcat: [ Array.prototype, binaryConcat ],
    calcPercentile: [ Array.prototype, calcPercentile ],
    replaceAll: [ String.prototype, replaceAll ],
    convertDateToLogDate: [ Date.prototype, convertDateToLogDate ],
    convertDateToYYYYMMDDNumber: [ Date.prototype, convertDateToYYYYMMDDNumber ],
    pprint: [ Object.prototype, pprint ]
};

module.exports = function() {
    // Set methods for existing object types like Array and String
    Object.keys(methodMap).forEach(method => Object.defineProperty(methodMap[method][0], method, { value: methodMap[method][1] }) );

    // Set classes
    // this.QueueStats = QueueStats;

    // Set global functions
    this.saveToResumeFile = saveToResumeFile;
    this.resumeBufferFromFileIfExists = resumeBufferFromFileIfExists;
    this.sleep = sleep;
    this.resolve = resolve;
    this.readAPMConfig = readAPMConfig;
    this.watchAPMConfig = watchAPMConfig;
    // this.openDB = openDB;
    this.sendEmail = sendEmail;
    this.runGC = runGC;
    this.setGlobalLogger = setGlobalLogger;

    // Listen for GC requests
    process.on('message', (msg) => {
        if (msg == "requestGC") {
            runGC();
        }
    });
}
