#!/usr/bin/env node

var ps = require('ps-node');
const { execSync } = require('child_process');
const fs = require("fs");

var stringify = require('json-stringify-safe');

const https = require('https');
const axios = require('axios');

const instance = axios.create({
    timeout: 1000,
    httpsAgent: new https.Agent({
        rejectUnauthorized: false // Ignore self-signed certificate error
    })
});

const { EntryFactory, AlertEntry } = require('./entries.js');
const UtilMethods = require('./util_methods.js')();

// const insertBuffer = [ 
//     { acctnum: 538 },
//     { someother: 88892 }
// ]
// if (!("acctnum" in insertBuffer[0])) {
//     console.log(`no acctnum`);
// }
// if (!("acctnum" in insertBuffer[1])) {
//     console.log(`no acctnum`);
// }

let ALERTSCONFIG = {};
ALERTSCONFIG.alertInspectorRelativeURL = "/d/JrQYQiuZz/alert-inspector";
ALERTSCONFIG.grafanaURL = "https://some.server.com:3000";
ALERTSCONFIG.grafanaNowDelayIntervalMs = 90000;

const bearer = "Bearer **REMOVED**";
const config = {
    headers: { Authorization: bearer }
};

const bodyParameters = {
    time: 1583783019066,
    timeEnd: 1583783039066,
    text: "Post test annotation",
    tags: [ "maintenance" ]
};

(async () => {
    try {
        const response = await instance.post(`${ALERTSCONFIG.grafanaURL}/api/annotations`, bodyParameters, config);
        console.log(`-----------------------`);
        console.log(`Response: ${stringify(response.data, undefined, 2)}`);
    } catch (err) {
        console.error(err);
    }
})();

// class SomeClass {
//     constructor() {
//         this.alertBuffer = [];
//         this.entryFactory = new EntryFactory();

//         this.alertBuffer.push({
//             entry: {
//                 server: "somehostname",
//                 service: "callProcS4VelocityDaily",
//                 lag: "360",
//                 timestamp: 1583777379301
//             }
//         });
//         this.alertBuffer.push({
//             entry: {
//                 server: "xlla9582",
//                 service: "BalconAccountPromoDetails.getBalconAccountPromoDetailsById",
//                 lag: "360",
//                 timestamp: 1583778079237
//             }
//         });
//     }

//     generateGrafanaURL() {
//         const servers = [];
//         const services = [];
//         const lags = [];
//         this.alertBuffer.forEach(el => {
//             // const entry = this.entryFactory.getEntryFromCSV(el.entry, '&');
//             const entry = el.entry;
//             if (!servers.includes(entry.server)) servers.push(entry.server);
//             if (!services.includes(entry.service)) services.push(entry.service);
//             if (!lags.includes(entry.lag)) lags.push(entry.lag);
//         });

//         const firstTs = this.alertBuffer[0].entry.timestamp;
//         const lastTs = this.alertBuffer[this.alertBuffer.length - 1].entry.timestamp;

//         const nowMs = new Date().getTime();

//         // Keep in mind we can have several alerts on one email spanning potentially maxCollectionIntervalInSeconds + a bit extra
//         let from, to;

//         // Set "from" timestamp to first alert timestamp - 5 minutes
//         from = firstTs - 300000;

//         // Set "to" timestamp to last alert timestamp + 5 minutes
//         to = lastTs + 300000

//         // If the "to" timestamp is within the last 90 seconds (or the future), set it to the last 90 seconds (built in delay of data getting into grafana)
//         if (nowMs - lastTs <= 90000) {
//             to = nowMs - 90000;
//         }

//         let URL = `${ALERTSCONFIG.grafanaURL}${ALERTSCONFIG.alertInspectorRelativeURL}?from=${from}&to=${to}`;

//         servers.forEach(server => URL += `&var-server=${server}`);
//         services.forEach(service => URL += `&var-service=${service}`);
//         lags.forEach(lag => URL += `&var-lag=${lag}`);

//         return URL;
//     }
// }

// const someClass = new SomeClass();
// console.log(someClass.generateGrafanaURL());







// let entryFactory = new EntryFactory();

// function resumeFromFileIfExists(resumeFile) {

