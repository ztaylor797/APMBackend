#!/usr/bin/ksh
/u07/app/prod/apm/rabbitmq/rabbitmq_server-3.7.14/sbin/rabbitmqctl list_queues name messages_ram message_bytes_ram messages_persistent message_bytes_persistent memory arguments durable | awk '
{if ($1 ~ /name/) printf "%-20s %12s %22s %20s %29s %12s  %-10s %-9s\n", $1, $2, $3"(MB)", $4, $5"(MB)", $6"(MB)", $7, $8; 
else if ($1 ~ /s4.*/) printf "%-20s %12s %22.1f %20s %29.1f %12.1f  %-10s %-9s\n", $1, $2, $3/1024/1024, $4, $5/1024/1024, $6/1024/1024, $7, $8; 
else print}'
