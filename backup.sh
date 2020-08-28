#!/usr/bin/ksh

DIR=/u07/app/prod/apm/streaming_stat_parser
BKUP_DIR=$DIR/js_bkups

TODAY=$(date +%Y%m%d%H)

for i in $(ls -1 $DIR/*js); do 
  cp $i $BKUP_DIR/$(basename $i).$TODAY
done