//     // Check if the file exists in the directory, and if it is writable.
//     // fs.access(resumeFile, fs.constants.F_OK | fs.constants.W_OK, (err) => {
//     try {
//         fs.accessSync(resumeFile, fs.constants.F_OK | fs.constants.W_OK);
//         console.log(`Resume file found! Resuming data from file: ${resumeFile}`);
//         const content = fs.readFileSync(resumeFile);
//         try {
//             const jsonContent = JSON.parse(content);
//             // console.log(jsonContent.latestBucket);
//             // console.log('\n\n');
//             // console.log(jsonContent.servers);
//             console.log('\n\n');
//             console.log(jsonContent.minHeap);
//             console.log('\n\n');
//             console.log(`HERE01`);
//             jsonContent.minHeap.content.forEach(obj => {
//                 console.log(obj);
//                 try {
//                     entryFactory.getEntryFromObject(obj);
//                 } catch (err) {
//                     console.error(err);
//                 }
//             });
//             console.log(`FINISHED`);
//         } catch (e) {
//             console.error(`Could not parse JSON content from resume file: ${resumeFile}`);
//         }	
//     } catch (err) {
//         console.warn(`Resume file does not exist or is not writeable, will not resume data: ${resumeFile}`);
//         console.error(err);
//         // process.exit(2); // TODO maybe change this?
//     }
// }

// resumeFromFileIfExists('/u07/app/prod/apm/streaming_stat_parser/save/stream_calc_stats.resume');





// function replacer(key, value) {
//   const originalObject = this[key];
//   if(originalObject instanceof Map) {
//     return {
//       dataType: 'Map',
//       value: Array.from(originalObject.entries()), // or with spread: value: [...originalObject]
//     };
//   } else {
//     return value;
//   }
// }

// function reviver(key, value) {
//   if(typeof value === 'object' && value !== null) {
//     if (value.dataType === 'Map') {
//       return new Map(value.value);
//     }
//   }
//   return value;
// }

// (async () => {

//     await setGlobalLogger('/u07/app/prod/apm/streaming_stat_parser/logs', 'maptest'); // This sets global.logger for use here and in modules

//     const arr = [ { id: 1 }, {id: 2} ];
//     let insertBufferMap;
//     if (!insertBufferMap) {
//         insertBufferMap = new Map();
//         insertBufferMap.set('tx', []);
//         insertBufferMap.set('fs', []);
//         insertBufferMap.set('al', []);
//     }
//     // console.log(insertBufferMap);
//     // console.log(instanceof insertBufferMap);
//     // console.log(insertBufferMap.dataType );

//     // console.log(JSON.stringify(insertBufferMap));
//     // console.log(JSON.stringify(arr, replacer));
//     // console.log(JSON.stringify(arr));

//     // saveToResumeFile('/u07/app/prod/apm/streaming_stat_parser/save/buffertest.resume', insertBufferMap);

//     // let newMap = resumeBufferFromFileIfExists('/u07/app/prod/apm/streaming_stat_parser/save/buffertest.resume');
//     let newMap = resumeBufferFromFileIfExists('/u07/app/prod/apm/streaming_stat_parser/save/stream_insert_db_buffer.resume');
//     logger.warn(JSON.stringify(newMap, undefined, 2));
//     console.log(newMap);

//     // process.exit();
//     setTimeout(() => process.exit(), 1000); // logger writes are async so need to wait
// })();



// const path = "stream_parse_transactions.js";

// function lookupPids() {
//     const pidListCommand = "ps -U prod -u prod -o pid,ppid,args";
//     const output = execSync(`${pidListCommand}`);
//     const resultList = output.toString().split(/\n+/).filter(Boolean).map(line => {
//         line = line.trim();
//         const a = line.trim().split(/\s+/);

//         const pid = a.shift();
//         const ppid = a.shift();
//         const command = a.shift();
//         // Remaining array comprises the arguments list
//         return {
//             pid,
//             ppid,
//             command,
//             arguments: a
//         }
//     });
//     return resultList;
// }

// function lookupPidsByRelativeScriptPath(relativePath) {
//     const resultList = lookupPids();
//     return resultList.filter(el => {
//         if (el.command.match(/node/) && el.arguments.filter(arg => arg.match(new RegExp(relativePath))).length > 0) {
//             return el;
//         }
//     })
// }

