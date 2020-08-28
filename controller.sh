#!/usr/bin/ksh

STAT_DIR=/u07/app/prod/apm/streaming_stat_parser

Usage() {
  echo "Usage: $0 start|stop|restart"
  exit 2
}

MODE=$1
QUIET=$2
if [ "$MODE" != "start" -a "$MODE" != "stop" -a "$MODE" != "restart" ]; then
  Usage
fi

if [ "$MODE" == "start" ]; then
  APM_PID=$(ps -fu $(whoami) | egrep "apm_manager.js" | egrep -v "grep|tail|vim" | awk '{print $2}')
  if [ "$APM_PID" != "" ]; then
    if [ "$QUIET" != "quiet" ]; then
      echo "APM manager is already running via PID: $APM_PID"
      ps -fp $APM_PID
    fi
    exit 3
  fi
  date
  nohup /usr/bin/node --expose-gc --inspect=9259 $STAT_DIR/apm_manager.js > $STAT_DIR/logs/apm_manager.start.log 2>&1 &
  RC=$?
  PID=$!
  MSG=""
  if [ $RC -ne 0 ]; then
    MSG="There was an issue starting the APM manager. RC:$RC PID:$PID"
    echo "$MSG"
    echo "$MSG" | /u05/prod/bin/maildist -s "$(whoami)@$(hostname -s): APM Controller" -z
  else
    echo "APM manager started successfully! RC:$RC PID:$PID"
  fi
  
elif [ "$MODE" == "stop" ]; then
  APM_PID=$(ps -fu $(whoami) | egrep "apm_manager.js" | egrep -v "grep|tail|vim" | awk '{print $2}')
  if [ "$APM_PID" == "" ]; then
    echo "Could not find PID to kill."
    exit 1
  else
    echo "Gracefully killing PID: $APM_PID"
    echo "Please note this only stops the controller, not the child modules. Starting the controller again will restart the children."
    kill $APM_PID
    sleep 2
    APM_PID=$(ps -fu $(whoami) | egrep "apm_manager.js" | egrep -v "grep|tail|vim" | awk '{print $2}')
    if [ "$APM_PID" != "" ]; then
      echo "Kill unsuccessful, trying kill -9 $APM_PID"
      kill -9 $APM_PID
      sleep 2
      APM_PID=$(ps -fu $(whoami) | egrep "apm_manager.js" | egrep -v "grep|tail|vim" | awk '{print $2}')
      if [ "$APM_PID" != "" ]; then
        MSG="Force kill unsuccessful. Process won't die. PID: $APM_PID"
        echo "$MSG"
        echo "$MSG" | /u05/prod/bin/maildist -s "$(whoami)@$(hostname -s): APM Controller" -z
        exit 9
      else
        echo "Force kill PID was successful!"
        exit 0
      fi
    else
      echo "PID killed!"
      exit 0
    fi
  fi
elif [ "$MODE" == "restart" ]; then
  $0 stop
  if [ $? -ne 9 ]; then
    $0 start
  fi
else
  Usage
fi
