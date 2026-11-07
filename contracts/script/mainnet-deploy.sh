#!/usr/bin/env bash
# Runs the LAUNCH.md mainnet procedure for DeployMainnet.s.sol without hand-copied values.
#
#   contracts/script/mainnet-deploy.sh preflight   checks chain, Safe, coordinator, USDC, deployer funds and the record
#   contracts/script/mainnet-deploy.sh stage1      creates the VRF subscription and starts the deployment record
#   contracts/script/mainnet-deploy.sh stage2      deploys, configures and offers both ownerships to the Safe
#   contracts/script/mainnet-deploy.sh resume      finishes an interrupted stage 2 after a successful CREATE
#   contracts/script/mainnet-deploy.sh verify      read-only: checks the mined deployment and prints the website manifest
#
# Environment: RPC_URL, DEPLOYER_PRIVATE_KEY (stage1, stage2, resume), SAFE_ADDRESS, TERMS_HASH and FUND_TARGET_WEI
# (preflight and stage1; later steps read them from the record). RECORD defaults to deployments/mainnet.json.
# CONFIRMATIONS (default 3) is how deep each receipt must be before it is recorded. CREATE_TX names the raffle CREATE
# when an interrupted run left no run file and the RPC cannot search old nonces; it is checked like any other receipt.
# Every value the procedure needs is read from mined receipts and kept in the record, which later steps require.
# Nothing here prints the private key.
set -euo pipefail
# Without this, bash turns -e off inside $(...), so a failing step there would carry on.
shopt -s inherit_errexit

ROOT=$(cd "$(dirname "$0")/../.." && pwd)
RECORD=${RECORD:-$ROOT/deployments/mainnet.json}
CONFIRMATIONS=${CONFIRMATIONS:-3}
COORDINATOR=0xD7f86b4b8Cae7D942340FF628F82735b7a20893a
USDC=0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48
SCRIPT=contracts/script/DeployMainnet.s.sol
LATEST=contracts/broadcast/DeployMainnet.s.sol/1/run-latest.json

MAIN=$$
# A failure inside $(...) only ends that subshell, and set -e ignores it inside a test or an || list. die therefore also
# signals the main process, so a failed read anywhere stops the whole run.
trap 'exit 1' USR1
die() { echo "mainnet-deploy: $*" >&2; [ "$BASHPID" = "$MAIN" ] || kill -USR1 "$MAIN"; exit 1; }
need() { [ -n "${!1:-}" ] || die "$1 is required"; }
lower() { tr '[:upper:]' '[:lower:]'; }
same() { [ "$(echo "$1" | lower)" = "$(echo "$2" | lower)" ]; }
# read_chain LABEL COMMAND...: runs a read and fails the whole run on an error or an empty answer, so nothing is reported
# from a failed read. Only LABEL is printed, never the command's arguments.
read_chain() { local label=$1 v; shift; v=$("$@" 2>/dev/null) || die "could not read $label"; [ -n "$v" ] || die "empty answer for $label"; echo "$v"; }
record_get() { python3 -c "import json,sys; v=json.load(open(sys.argv[2])); [v:=v[k] for k in sys.argv[1].split('.')]; print('' if v is None else v)" "$1" "$RECORD"; }
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
CHAIN=$(read_chain "the chain id" cast chain-id --rpc-url "$RPC_URL")
[ "$CHAIN" = "1" ] || die "RPC_URL is chain $CHAIN, not Ethereum mainnet (chain 1)"
cd "$ROOT"

# Prints plain JSON: some cast versions wrap --json answers in {"schema_version", "data"}.
unwrap_json() { python3 -c 'import json,sys; d=json.loads(sys.argv[1]); d=d["data"] if isinstance(d, dict) and "schema_version" in d and "data" in d else d; print(json.dumps(d))' "$1"; }
# Runs a cast command with --json and prints plain JSON. The command and the parse are separate steps, so a failing
# command fails here whatever the shell options.
cast_json() { local raw; raw=$("$@" --json) || return 1; unwrap_json "$raw"; }
# The deployer address, derived from DEPLOYER_PRIVATE_KEY in the environment, so the key is on no command line.
deployer() {
  need DEPLOYER_PRIVATE_KEY
  read_chain "the deployer address from DEPLOYER_PRIVATE_KEY" node -e 'const { Wallet } = require(process.argv[1]); console.log(new Wallet(process.env.DEPLOYER_PRIVATE_KEY).address)' "$ROOT/web/node_modules/ethers"
}
has_code() { local c; c=$(read_chain "code at $1" cast code "$1" --rpc-url "$RPC_URL"); [ "$c" != "0x" ]; }

