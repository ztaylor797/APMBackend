#!/usr/bin/env node

const fs = require("fs");
const nodemailer = require("nodemailer");
const Path = require('path'); 

const https = require('https');
const axios = require('axios');
var stringify = require('json-stringify-safe');

const UtilMethods = require('./util_methods.js')();

const instance = axios.create({
    timeout: 1000,
    httpsAgent: new https.Agent({
        rejectUnauthorized: false // Ignore self-signed certificate error
    })
});


function sendTestEmail(subj, html, imagePath) {
    sendEmail('s4apm-TEST@acxiom.com', 'ztaylo@acxiom.com', subj, html, imagePath);
}

// Returns a path string on successful download
async function renderGraph(renderURL) {
    logger.info(`Rendering graph...`);
    try {

        const imagePath = Path.resolve(__dirname, 'renders', `alert_${new Date().toISOString()}.png`);
        logger.info(`HERE01`);
        const writer = fs.createWriteStream(imagePath);
        logger.info(`HERE02`);

        // const response = await instance.get(renderURL, config);
        const response = await instance({
            headers: { Authorization: "Bearer **REMOVED**" },
            url: renderURL,
            method: 'GET',
            timeout: 60000,
            responseType: 'stream'
        });
        logger.info(`HERE03`);

        response.data.pipe(writer);

        logger.info(`HERE04`);
        return new Promise((resolve, reject) => {
            writer.on('finish', () => {
                logger.info(`Resolving!`);
                resolve(imagePath)
            });
            writer.on('error', () => {
                logger.error(`Rejecting!`);
                reject()
            });
        });                

    } catch (error) {
        logger.error(`Error rendering graph!`);
        logger.error(error);
    };
}

(async () => {
    await setGlobalLogger('/u07/app/prod/apm/streaming_stat_parser/logs', 'imagedltest');

    const renderURL = 'https://some.server.com:3000/render/d/JrQYQiuZz/alert-inspector?orgId=1&from=1583788732571&to=1583790442571&var-server=xcla9571&var-service=BalconAccountPromoDetails.getBalconAccountPromoDetailsById&var-service=callProcS4VelocityDaily&var-lag=360&var-serverServiceLag=All&var-serverLag=All&width=1800&height=1450&tz=America%2FChicago';

    try {
        const imagePath = await renderGraph(renderURL);
        sendTestEmail('test apm', '<h1>this is a test</h1>', imagePath);
    } catch (err) {
        logger.error(`Error while trying to render graph`);
        logger.error(err);
        sendTestEmail('test apm', '<h1>this is a test with NO image</h1>');
    }
})();

