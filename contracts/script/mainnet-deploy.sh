#!/usr/bin/env bash
# Runs the LAUNCH.md mainnet procedure for DeployMainnet.s.sol without hand-copied values.
#
#   contracts/script/mainnet-deploy.sh preflight   checks chain, Safe, coordinator, USDC, deployer funds and the record
#   contracts/script/mainnet-deploy.sh stage1      creates the VRF subscription and starts the deployment record
#   contracts/script/mainnet-deploy.sh stage2      deploys, configures and offers both ownerships to the Safe
#   contracts/script/mainnet-deploy.sh resume      finishes an interrupted stage 2 after a successful CREATE
#   contracts/script/mainnet-deploy.sh verify      read-only: validates the deployment and prints the website manifest
#
# Environment: RPC_URL, DEPLOYER_PRIVATE_KEY, SAFE_ADDRESS, TERMS_HASH, FUND_TARGET_WEI. RECORD defaults to
# deployments/mainnet.json. CONFIRMATIONS (default 3) is how deep each receipt must be before the next step.
# Every value the procedure needs (subscription ID, nonce, predicted address, tx hashes) is read from mined receipts
# and written to the record, which later steps require. Nothing here prints the private key.
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RECORD=${RECORD:-$ROOT/deployments/mainnet.json}
CONFIRMATIONS=${CONFIRMATIONS:-3}
COORDINATOR=0xD7f86b4b8Cae7D942340FF628F82735b7a20893a
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
SUBSCRIPTION_CREATED=$(cast keccak "SubscriptionCreated(uint256,address)")
SCRIPT=contracts/script/DeployMainnet.s.sol

die() { echo "mainnet-deploy: $*" >&2; exit 1; }
need() { [ -n "${!1:-}" ] || die "$1 is required"; }
lower() { tr '[:upper:]' '[:lower:]'; }
record_get() { python3 -c "import json,sys; d=json.load(open('$RECORD')); v=d; [v:=v[k] for k in sys.argv[1].split('.')]; print(v)" "$1"; }
record_set() { python3 - "$RECORD" "$1" "$2" <<'EOF'
import json, sys
path, key, value = sys.argv[1:]
d = json.load(open(path))
node = d
*parents, last = key.split(".")
for k in parents: node = node.setdefault(k, {})
node[last] = json.loads(value)
json.dump(d, open(path, "w"), indent=2)
open(path, "a").write("\n")
EOF
}

need RPC_URL
[ "$(cast chain-id --rpc-url "$RPC_URL")" = "1" ] || die "RPC_URL is not Ethereum mainnet (chain 1)"
cd "$ROOT"

deployer() { need DEPLOYER_PRIVATE_KEY; cast wallet address --private-key "$DEPLOYER_PRIVATE_KEY"; }
# True when the address has code. An RPC failure stops the run instead of reading as "no code".
has_code() { local c; c=$(cast code "$1" --rpc-url "$RPC_URL") || die "could not read code at $1"; [ -n "$c" ] && [ "$c" != "0x" ]; }

# Waits until a transaction is CONFIRMATIONS deep and succeeded; prints its receipt JSON.
mined() {
  local receipt
  receipt=$(cast receipt "$1" --confirmations "$CONFIRMATIONS" --rpc-url "$RPC_URL" --json)
  [ "$(echo "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')" = "0x1" ] || die "transaction $1 failed"
  echo "$receipt"
}

LATEST=contracts/broadcast/DeployMainnet.s.sol/1/run-latest.json
# Copies forge's run file next to the record, since every run overwrites run-latest.json. Prints nothing when forge
# sent no transaction (it then writes no file; forge_run removes the previous one first).
keep_run() {
  local kept
  [ -f "$LATEST" ] || return 0
  kept="$(dirname "$RECORD")/$1-$(date -u +%Y%m%dT%H%M%SZ).json"
  cp "$LATEST" "$kept"
  echo "$kept"
}

forge_run() { rm -f "$LATEST"; forge script "$SCRIPT:$1" --root contracts --rpc-url "$RPC_URL" --slow "${@:2}"; }

preflight() {
  need SAFE_ADDRESS; need TERMS_HASH; need FUND_TARGET_WEI
  local who balance threshold
  who=$(deployer)
  has_code "$SAFE_ADDRESS" || die "no Safe at $SAFE_ADDRESS"
  threshold=$(cast call "$SAFE_ADDRESS" "getThreshold()(uint256)" --rpc-url "$RPC_URL")
  [ "$threshold" -ge 2 ] || die "Safe threshold $threshold is below 2"
  for c in $COORDINATOR $USDC; do has_code "$c" || die "no code at $c"; done
  balance=$(cast balance "$who" --rpc-url "$RPC_URL")
  echo "deployer          $who (nonce $(cast nonce "$who" --rpc-url "$RPC_URL"))"
  echo "deployer balance  $(cast from-wei "$balance") ETH; the subscription is funded to $(cast from-wei "$FUND_TARGET_WEI") ETH from it"
  echo "Safe              $SAFE_ADDRESS, $threshold of $(cast call "$SAFE_ADDRESS" "getOwners()(address[])" --rpc-url "$RPC_URL")"
  echo "gas price         $(cast from-wei "$(cast gas-price --rpc-url "$RPC_URL")" gwei) gwei"
  # Wei amounts exceed bash integers.
  python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) > int(sys.argv[2]) else 1)" "$balance" "$FUND_TARGET_WEI" || die "deployer holds less than FUND_TARGET_WEI plus gas"
  if [ -f "$RECORD" ]; then echo "record            $RECORD exists (stage 1 done: subscription $(record_get stage1.subscriptionId))"; else echo "record            none yet; stage1 starts it"; fi
}