# Waits until a transaction is CONFIRMATIONS deep in the canonical chain and prints its receipt JSON; fails on a
# reverted transaction. cast returns an existing receipt without waiting for depth, so depth is counted here against an
# identified head: the head's number and hash are read, the receipt's block hash must be the canonical hash at its
# height, and the hash at the head's height is read again and must still be the head's, so a rollback between the reads
# is not accepted. Every read gets only the time left of RECEIPT_TIMEOUT (default 900 seconds), and the deadline is
# checked again before a receipt is accepted.
mined() {
  local tx=$1 deadline=$((SECONDS + ${RECEIPT_TIMEOUT:-900})) raw receipt number hash head head_number head_hash canonical recheck status wait_for
  left() { local l=$((deadline - SECONDS)); [ "$l" -gt 0 ] || die "transaction $tx is not $CONFIRMATIONS blocks deep in the canonical chain after ${RECEIPT_TIMEOUT:-900}s"; echo "$l"; }
  while :; do
    receipt=""
    if raw=$(timeout "$(left)" cast receipt "$tx" --async --rpc-url "$RPC_URL" --json 2>/dev/null) && [ -n "$raw" ]; then
      receipt=$(unwrap_json "$raw")
      number=$(echo "$receipt" | python3 -c 'import json,sys; n=json.load(sys.stdin).get("blockNumber"); print(int(n, 16) if isinstance(n, str) else (n if n is not None else ""))')
      hash=$(echo "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("blockHash") or "")')
      if [ -n "$number" ] && [ -n "$hash" ]; then
        head=$(read_chain "the latest block" cast_json timeout "$(left)" cast block latest --rpc-url "$RPC_URL")
        head_number=$(echo "$head" | python3 -c 'import json,sys; n=json.load(sys.stdin)["number"]; print(int(n, 16) if isinstance(n, str) else n)')
        head_hash=$(echo "$head" | python3 -c 'import json,sys; print(json.load(sys.stdin)["hash"])')
        if [ $((head_number - number + 1)) -ge "$CONFIRMATIONS" ]; then
          # A failed or empty read here (a rollback can remove the old head's height) means not yet, not accepted.
          canonical=$(timeout "$(left)" cast block "$number" --field hash --rpc-url "$RPC_URL" 2>/dev/null) || canonical=""
          recheck=$(timeout "$(left)" cast block "$head_number" --field hash --rpc-url "$RPC_URL" 2>/dev/null) || recheck=""
          if [ -n "$canonical" ] && [ -n "$recheck" ] && same "$canonical" "$hash" && same "$recheck" "$head_hash" && [ "$SECONDS" -lt "$deadline" ]; then break; fi
        fi
      fi
    fi
    wait_for=$(left)
    sleep $((wait_for < 5 ? wait_for : 5))
  done
  status=$(echo "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin)["status"])')
  [ "$status" = "0x1" ] || [ "$status" = "1" ] || die "transaction $tx failed on chain"
  echo "$receipt"
}

# Copies forge's run file next to the record (every run overwrites run-latest.json). Prints nothing when there is none.
keep_run() {
  local kept
  [ -f "$LATEST" ] || return 0
  kept="$(dirname "$RECORD")/$1-$(date -u +%Y%m%dT%H%M%SZ).json"
  cp "$LATEST" "$kept" || die "could not copy forge's run file to $kept; it is still at $LATEST, so keep it before anything else"
  echo "$kept"
}

# Runs forge with --broadcast in the main shell, its output on the terminal, and sets RUN to the kept run file (empty when
# nothing was sent). If forge fails or is interrupted, keeps whatever run file it wrote before stopping.
# forge runs as a background child that the driver waits on: bash would defer a trap until a foreground forge finished,
# so a signal to the driver alone would leave forge sending. On INT or TERM the driver stops forge, waits for it to exit,
# then keeps its run file. (A background child ignores the terminal's Ctrl-C itself; the driver's trap stops it.)
RUN=""
broadcast() {
  local label=$1 status=0 kept child
  rm -f "$LATEST"
  forge script "$SCRIPT:$2" --root contracts --rpc-url "$RPC_URL" --slow --broadcast >&2 &
  child=$!
  # set -e applies inside trap handlers too, and wait reports the stopped forge as a failure, hence || true.
  trap 'kill -TERM '"$child"' 2>/dev/null || true; wait '"$child"' 2>/dev/null || true; kept=$(keep_run "'"$label"'-interrupted"); echo "mainnet-deploy: interrupted; forge stopped; run file: ${kept:-none}. Settle every transaction it sent before anything else" >&2; exit 130' INT TERM
  wait "$child" || status=$?
  trap - INT TERM
  if [ "$status" -ne 0 ]; then
    kept=$(keep_run "$label-failed")
    die "$label stopped (forge exit $status); run file: ${kept:-none}. Settle every transaction it sent before anything else; LAUNCH.md step 5"
  fi
  RUN=$(keep_run "$label")
}

# The raffle CREATE's provenance: tx, block and address, all from its mined receipt. Only a successful CREATE from the
# recorded deployer at EXPECTED_NONCE that created the recorded address is accepted.
record_create() {
  local tx=$1 receipt tx_json from nonce created block
  receipt=$(mined "$tx")
  tx_json=$(read_chain "transaction $tx" cast_json cast tx "$tx" --rpc-url "$RPC_URL")
  from=$(echo "$tx_json" | python3 -c 'import json,sys; print(json.load(sys.stdin)["from"])')
  nonce=$(echo "$tx_json" | python3 -c 'import json,sys; n=json.load(sys.stdin)["nonce"]; print(int(n, 16) if isinstance(n, str) else n)')
  created=$(echo "$receipt" | python3 -c 'import json,sys; print(json.load(sys.stdin).get("contractAddress") or "")')
  block=$(echo "$receipt" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["blockNumber"], 16))')
  same "$from" "$(record_get deployer)" || die "CREATE $tx was sent by $from, not the recorded deployer"
  [ "$nonce" = "$(record_get expectedNonce)" ] || die "CREATE $tx used nonce $nonce, not EXPECTED_NONCE $(record_get expectedNonce)"
  same "$created" "$(record_get predictedRaffle)" || die "CREATE $tx created ${created:-nothing}, not the recorded $(record_get predictedRaffle)"
  record_set create "{\"tx\": \"$tx\", \"block\": $block, \"address\": \"$created\"}"
}

# Finds the transaction the deployer sent at EXPECTED_NONCE: the first block after stage 1 whose nonce passes it.
find_create() {
  local who expected lo hi mid tx
  who=$(record_get deployer); expected=$(record_get expectedNonce)
  lo=$(record_get stage1.block); hi=$(read_chain "the latest block" cast block-number --rpc-url "$RPC_URL")
  [ "$(read_chain "the deployer nonce at block $hi (needs state history)" cast nonce "$who" --block "$hi" --rpc-url "$RPC_URL")" -gt "$expected" ] || return 1
  while [ $((hi - lo)) -gt 1 ]; do
    mid=$(((lo + hi) / 2))
    if [ "$(read_chain "the deployer nonce at block $mid (needs state history)" cast nonce "$who" --block "$mid" --rpc-url "$RPC_URL")" -gt "$expected" ]; then hi=$mid; else lo=$mid; fi
  done
  tx=$(read_chain "block $hi with transactions" cast_json cast block "$hi" --full --rpc-url "$RPC_URL" | python3 -c "
import json, sys
nonce = lambda n: int(n, 16) if isinstance(n, str) else n
txs = [t['hash'] for t in json.load(sys.stdin)['transactions'] if t['from'].lower() == '$who'.lower() and nonce(t['nonce']) == $expected]
print(txs[0] if txs else '')")
  [ -n "$tx" ] || die "found no transaction at nonce $expected in block $hi"
  echo "$tx"
}

# Makes sure the record names the CREATE, checked against its canonical receipt now: a recorded hash is checked again
# (a reorg can move or drop it), otherwise it comes from a kept run file, CREATE_TX, or a search by nonce.
reconcile_create() {
  local tx=""
  tx=$(record_get create.tx 2>/dev/null || true)
  if [ -n "$tx" ]; then record_create "$tx"; return 0; fi
  tx=${CREATE_TX:-}
  # A run file cut short by an interruption can be unreadable: it is skipped with a note and left in place as evidence.
  [ -n "$tx" ] || tx=$(python3 - "$(dirname "$RECORD")" <<'EOF'
import glob, json, os, sys
for path in sorted(glob.glob(os.path.join(sys.argv[1], "stage2*.json")) + glob.glob(os.path.join(sys.argv[1], "resume*.json"))):
    try:
        transactions = json.load(open(path)).get("transactions", [])
    except (OSError, ValueError):
        print(f"mainnet-deploy: note: {os.path.basename(path)} is unreadable (cut short?); kept, not used", file=sys.stderr)
        continue
    for t in transactions:
        if t.get("transactionType") == "CREATE" and t.get("hash"):
            print(t["hash"]); sys.exit()
EOF
)
  [ -n "$tx" ] || tx=$(find_create) || die "the deployer has not used EXPECTED_NONCE; nothing was created. A fresh stage2 can run"
  record_create "$tx"
}

# Records every transaction of a kept run file once it is mined.
record_run() {
  local run=$1 key=$2 txs
  txs=$(python3 -c "import json,sys; print(json.dumps([{'hash': t['hash'], 'type': t['transactionType'], 'function': t.get('function')} for t in json.load(open(sys.argv[1]))['transactions']]))" "$run")
  for h in $(echo "$txs" | python3 -c 'import json,sys; print(" ".join(t["hash"] for t in json.load(sys.stdin)))'); do mined "$h" > /dev/null; done
  record_set "runs.$key" "$(python3 -c "import json,sys; print(json.dumps({'run': sys.argv[2], 'transactions': json.loads(sys.argv[1])}))" "$txs" "$(basename "$run")")"
}

stage_env() {
  export VRF_SUBSCRIPTION_ID SAFE_ADDRESS TERMS_HASH FUND_TARGET_WEI
  VRF_SUBSCRIPTION_ID=$(record_get stage1.subscriptionId)
  SAFE_ADDRESS=$(record_get safe); TERMS_HASH=$(record_get termsHash); FUND_TARGET_WEI=$(record_get fundTargetWei)
}

preflight() {
  need SAFE_ADDRESS; need TERMS_HASH; need FUND_TARGET_WEI
  local who balance threshold owners nonce pending gas
  who=$(deployer)
  has_code "$SAFE_ADDRESS" || die "no Safe at $SAFE_ADDRESS"
  threshold=$(read_chain "the Safe threshold" cast call "$SAFE_ADDRESS" "getThreshold()(uint256)" --rpc-url "$RPC_URL")
  [ "$threshold" -ge 2 ] || die "Safe threshold $threshold is below 2"
  owners=$(read_chain "the Safe owners" cast call "$SAFE_ADDRESS" "getOwners()(address[])" --rpc-url "$RPC_URL")
  for c in $COORDINATOR $USDC; do has_code "$c" || die "no code at $c"; done
  ! has_code "$who" || die "the deployer $who has code (an EIP-7702 delegation?); use a plain key"
  nonce=$(read_chain "the deployer nonce" cast nonce "$who" --rpc-url "$RPC_URL")
  pending=$(read_chain "the deployer pending nonce" cast nonce "$who" --block pending --rpc-url "$RPC_URL")
  [ "$nonce" = "$pending" ] || die "the deployer has pending transactions (nonce $nonce, pending $pending); settle them first"
  balance=$(read_chain "the deployer balance" cast balance "$who" --rpc-url "$RPC_URL")
  gas=$(read_chain "the gas price" cast gas-price --rpc-url "$RPC_URL")
  echo "deployer          $who (nonce $nonce, no pending transactions, no code)"
  echo "deployer balance  $(cast from-wei "$balance") ETH; the subscription is funded to $(cast from-wei "$FUND_TARGET_WEI") ETH from it"
  echo "Safe              $SAFE_ADDRESS, $threshold of $owners"
  echo "gas price         $(cast from-wei "$gas" gwei) gwei; deployment uses about 5.9M gas, $(cast from-wei "$((gas * 5900000))") ETH now"
  # Wei amounts exceed bash integers.
  python3 -c "import sys; sys.exit(0 if int(sys.argv[1]) > int(sys.argv[2]) + int(sys.argv[3]) * 8_000_000 else 1)" "$balance" "$FUND_TARGET_WEI" "$gas" \
    || die "the deployer holds less than FUND_TARGET_WEI plus 8M gas at the current price"
  if [ -f "$RECORD" ]; then echo "record            $RECORD exists (subscription $(record_get stage1.subscriptionId))"; else echo "record            none yet; stage1 starts it"; fi
}

stage1() {
  need SAFE_ADDRESS; need TERMS_HASH; need FUND_TARGET_WEI
  [ ! -f "$RECORD" ] || die "$RECORD already exists; a second stage 1 would create another subscription"
  local who run tx receipt subId nonce expected predicted block
  who=$(deployer)
  [ "$(read_chain "the deployer nonce" cast nonce "$who" --rpc-url "$RPC_URL")" = "$(read_chain "the deployer pending nonce" cast nonce "$who" --block pending --rpc-url "$RPC_URL")" ] \
    || die "the deployer has a pending transaction; settle it first"
  mkdir -p "$(dirname "$RECORD")"
  broadcast stage1 CreateMainnetSubscription
  run=$RUN
  [ -n "$run" ] || die "stage 1 sent no transaction"
  tx=$(python3 -c "import json,sys; t=json.load(open(sys.argv[1]))['transactions']; assert len(t) == 1; print(t[0]['hash'])" "$run")
  receipt=$(mined "$tx")
  # The ID comes only from the mined SubscriptionCreated log whose emitter is the coordinator and whose owner is the deployer.
  subId=$(echo "$receipt" | python3 -c "
import json, sys
topic = '$(cast keccak "SubscriptionCreated(uint256,address)")'
logs = [l for l in json.load(sys.stdin)['logs'] if l['address'].lower() == '$COORDINATOR'.lower() and l['topics'][0] == topic and int(l['data'], 16) == int('$who', 16)]
assert len(logs) == 1, 'expected one SubscriptionCreated log for the deployer'
print(int(logs[0]['topics'][1], 16))")
  nonce=$(read_chain "the stage 1 nonce" cast tx "$tx" nonce --rpc-url "$RPC_URL")
  expected=$((nonce + 1))
  predicted=$(read_chain "the predicted CREATE address" cast compute-address "$who" --nonce "$expected" | awk '{print $NF}')
  block=$(echo "$receipt" | python3 -c 'import json,sys; print(int(json.load(sys.stdin)["blockNumber"], 16))')
  python3 - "$RECORD" <<EOF
import json, sys
json.dump({
  "chainId": 1, "deployer": "$who", "safe": "$SAFE_ADDRESS", "termsHash": "$TERMS_HASH", "fundTargetWei": "$FUND_TARGET_WEI",
  "coordinator": "$COORDINATOR", "usdc": "$USDC",
  "stage1": {"tx": "$tx", "block": $block, "nonce": $nonce, "subscriptionId": "$subId", "run": "$(basename "$run")"},
  "expectedNonce": $expected, "predictedRaffle": "$predicted", "create": None, "runs": {}
}, open(sys.argv[1], "w"), indent=2)
open(sys.argv[1], "a").write("\n")
EOF
  echo "stage 1 done: subscription $subId; stage 2 must deploy at $predicted with nonce $expected. Record: $RECORD"
}

stage2() {
  [ -f "$RECORD" ] || die "run stage1 first"
  [ -z "$(record_get create)" ] || die "the raffle CREATE is already recorded; use resume or verify"
  local who expected current run created
  who=$(deployer); expected=$(record_get expectedNonce)
  same "$who" "$(record_get deployer)" || die "DEPLOYER_PRIVATE_KEY is not the recorded deployer"
  current=$(read_chain "the deployer nonce" cast nonce "$who" --rpc-url "$RPC_URL")
  [ "$current" = "$expected" ] || die "deployer nonce is $current, the record expects $expected; run resume, which checks the CREATE (LAUNCH.md step 5)"
  [ "$(read_chain "the deployer pending nonce" cast nonce "$who" --block pending --rpc-url "$RPC_URL")" = "$expected" ] || die "the deployer has a pending transaction; settle it first"
  stage_env
  unset RAFFLE_ADDRESS
  export DEPLOY_MODE=fresh EXPECTED_NONCE=$expected
  broadcast stage2 DeployMainnet
  run=$RUN
  [ -n "$run" ] || die "stage 2 sent no transaction"
  created=$(python3 -c "import json,sys; c=[t['hash'] for t in json.load(open(sys.argv[1]))['transactions'] if t['transactionType'] == 'CREATE']; assert len(c) == 1; print(c[0])" "$run")
  record_create "$created"
  record_run "$run" stage2
  verify
}

resume() {
  [ -f "$RECORD" ] || die "no record; nothing to resume"
  local who run
  who=$(deployer)
  same "$who" "$(record_get deployer)" || die "DEPLOYER_PRIVATE_KEY is not the recorded deployer"
  [ "$(read_chain "the deployer nonce" cast nonce "$who" --rpc-url "$RPC_URL")" = "$(read_chain "the deployer pending nonce" cast nonce "$who" --block pending --rpc-url "$RPC_URL")" ] \
    || die "the deployer has a pending transaction; settle it first"
  reconcile_create
  has_code "$(record_get create.address)" || die "no code at the recorded raffle"
  stage_env
  export DEPLOY_MODE=resume RAFFLE_ADDRESS
  RAFFLE_ADDRESS=$(record_get create.address)
  broadcast resume DeployMainnet
  run=$RUN
  [ -z "$run" ] || record_run "$run" "resume-$(date -u +%s)"
  verify
}

# Read-only. DeployMainnet.verify() checks the mined state (code against a simulated fresh deployment, every setting,
# native billing, the sole consumer, the funding target, ownership offered to or held by the Safe) and takes no missing
# step. After launch (the Safe owns the raffle and has unpaused it) the pause flag and terms hash are the Safe's, so
# they are reported, not required. The website manifest is printed only for a recorded, successful CREATE and complete
# reads.
verify() {
  [ -f "$RECORD" ] || die "no record"
  reconcile_create
  local raffle block owner pending paused terms codehash
  raffle=$(record_get create.address); block=$(record_get create.block)
  stage_env
  DEPLOYER_ADDRESS=$(record_get deployer) RAFFLE_ADDRESS=$raffle \
    forge script "$SCRIPT:DeployMainnet" --sig "verify()" --root contracts --rpc-url "$RPC_URL" > /tmp/mainnet-verify.log 2>&1 \
    || { tail -20 /tmp/mainnet-verify.log >&2; die "the deployment does not verify; the reason is above"; }
  owner=$(read_chain "the raffle owner" cast call "$raffle" "owner()(address)" --rpc-url "$RPC_URL")
  pending=$(read_chain "the raffle pending owner" cast call "$raffle" "pendingOwner()(address)" --rpc-url "$RPC_URL")
  paused=$(read_chain "the raffle pause flag" cast call "$raffle" "paused()(bool)" --rpc-url "$RPC_URL")
  terms=$(read_chain "the raffle terms hash" cast call "$raffle" "termsHash()(bytes32)" --rpc-url "$RPC_URL")
  codehash=$(read_chain "the raffle code hash" cast codehash "$raffle" --rpc-url "$RPC_URL")
  [[ "$codehash" =~ ^0x[0-9a-fA-F]{64}$ ]] || die "unexpected code hash $codehash"
  same "$terms" "$(record_get termsHash)" || echo "note: the raffle terms hash is $terms; the record has $(record_get termsHash)" >&2
  echo "verified: $raffle (owner $owner, pending owner $pending, paused $paused)"
  echo "website manifest: address $raffle, runtimeCodeHash $codehash, deploymentBlock $block, expectedOwner $(record_get safe)"
}

case "${1:-}" in
  preflight|stage1|stage2|resume|verify) "$1" ;;
  *) sed -n '2,16p' "$0"; exit 2 ;;
esac
