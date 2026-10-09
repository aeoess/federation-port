#!/usr/bin/env bash
# Run the candidate v1 target-coverage vectors against invinoveritas/verdict-check 0.3.0, fetched at a pinned commit, digest-checked.
# Needs git + Node >= 22. Run from anywhere inside a federation-port checkout.
set -euo pipefail
PIN=8c1aea50a0902ca2cf6e2bab1b5e0f1c59de7719
DIGEST=sha256:126160033d88056f16ec2f67c6bf3ee8c4d66fcef11303b34642955b3a16281f
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
git clone -q https://github.com/babyblueviper1/preaction-governance-conformance "$W/c" && git -C "$W/c" checkout -q "$PIN"
D="$ROOT/adapters/invinoveritas-verdict"; mkdir -p "$D"
cp "$W/c/integrations/federation-port/invinoveritas-verdict/"{adapter.ts,bip340.ts,manifest.json} "$D/"
cd "$ROOT" && npm ci --silent
FLAG="--experimental-strip-types"; node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' && FLAG=""
GOT=$(node $FLAG --disable-warning=ExperimentalWarning scripts/seal.ts adapters/invinoveritas-verdict | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).artifact_digest))')
[ "$GOT" = "$DIGEST" ] && echo "ok  invinoveritas/verdict-check 0.3.0 $DIGEST" || { echo "digest mismatch: $GOT"; exit 1; }
git diff --quiet -- src && echo "core unmodified (src/ clean)"
node $FLAG --disable-warning=ExperimentalWarning v1-candidates/target-coverage/gen-vectors.ts >/dev/null && git diff --quiet -- v1-candidates/target-coverage/vectors.json && echo "vectors.json regenerates byte-identical"
node $FLAG --disable-warning=ExperimentalWarning --test v1-candidates/target-coverage/target-coverage.test.ts
