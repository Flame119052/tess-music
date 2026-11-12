#!/bin/zsh
# Sum CPU% and memory (RSS, MB) of the main Spotify app and its helpers (not the Lab copy), sampled N times.
n=${1:-5}
for i in $(seq $n); do
  ps -axo pid=,%cpu=,rss=,command= | grep -E '/Applications/Spotify.app/' | grep -v grep \
    | awk '{cpu+=$2; rss+=$3} END {printf "cpu %.1f%%  mem %.0f MB  procs %d\n", cpu, rss/1024, NR}'
  sleep 2
done
