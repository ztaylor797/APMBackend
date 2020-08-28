#!/usr/local/bin/perl
use strict;
use warnings;

use lib qw(/u07/app/prod/apm/perl_file_tail/share/perl5/);
use lib qw(/u07/app/prod/apm/perl_file_tail/lib64/perl5/);
use File::Tail;

use Linux::Inotify2;

print "Made it here\n";

my $name = "/net/xcla9571/u01/export/prod/jvm1/log/server.log";

my $file=File::Tail->new(
  name => $name,
  interval => 1,
  maxinterval => 5,
  adjustafter => 10,
  resetafter => 5,
  maxbuf => 50000 // Bytes
);


my $inotify = new Linux::Inotify2;

my $pauseFile = '/u07/app/prod/apm/streaming_stat_parser/state/PAUSE_TAILS.switch';

#my $paused = 1;

#print "Watching for switch file: $pauseFile\n";
#$inotify->watch ($pauseFile, IN_CREATE | IN_DELETE, sub {
#   my $e = shift;
#   print "New file or dir: " . $e->fullname . "\n";
#   if ($e->IN_ACCESS) {
#     print "$e->{w}{name} PAUSE\n";
#     $paused = 1;
#   }
#   if ($e->IN_MODIFY) {
#     print "$e->{w}{name} RESUME\n";
#     $paused = 0;
#   }
#});

while (defined(my $line=$file->read)) {
    print ">>>LINE ::: $line";
    while (-e $pauseFile) {
      sleep 1;
    } 
}