// console.log(lookupPidsByRelativeScriptPath(path));

// async function lookup() {
//     return new Promise((resolve, reject) => {
//         ps.lookup({
//             command: 'node'
//             // arguments: new RegExp(relativePath),
//         }, (err, resultList) => {

//             console.log(`${relativePath} -> err: ${err}`);
//             console.log(`${relativePath} -> resultList: ${resultList}`);
//             console.log(`${resultList.length} found`);

//             if (err !== null) reject(err);
//             else resolve(resultList);
//         });
//     });
// }

// (async () => {
//     try {
//         await lookup();
//     } catch (err) {
//         console.log(`error caught: ${err}`);
//     }
// })();

// ps.lookup({
//     // command: '/usr/bin/node'
//     // command: new RegExp('.*node.*')
//     // command: /node/
//     arguments: new RegExp(relativePath)
// }, (err, resultList) => {

//     console.log(`${relativePath} -> err: ${err}`);
//     console.log(`${relativePath} -> resultList: ${resultList}`);
//     console.log(`${resultList.length} found`);
//     console.log(resultList[0]);
// });

// async function logType(type) {
//     console.log(type);
// }
// async function processArray(map) {
//   // map array to promises
// //   const promises = array.map(delayedLog);
//     for await (type of map.keys()) {
//         await logType(type);
//     }
//   // wait until all promises are resolved
// //   await Promise.all(promises);
//     console.log('Done!');
// }
// const map = new Map();
// map.set(1,'one');
// map.set(2,'two');
// map.set(3,'three');
// processArray([1,2,3]);

// function convertDateToLogDate(dt) {
// 		// const dt = this;

// 		let dd = dt.getDate();
// 		let mm = dt.getMonth()+1;
// 		const yyyy = dt.getFullYear();

// 		let hour = dt.getHours();
// 		let min = dt.getMinutes();
// 		let sec = dt.getSeconds();

// 		if(dd<10) {
// 			dd='0'+dd;
// 		}
// 		if(mm<10) {
// 			mm='0'+mm;
// 		} 
// 		if(hour<10) {
// 			hour='0'+hour;
// 		}
// 		if(min<10) {
// 			min='0'+min;
// 		} 
// 		if(sec<10) {
// 			sec='0'+sec;
// 		} 
// 		return `${yyyy}-${mm}-${dd} ${hour}:${min}:${sec}`;
// };

// const alert = new AlertEntry(new Date().getTime(), new Date().getTime() + 5000, 'somehostname', 'getSalesServiceOffers', 'cause1,cause2', 'field1|field2|field3');
// console.log(JSON.stringify(alert, undefined, 2));
// console.log(alert.toCSVString());
// console.log(convertDateToLogDate(new Date(alert.alertTimestamp)));
// console.log(convertDateToLogDate(new Date(alert.entryTimestamp)));





// const map = new Map();
// const nMap = new Map();
// nMap.set('subkey', []);

// map.set('mykey', nMap);

// const nMap2 = map.get('mykey');
// nMap2.set('newsubkey','somestring');

// console.log(map);
// console.log(nMap2);

// const line = '          <name>RequestTimeCreation</name>';

// console.log(line.replace(/<\/.*/,'').replace(/.*>/,''));

// const convertStringDateToMs = (dateStr) => {
//     if (dateStr.match(/T.*-/)) {
//         // This is a UTC formatted timestamp from audit trail with timezone, easy to parse
//         // Ex: 2020-01-07T10:00:01.959-06:00
//         return new Date(dateStr).getTime();
//     } else {
//         // This should be a standard log format date
//         // Ex: 2020-01-07 10:00:02,669
//         const arr = dateStr.trim().split(/-|[\s]+|:|,/);
//         // Month is 0-11
//         return new Date(arr[0], arr[1] - 1, arr[2], arr[3], arr[4], arr[5], arr[6]).getTime();
//     }
// };

// const tzStr = '2020-01-07T10:00:01.626-06:00';
// const dtStr = '2020-01-07 10:00:01,626';
// console.log(new Date(convertStringDateToMs(tzStr)).toISOString()); 
// console.log(new Date(convertStringDateToMs(dtStr)).toISOString());

// console.log(undefined);

// const str = '1|2|3'
// console.log(str.split(/|/));
