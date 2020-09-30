APM Backend Documentation
====================

# About

This project spins up several javascript modules that read a set of 1 or more WildFly JVMs' logs and parses out timing and performance related information regarding the web services used. This includes JMX data from the JVM, datasource node usage, and VM statistics like CPU load. This data is processed in realtime and uses RabbitMQ for interprocess communication. Algorithms are applied to the data to determine if performance has degraded (automatic baselining). If alert conditions are met, it will email and page out to the configured users.

This project is in need of a refactor and general cleanup due to time constraints when initially developing it.

The APM manager process itself manages all of these child modules. It constantly monitors their memory and swap usage. It can force garbage collection and will automatically restart child modules if they are killed by the OS.

All of this data is then pushed to a postgres database. From there, we have a separate Grafana instance set up with many dashboards and additional alerts to easily visualize this data.

# Usage

### Manager

	cd $REPO_CHECKED_OUT_DIR
	./controller.sh start|stop|restart

This will start up the apm_manager*.js file which manages all of the necessary modules.
It also monitors disk space, process memory usage, and unexpected exits.

* _NOTE_ Stopping the controller will not stop the modules it spins up. However, once the manager is restarted, it will automatically gracefully shutdown all previous child modules and restart them. If you want to shutdown everything, for the moment, they must be killed manually. Kill rather than kill -9 is preferred. Please check for instances of perl_tail after as it is possible for their subprocesses to not be killed.

![APM Diagram](ApplicationPerformanceMonitorV2.0.jpeg?raw=true "APM Diagram")
