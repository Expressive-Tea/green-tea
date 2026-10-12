#!/bin/sh
set -e
cd "$(dirname "$0")"
run() { docker run --rm --cpuset-cpus 6,7,14,15 --user 1000:1000 -e HOME=/tmp -v "$PWD":/w -w /w -e LOOKUP_ROUTERS="$2" -e LOOKUP_RUNS=16 -e LOOKUP_ROUNDS=21 -e LOOKUP_OUT="$1" -e LOOKUP_COMMIT=ed19f16c70bcc70bd762c627d8d2dd78645a6c4d -e LOOKUP_HOST=jarvis -e LOOKUP_CPUSET=6,7,14,15 -e LOOKUP_IMAGE="$(docker image inspect node:22 --format '{{.Id}}')" node:22 node --import tsx bench/lookup.ts; }
echo "d4 before: $(date -u +%FT%TZ) $(uptime)" > out/load.txt
run out/lookup-raw.json oracle=test/router-parity/oracle.ts,radix=src/http/router.ts > out/lookup-summary.txt 2> out/lookup-stderr.txt
echo "d4 after / aa before: $(date -u +%FT%TZ) $(uptime)" >> out/load.txt
run out/aa-raw.json oracle=test/router-parity/oracle.ts,oracle-copy=test/router-parity/oracle-copy.ts > out/aa-summary.txt 2> out/aa-stderr.txt
echo "aa after: $(date -u +%FT%TZ) $(uptime)" >> out/load.txt
