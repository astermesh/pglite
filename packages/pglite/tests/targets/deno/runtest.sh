#!/bin/bash
rm -rf ./pgdata-test ./node_modules
mkdir -p ./node_modules/@astermesh/pglite/dist
cp ../../../package.json ./node_modules/@astermesh/pglite/package.json
cp -Rf ../../../dist/* node_modules/@astermesh/pglite/dist/
TZ=UTC deno test --allow-read --allow-write --allow-env --allow-sys --node-modules-dir=manual ./*.test.deno.js