stage1() {
  need SAFE_ADDRESS; need TERMS_HASH; need FUND_TARGET_WEI
  [ ! -f "$RECORD" ] || die "$RECORD already exists; a second stage 1 would create another subscription"
  local who run tx receipt subId nonce expected predicted block
  who=$(deployer)
  mkdir -p "$(dirname "$RECORD")"
  forge_run CreateMainnetSubscription --broadcast || { run=$(keep_run stage1-failed); die "stage 1 failed; forge's run file: ${run:-none}. Read its receipt before anything else"; }
  run=$(keep_run stage1)
  [ -n "$run" ] || die "stage 1 sent no transaction"
  tx=$(python3 -c "import json,sys; t=json.load(open(sys.argv[1]))['transactions']; assert len(t) == 1; print(t[0]['hash'])" "$run")
  receipt=$(mined "$tx")
  # The ID comes only from the mined SubscriptionCreated log whose emitter is the coordinator and whose owner is the deployer.
  subId=$(echo "$receipt" | python3 -c "
import json, sys
logs = [l for l in json.load(sys.stdin)['logs'] if l['address'].lower() == '$COORDINATOR'.lower() and l['topics'][0] == '$SUBSCRIPTION_CREATED' and int(l['data'], 16) == int('$who', 16)]
assert len(logs) == 1, 'expected one SubscriptionCreated log for the deployer'
print(int(logs[0]['topics'][1], 16))")
  nonce=$(cast tx "$tx" nonce --rpc-url "$RPC_URL")
  expected=$((nonce + 1))
  predicted=$(cast compute-address "$who" --nonce "$expected" | awk '{print $NF}')
  block=$(echo "$receipt" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["blockNumber"], 16))')
  mkdir -p "$(dirname "$RECORD")"
  python3 - "$RECORD" <<EOF
import json, sys
json.dump({
  "chainId": 1, "deployer": "$who", "safe": "$SAFE_ADDRESS", "termsHash": "$TERMS_HASH", "fundTargetWei": "$FUND_TARGET_WEI",
  "coordinator": "$COORDINATOR", "usdc": "$USDC",
  "stage1": {"tx": "$tx", "block": $block, "nonce": $nonce, "subscriptionId": "$subId", "run": "$(basename "$run")"},
  "expectedNonce": $expected, "predictedRaffle": "$predicted", "stage2": None
}, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
EOF
  echo "stage 1 done: subscription $subId; stage 2 must deploy at $predicted with nonce $expected. Record: $RECORD"
}

stage2_env() {
  export VRF_SUBSCRIPTION_ID SAFE_ADDRESS TERMS_HASH FUND_TARGET_WEI
  VRF_SUBSCRIPTION_ID=$(record_get stage1.subscriptionId)
  SAFE_ADDRESS=$(record_get safe); TERMS_HASH=$(record_get termsHash); FUND_TARGET_WEI=$(record_get fundTargetWei)
}

# Records every stage 2 transaction once it is mined, and the raffle CREATE.
record_stage2() {
  local run=$1 txs
  txs=$(python3 -c "import json,sys; print(json.dumps([{'hash': t['hash'], 'type': t['transactionType'], 'to': t.get('contractAddress') or (t.get('transaction') or {}).get('to')} for t in json.load(open(sys.argv[1]))['transactions']]))" "$run")
  for h in $(echo "$txs" | python3 -c 'import json,sys; print(" ".join(t["hash"] for t in json.load(sys.stdin)))'); do mined "$h" > /dev/null; done
  record_set "stage2.$2" "$(python3 -c "import json,sys; print(json.dumps({'run': sys.argv[2], 'transactions': json.loads(sys.argv[1])}))" "$txs" "$(basename "$run")")"
}

stage2() {
  [ -f "$RECORD" ] || die "run stage1 first"
  [ "$(record_get stage2)" = "None" ] || die "stage 2 already ran; use resume or verify"
  local who expected predicted current run created
  who=$(deployer); expected=$(record_get expectedNonce); predicted=$(record_get predictedRaffle)
  [ "$(echo "$who" | lower)" = "$(record_get deployer | lower)" ] || die "DEPLOYER_PRIVATE_KEY is not the recorded deployer"
  current=$(cast nonce "$who" --rpc-url "$RPC_URL")
  [ "$current" = "$expected" ] || die "deployer nonce is $current, the record expects $expected; see LAUNCH.md step 5 before doing anything"
  stage2_env
  unset RAFFLE_ADDRESS
  DEPLOY_MODE=fresh EXPECTED_NONCE=$expected forge_run DeployMainnet --broadcast || { run=$(keep_run stage2-failed); die "stage 2 stopped part way; forge's run file: ${run:-none}. Settle every transaction it sent, then follow LAUNCH.md step 5 (resume only after the CREATE receipt succeeded)"; }
  run=$(keep_run stage2)
  [ -n "$run" ] || die "stage 2 sent no transaction"
  created=$(python3 -c "import json,sys; c=[t['contractAddress'] for t in json.load(open(sys.argv[1]))['transactions'] if t['transactionType'] == 'CREATE']; assert len(c) == 1; print(c[0])" "$run")
  [ "$(echo "$created" | lower)" = "$(echo "$predicted" | lower)" ] || die "raffle CREATE at $created, not the recorded $predicted"
  record_set stage2 '{}'
  record_stage2 "$run" fresh
  record_set raffle "\"$created\""
  verify
}

resume() {
  [ -f "$RECORD" ] || die "no record; nothing to resume"
  local predicted run
  predicted=$(record_get predictedRaffle)
  has_code "$predicted" || die "no code at the recorded raffle $predicted: the CREATE did not succeed; see LAUNCH.md step 5"
  stage2_env
  [ "$(record_get stage2)" != "None" ] || record_set stage2 '{}'
  DEPLOY_MODE=resume RAFFLE_ADDRESS=$predicted forge_run DeployMainnet --broadcast || { run=$(keep_run resume-failed); die "resume stopped; forge's run file: ${run:-none}"; }
  run=$(keep_run resume)
  record_set raffle "\"$predicted\""
  [ -z "$run" ] || record_stage2 "$run" "resume-$(date -u +%s)"
  verify
}

# Read-only: the resume path's simulation re-checks code, every setting, ownership and the postconditions without
# sending anything, then the website manifest values are read from chain.
verify() {
  [ -f "$RECORD" ] || die "no record"
  local raffle block
  raffle=$(record_get raffle 2>/dev/null || record_get predictedRaffle)
  stage2_env
  DEPLOY_MODE=resume RAFFLE_ADDRESS=$raffle forge_run DeployMainnet > /dev/null || die "the deployment does not validate; rerun without > /dev/null for the reason"
  block=$(python3 -c "
import json, sys
d = json.load(open(sys.argv[1]))
creates = [t['hash'] for run in (d.get('stage2') or {}).values() for t in run['transactions'] if t['type'] == 'CREATE']
print(creates[0] if creates else '')" "$RECORD")
  block=$([ -n "$block" ] && cast receipt "$block" blockNumber --rpc-url "$RPC_URL" || echo "unknown (read the CREATE receipt)")
  echo "verified: raffle $raffle validates against a fresh deployment with these inputs"
  echo "owner $(cast call "$raffle" "owner()(address)" --rpc-url "$RPC_URL"), pending owner $(cast call "$raffle" "pendingOwner()(address)" --rpc-url "$RPC_URL"), paused $(cast call "$raffle" "paused()(bool)" --rpc-url "$RPC_URL")"
  echo "website manifest: address $raffle, runtimeCodeHash $(cast codehash "$raffle" --rpc-url "$RPC_URL"), deploymentBlock $block, expectedOwner $(record_get safe)"
}

case "${1:-}" in
  preflight|stage1|stage2|resume|verify) "$1" ;;
  *) sed -n '2,15p' "$0"; exit 2 ;;
esac
