#!/usr/bin/env bash
# Reproduce the v0 four-component composition run (compose/README.md) from a clean clone.
# Fetches federation-port and the three outside components at fixed commits, checks every file
# digest against the values below, then runs compose/composition.test.ts on the unmodified runtime.
# Needs git, shasum or sha256sum, and Node 24 (or 22 with type stripping). The test itself makes
# no request to any remote service: agentavow.com is answered by a stub inside the test.
#
# The fetched components are third-party code and run in the test's own process, with its
# authority. Run this in a disposable environment if that matters to you.
set -euo pipefail

FP_PIN=3a2f6ce405d1c4f86ac8f2591e136deb5dfbb333
AV_REPO=https://github.com/AgentAvow/AgentAvow
AV_PIN=40db5d3f41ae61506503d8ec95a99427dce7e3c2
INV_REPO=https://github.com/babyblueviper1/preaction-governance-conformance
INV_PIN=bcfa6dffe87e367dd5ab1ff78937dbaa8b259e4e
NEN_REPO=https://github.com/ogasurfproject-jpg/horizon-shield
NEN_PIN=6a4581c7e031584ec951621227bffe07e172fb15

HERE="$(cd "$(dirname "$0")" && pwd)"
W="$(mktemp -d)"
trap 'rm -rf "$W"' EXIT
mkdir -p "$W/tmp" && export TMPDIR="$W/tmp"

sha() { if command -v sha256sum >/dev/null; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi; }
expect() { local got; got="$(sha "$1")"; [ "$got" = "$2" ] || { echo "digest mismatch: $1 got $got want $2"; exit 1; }; }

# fetch <repo> <pin> <dir> <path>: only <path> at <pin>
fetch() {
  git init -q "$3" && git -C "$3" remote add origin "$1"
  git -C "$3" config core.sparseCheckout true && echo "$4" > "$3/.git/info/sparse-checkout"
  git -C "$3" fetch -q --depth 1 --filter=blob:none origin "$2" && git -C "$3" checkout -q FETCH_HEAD
  [ "$(git -C "$3" rev-parse HEAD)" = "$2" ] || { echo "pin mismatch in $3"; exit 1; }
}

git clone -q https://github.com/aeoess/federation-port "$W/fp" && git -C "$W/fp" checkout -q "$FP_PIN"
fetch "$AV_REPO" "$AV_PIN" "$W/av" sdk/federation-port-adapter
fetch "$INV_REPO" "$INV_PIN" "$W/inv" integrations/federation-port/invinoveritas-verdict
fetch "$NEN_REPO" "$NEN_PIN" "$W/nen" workers/hs-ledger/nenrin/federation-port/nenrin-conduct-walk

AV="$W/av/sdk/federation-port-adapter"
INV="$W/inv/integrations/federation-port/invinoveritas-verdict"
NEN="$W/nen/workers/hs-ledger/nenrin/federation-port/nenrin-conduct-walk"
cd "$W/fp"
mkdir -p adapters/agentavow-mcp-admission adapters/invinoveritas-verdict adapters/nenrin-conduct-walk test/fixtures/compose
cp "$AV/adapters/agentavow-mcp-admission/adapter.ts" "$AV/adapters/agentavow-mcp-admission/manifest.json" adapters/agentavow-mcp-admission/
cp "$INV/adapter.ts" "$INV/bip340.ts" "$INV/manifest.json" adapters/invinoveritas-verdict/
cp "$NEN/adapter.ts" "$NEN/manifest.json" adapters/nenrin-conduct-walk/
cp "$AV/test/fixtures/tool-manifest-digest-v1-vectors.json" "$INV/test/fixtures/verdicts.json" "$NEN/test/fixtures/walks.json" test/fixtures/compose/
cp "$HERE/composition.test.ts" "$HERE/pins.ts" test/

# The fixtures the test relies on, byte for byte as published at the pins.
expect test/fixtures/compose/tool-manifest-digest-v1-vectors.json 488496079155830caf83593be0cafcb21367f72cd70ea363c2400f40eda72647
expect test/fixtures/compose/verdicts.json be0f646d6f65b4b50680df8b614001ed3f9b3723a85f3c2fa69727730874bd20
expect test/fixtures/compose/walks.json e10ce9fd7904ec972378bdc867e8b145387d4a5a37c8104d81a524b47bab26f3

npm ci --include=dev --silent
FLAG="--experimental-strip-types"; node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' && FLAG=""
# Every component's files hash to its own sealed manifest digest, and that digest is the one expected here.
node $FLAG --disable-warning=ExperimentalWarning test/pins.ts
git diff --quiet -- src && echo "core unmodified (src/ clean)"
node $FLAG --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/composition.test.ts
