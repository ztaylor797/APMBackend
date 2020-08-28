
module.exports = (logDir, logFilePrefix) => {

    var colors = require('colors');
    const SNL = require('simple-node-logger');

    // create a rolling file logger based on date/time that fires process events
    const opts = {
        // errorEventName: 'loggerError',
        logDirectory: logDir, // NOTE: folder must exist and be writable...
        fileNamePattern: `${logFilePrefix}.log.<DATE>`,
        dateFormat: 'YYYYMMDD',
        timestampFormat: 'YYYYMMDD HH:mm:ss',
        colorize: true // Custom option
    };

    const manager = SNL.createLogManager(opts);

    colors.setTheme({
        silly: 'rainbow',
        input: 'grey',
        verbose: 'white',
        prompt: 'grey',
        info: 'cyan',
        data: 'grey',
        help: 'cyan',
        warn: 'yellow',
        debug: 'green',
        error: 'red'
    });

    const appender = manager.getAppenders()[0];
    const newline = /^win/.test(process.platform) ? '\r\n' : '\n';

    function colorize(level, msg) {
        if (colors[level])
            return colors[level](msg);
        else
            return msg;
    }

    appender.formatter = function(entry) {
        const fields = appender.formatEntry( entry );

        if (opts.colorize && entry.level) {
            fields[2] = colorize(entry.level, fields[2]);
        }

        fields.push( newline );
        return fields.join( appender.separator );
    };
    
    const log = manager.createLogger();
    global.logger = log;
    // Logger = require('../lib/Logger'),
    // AbstractAppender = SimpleLogger.AbstractAppender,
    // manager = new SimpleLogger();

    // const ColorizedRollingFileAppender = function(options = {}) {
    //     const appender = this,
    //         opts = {
    //             typeName:'JSONAppender'
    //         };

    //     let level = options.level || Logger.STANDARD_LEVELS[1];
    //     let levels = options.levels || Logger.STANDARD_LEVELS;

    //     AbstractAppender.extend( this, opts );

    //     this.write = function(entry) {
    //         var fields = appender.formatEntry( entry );
    //         process.stdout.write( JSON.stringify( fields ) + '\n');
    //     };

    //     this.setLevel = function(level) {
    //         const idx = levels.indexOf(level);
    //         if (idx >= 0) {
    //             level = idx;
    //         }
    //     };
    // };

    // manager.addAppender( new JSONAppender() );
    // const log = manager.createLogger('JsonTest');



    // WINSTON START
    // var winston = require('winston');
    // require('winston-daily-rotate-file');
    // const { createLogger, format, transports } = winston;

    // winston.addColors({
    //     debug: 'green',
    //     info:  'cyan',
    //     silly: 'magenta',
    //     verbose: 'white',
    //     warn:  'yellow',
    //     error: 'red'
    // });
    
    // var transport = new (winston.transports.DailyRotateFile)({
    //     level: 'info',
    //     filename: `${logFilePrefix}.log.%DATE%`,
    //     dirname: logDir,
    //     datePattern: 'YYYYMMDD',
    //     zippedArchive: false,
    //     maxSize: null,
    //     maxFiles: null
    // });
    
    // var logger = createLogger({
    //     level: 'info',
    //     format: format.combine(
    //         format.timestamp({ format: 'YYYYMMDD HH:mm:ss' }),
    //         format.colorize({message: true}),
    //         format.printf(info => `${info.timestamp} ${info.level.toUpperCase()} ::: ${info.message}`)
    //       ),
    //     transports: [
    //         transport
    //     ]
    // });
    // WINSTON END
    
    // global.logger = logger;
}

