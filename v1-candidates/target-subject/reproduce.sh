#!/usr/bin/env bash
# Run the candidate v1 target-subject vectors against invinoveritas/verdict-check 0.4.0, fetched at a pinned commit, digest-checked.
# Needs git + Node >= 22. Run from anywhere inside a federation-port checkout.
set -euo pipefail
PIN=44e72e1df868ff2adc17043df1ad2fa973a8f9e6
DIGEST=sha256:252ba0061c1cd4a3f8712ebf41460b5fc388a68f6cbefc2473b6b91c8866feb0
ROOT="$(git -C "$(dirname "$0")" rev-parse --show-toplevel)"
[ -z "$(git -C "$ROOT" status --porcelain -- src)" ] || { echo "src/ modified"; exit 1; }
echo "core unmodified (src/ clean)"
W="$(mktemp -d)"; trap 'rm -rf "$W"' EXIT
git clone -q "$ROOT" "$W/repo"
git clone -q https://github.com/babyblueviper1/preaction-governance-conformance "$W/c" && git -C "$W/c" checkout -q "$PIN"
D="$W/repo/adapters/invinoveritas-verdict"; mkdir -p "$D"
cp "$W/c/integrations/federation-port/invinoveritas-verdict/"{adapter.ts,bip340.ts,manifest.json} "$D/"
cd "$W/repo" && npm ci --silent --include=dev
FLAG="--experimental-strip-types"; node -e 'process.exit(+process.versions.node.split(".")[0] >= 24 ? 0 : 1)' && FLAG=""
GOT=$(node $FLAG --disable-warning=ExperimentalWarning scripts/seal.ts adapters/invinoveritas-verdict | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).artifact_digest))')
[ "$GOT" = "$DIGEST" ] && echo "ok  invinoveritas/verdict-check 0.4.0 $DIGEST" || { echo "digest mismatch: $GOT"; exit 1; }
node $FLAG --disable-warning=ExperimentalWarning v1-candidates/target-subject/gen-vectors.ts >/dev/null
git diff --quiet HEAD -- v1-candidates/target-subject/vectors.json || { echo "vectors.json does not regenerate byte-identical"; exit 1; }
echo "vectors.json regenerates byte-identical"
node $FLAG --disable-warning=ExperimentalWarning --test v1-candidates/target-subject/target-subject.test.ts
