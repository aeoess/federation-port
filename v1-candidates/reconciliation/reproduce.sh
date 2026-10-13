#!/usr/bin/env bash
# Run the candidate v1 reconciliation tests (aeoess/federation-port#2) next to the v0 suite.
# Needs git + Node >= 22. Run from anywhere inside a federation-port checkout.
set -euo pipefail
DIGEST=sha256:98e5d2d338c215005c95a4e9cd656cd7b2f2b13c09dc70355dcee61ebe5d81bb
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
cd "$ROOT"
[ -z "$(git status --porcelain -- src)" ] || { echo "src/ modified"; exit 1; }
echo "core unmodified (src/ clean)"
[ -d node_modules ] || npm ci --silent --include=dev
FLAG="--experimental-strip-types"; node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' && FLAG=""
BEFORE=$(sha256sum v1-candidates/reconciliation/executor/manifest.json)
GOT=$(node $FLAG --disable-warning=ExperimentalWarning scripts/seal.ts v1-candidates/reconciliation/executor | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).artifact_digest))')
[ "$BEFORE" = "$(sha256sum v1-candidates/reconciliation/executor/manifest.json)" ] || { echo "sealing changed the manifest"; exit 1; }
[ "$GOT" = "$DIGEST" ] && echo "ok  candidate executor $DIGEST" || { echo "digest mismatch: $GOT"; exit 1; }
node $FLAG --disable-warning=ExperimentalWarning --test --test-concurrency=1 v1-candidates/reconciliation/reconciliation.test.ts
node $FLAG --disable-warning=ExperimentalWarning --test --test-concurrency=1 test/*.test.ts
