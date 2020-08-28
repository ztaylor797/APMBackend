#!/usr/bin/env node

var amqp = require('amqplib/callback_api');
var readline = require('readline');

function usage(scriptPath) {
	console.log(`Usage: ${scriptPath} queueName`);
	console.log(`Exiting 2 ...`);
	process.exit(2);
}

const args = process.argv.slice(2); // First two args are node path and this script's path
const queueName = args[0];

if (!queueName) {
    usage(process.argv[1]);
}

amqp.connect('amqp://localhost:5772', function(error0, connection) {
    if (error0) {
        throw error0;
    }
    console.log("AMQP connected.");
    connection.createChannel(function(error1, channel) {
        if (error1) {
            throw error1;
        }
        console.log("Channel created.");

        var queue = queueName;
        console.log(`Queue name: ${queue}`);

        channel.assertQueue(queue, {
            durable: true
        });

        process.on('SIGINT', function() {
            console.log("Caught interrupt signal, exiting.");
        //    channel.close();
            process.exit(0);
        });

        console.log(" [*] Waiting for messages in %s. To exit press CTRL+C", queue);

        channel.consume(queue, function(msg) {
            console.log("%s", msg.content.toString());
        }, {
            noAck: true
        });
    });
});
