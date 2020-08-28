#!/usr/local/bin/perl -w
# 20200103 - ztaylo

use strict;
use warnings;

# Locally installed perl module, if File::Tail is installed globally, this line isn't needed
use lib qw(/u07/app/prod/apm/perl_file_tail/share/perl5/);

# ztaylo modified the Tail.pm file in this library to get rid of uninitialized errors on inodes since inodes aren't available on net-mounted files
use File::Tail;

my $num_args = $#ARGV + 1;
if ($num_args != 2) {
    print STDERR "\nUsage: perl_tail.pl \$file_fullpath \$pause_file_fullpath\n\n";
    exit;
}

my $filename = $ARGV[0];
my $pauseFile = $ARGV[1];

#my $name = "/net/xcla9571/u01/export/prod/jvm1/log/server.log";

# See documentation here: https://metacpan.org/pod/File::Tail
my $file=File::Tail->new(
  name => $filename,
  maxinterval => 5,
  interval => 2,
  adjustafter => 10,
  #resetafter => 5,
  maxbuf => 100000 # Bytes
);

while (defined(my $line=$file->read)) {
    print STDOUT "$line";
    while (-e $pauseFile) {
        # print STDERR "sleeping...";
    #   sleep rand(1) + 1;
    # Sleep for random time between 1 and 2 seconds
      select(undef, undef, undef, rand(1) + 1.0);
    }
}
