#!/bin/sh

# Starts the built image on its own platform and proves that the native Askar,
# AnonCreds, Indy VDR and FFI libraries load and that Askar can generate a key.
# The JavaScript is platform-independent; these libraries are not.

set -eu

if [ "$#" -ne 2 ]; then
  echo "usage: $0 <image> <expected-node-arch>" >&2
  exit 2
fi

image=$1
expected_arch=$2

check="const v={arch:process.arch};\
const k=require('@openwallet-foundation/askar-nodejs').askarNodeJS;v.askar=k.version();\
v.key=!!k.keyGenerate({algorithm:'ed25519',keyBackend:'software'});\
v.anoncreds=require('@hyperledger/anoncreds-nodejs').anoncredsNodeJS.version();\
v.indyVdr=require('@hyperledger/indy-vdr-nodejs').indyVdrNodeJS.version();\
v.ffi=typeof require('@2060.io/ffi-napi').Library;\
console.log(JSON.stringify(v))"

result=$(docker run --rm --network none --entrypoint node "$image" -e "$check" | tail -n 1)
printf '%s\n' "$result" | jq -e --arg arch "$expected_arch" '
  .arch == $arch and .key == true and .ffi == "function" and
  (.askar | type == "string" and length > 0) and
  (.anoncreds | type == "string" and length > 0) and
  (.indyVdr | type == "string" and length > 0)
' >/dev/null || {
  echo "native library check failed: $result" >&2
  exit 1
}
echo "native libraries load on $expected_arch: $result"
