var amqp = require('amqplib');
const EventEmitter = require('events');

class QueueStats {
    constructor(statLogIntervalInSeconds) {
        // this.interval = 60; // Default
        // this.msgOutStatsEnabled = msgOutStatsEnabled;
        // this.dbStatsEnabled = dbStatsEnabled;

        this.interval = statLogIntervalInSeconds;
        this.counters = new Map();
        
        // this.msgInCounter = 0;
        
        // if (msgOutStatsEnabled)
        //     this.msgOutCounter = 0;

        // if (dbStatsEnabled) {
        //     this.recInsCounter = 0;
        //     this.insElapTotal = 0;
        // }
    }

    setInterval(newInterval) {
        this.interval = newInterval;
    }

    addCounter(name, type, initVal = 0) {
        if (this.counters.size === 0) {
            // Start the recursive prints if this is the first counter added
            this.logQueueStatsRecurs(this.interval);
        }
        logger.info(`Init counter: ${name} Type: ${type}`);
        this.counters.set(name, { type, cnt: initVal });
    }

    incrCounter(name, val = 1) {
        this.counters.get(name).cnt += val;
    }

    logQueueStats() {
        if (this.counters.size <= 0) return;
        let str = '';
        let first = true;
        this.counters.forEach((obj, name) => {
            if (!first) str += ' - ';
            str += `${obj.type === 'c' ? 'IN<' : 'OUT>'}${name}: ${obj.cnt}`;
            first = false;
            obj.cnt = 0;
        });
        logger.info(str);
    }

    logQueueStatsRecurs(interval, notFirstTime) { // initial call should have no second parameter passed, successive calls should have undefined and true passed in
        if (interval) this.interval = interval;
        if (!interval && !this.interval) this.interval = 60; // Default value

        let currentSec = new Date().getSeconds();
        const timeoutSec = this.interval - (currentSec % this.interval);
        if (notFirstTime) this.logQueueStats();
        // setTimeout(this.logQueueStatsRecurs.bind(this, true), interval - currentSec * 1000); // Try to start it on the :00 second of every minute
        setTimeout(this.logQueueStatsRecurs.bind(this, undefined, true), timeoutSec * 1000); // Try to start it on the :00 second of every minute
    }
}

// Manager and not Factory because it also handles some events
class QueueManager extends EventEmitter {
    constructor(amqpConnectionString, statLogIntervalInSeconds) {
        super();
        this.amqpConnectionString = amqpConnectionString;
        // this.queueStatsObj = queueStatsObj;
        this.queueStats = new QueueStats(statLogIntervalInSeconds);
        // Define a single connection + channel for producer and then a separate pair for consumer (for max throughput)
        // A single producer channel can have multiple queues used with it
        this.producerConnection = undefined;
        this.producerChannel = undefined;
        this.consumerConnection = undefined;
        this.consumerChannel = undefined;

        this.queueMap = new Map();
    };

    setInterval(newInterval) {
        this.queueStats.setInterval(newInterval);
    }

    // Buffers are only relevant for producer queues
    retryAllQueueBuffers() {
        this.queueMap.forEach((queue, queueName) => {
            if (queue.type === 'p') {
                queue.retryBuffer();
            }
        });
        let totalBufferCount = 0;
        this.queueMap.forEach((queue, queueName) => {
            if (queue.type === 'p') {
                totalBufferCount += queue.getBufferCount();
            }
        });        
        if (totalBufferCount == 0) {
            this.emit('resume');
        }
        // this.queueMap.forEach((queue, queueName) => {
        //     queue.resume();
        // });
    };

    async getQueue(queueName, type, consumeCb = undefined) {
        if (this.queueMap.has(queueName)) {
            return this.queueMap.get(queueName);
        }
        if (type !== 'p' && type !== 'c') {
            logger.error(`QueueFactory.getQueue error: Type must be either 'p' or 'c'.`);
            // process.exit(9);
        }
        if (type === 'c' && !consumeCb) {
            logger.error(`A callback must be provided when consuming a queue.`);
            // process.exit(9);
        }
        if (type === 'p' && !this.producerConnection) {
            this.producerConnection = await amqp.connect(this.amqpConnectionString);
            this.producerChannel = await this.producerConnection.createChannel();
            if (!this.producerChannel) {
                logger.error(`Error: producerConnection.createChannel() failed on ${queueName}`);
            }
            this.producerChannel.on('drain', () => {
                // logger.info(`+++ DRAIN EVENT +++ Attempting to enqueue ${buffer.length} records from saved buffer first.`);
                logger.info(`+++ DRAIN EVENT +++ on producerChannel`);
                this.retryAllQueueBuffers();
            });
        } else if (type === 'c' && !this.consumerConnection) {
            this.consumerConnection = await amqp.connect(this.amqpConnectionString);
            this.consumerChannel = await this.consumerConnection.createChannel();
            if (!this.consumerChannel) {
                logger.error(`Error: consumerConnection.createChannel() failed on ${queueName}`);
            }
        }

        let queue;
        if (type === 'p') {
            queue = new ProducerQueue(queueName, this.producerChannel, this.queueStats);
        } else {
            queue = new ConsumerQueue(queueName, this.consumerChannel, this.queueStats, consumeCb);
        }
        await queue.init();
        if (type === 'p') {
            queue.on('pause', () => {
                logger.info(`Pausing all queues!`);
                this.emit('pause');
            });
        }
        this.queueMap.set(queueName, queue);
        return queue;
    };

    async shutdown() {
        // this.queueMap.forEach(async (queue, queueName) => {
        //     await queue.close();
        // });
        if (this.producerChannel) {
            try {
                await this.producerChannel.close();
            } catch (err) {
                logger.error(`producerChannel.close() error: ${err}`);
            }
        }
        if (this.consumerChannel) {
            try {
                await this.consumerChannel.close();
            } catch (err) {
                logger.error(`consumerChannel.close() error: ${err}`);
            }
        }
        if (this.producerConnection) {
            try {
                await this.producerConnection.close();
            } catch (err) {
                logger.error(`producerConnection.close() error: ${err}`);
            }
        }
        if (this.consumerConnection) {
            try {
                await this.consumerConnection.close();
            } catch (err) {
                logger.error(`consumerConnection.close() error: ${err}`);
            }
        }
    }
}
    
class Queue extends EventEmitter {
    constructor(queueName, channel, queueStats) {
        super();
        this.queueName = queueName;
        this.channel = channel;
        this.queueStats = queueStats;
    }

    async init() {
		await this.channel.assertQueue(this.queueName, {
			durable: true
        });
    }
}

class ProducerQueue extends Queue {
    
    constructor(queueName, channel, queueStats) {
        super(queueName, channel, queueStats);
        this.buffer = [];
        this.paused = false;
        this.type = 'p';
        this.queueStats.addCounter(this.queueName, this.type);
    }

    pause() {
        this.paused = true;
        this.emit('pause');
    }

    resume() {
        this.paused = false;
        this.emit('resume');
    }
    
    getBufferCount() {
        return this.buffer.length;
    }

    retryBuffer() {
        this.paused = false;
        // Try to send every element in buffer, if the queue buffer fills again, we stop retrying until this is called again by the next drain event
        while (this.buffer.length > 0 && !this.paused) {
            // const line = buffer.shift();
            this.writeLineToQueue(this.buffer.shift());
        }

        if (this.buffer.length === 0) {
            this.resume();
        } else {
            logger.info(`Records still remaining in ${this.queueName} buffer, waiting for next drain: ${this.buffer.length} records`);
        }
    }

    writeLineToQueue(line, verbose = false) {
        if (this.paused) {
            // logger.info(`Line push to buffer`);
            this.buffer.push(line);
        } else {
            const success = this.channel.sendToQueue(this.queueName, Buffer.from(line, 'utf8'));
            if (!success) {
                this.buffer.push(line);
                logger.info(`--- PRODUCER CHANNEL BUFFER FULL (Q=${this.queueName}) --- [STANDARD] Pausing until drain event`);
                this.pause();
                // logger.info('Push onto buffer');
                // logger.info('Finished push onto buffer');
            } else {
                // if (BASICSTATSCONFIG.verboseQueueWrite) logger.info(`QUEUE: ${server}|${service}|${logId}|${acctNum}|${new Date(parseInt(convertStringDateToMs(startTs)))}|${new Date(parseInt(convertStringDateToMs(endTs)))}|${dur}`);
                if (verbose) logger.info(`QUEUE: ${this.queueName} ::: ${line}`);
                this.queueStats.incrCounter(this.queueName);
            }
        }        
    }
}

class ConsumerQueue extends Queue {
    constructor(queueName, channel, queueStats, consumeCb) {
        super(queueName, channel, queueStats);
        this.consumeCb = consumeCb;
        this.consumerTag = 'xConsumerTagx';
        this.isConsuming = false;
        this.type = 'c';
        // const self = this;
        this.queueStats.addCounter(this.queueName, this.type);
    }

    consumeCbWrapper(msg) {
    	this.queueStats.incrCounter(this.queueName);
        this.channel.ack(msg);
        // return this.consumeCb(msg);
        // console.log(`Callback for msg here: ${msg.content.toString()}`);
        this.consumeCb(msg);
    }

    startConsume() {
        if (!this.isConsuming) {
            this.isConsuming = true;
            // logger.info(`Start consume here`);
            this.channel.consume(
                this.queueName,
                this.consumeCbWrapper.bind(this), // The bind is so we can access this classes 'this' context from the 3rd party invocation of our callback in amqplib consume
                { consumerTag: this.consumerTag }
            );
        }
    }

    async stopConsume() {
        this.isConsuming = false;
        try {
            await this.channel.cancel(this.consumerTag);
        } catch (err) {
            logger.error(`channel.cancel() threw an error: ${err}`);
        }
    }
}

module.exports = {
    QueueManager
    // ProducerQueue,
    // ConsumerQueue
}