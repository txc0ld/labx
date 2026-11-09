#!/usr/bin/env bash
# Offline tests for contracts/script/mainnet-deploy.sh. fake.py stands in for cast, forge and node, so nothing here
# reaches a network or needs a key. Each test runs the driver in its own temporary tree.
#
#   contracts/test/mainnet-deploy/run.sh [DRIVER]    DRIVER defaults to contracts/script/mainnet-deploy.sh
set -uo pipefail

HERE=$(cd "$(dirname "$0")" && pwd)
DRIVER=${1:-$HERE/../../script/mainnet-deploy.sh}
REAL_CAST=$(command -v cast) || { echo "cast is required for its offline helpers (keccak, compute-address)"; exit 1; }
export REAL_CAST
SAFE=0x00000000000000000000000000000000000000a5
TERMS=0x60b0227346cc2217a96c89385ca06119826c2d8493afe9134974c0324db0c06a
passed=0 failed=0

# A new tree with the driver, the fakes first on PATH, and a chain where the deployer's next nonce is 18.
fresh() {
  ROOT=$(mktemp -d)
  mkdir -p "$ROOT/contracts/script" "$ROOT/bin" "$ROOT/deployments"
  cp "$DRIVER" "$ROOT/contracts/script/mainnet-deploy.sh"
  for tool in cast forge node sleep; do ln -s "$HERE/fake.py" "$ROOT/bin/$tool"; done
  export FAKE_CHAIN=$ROOT/chain.json RECORD=$ROOT/deployments/mainnet.json
  LATEST=$ROOT/contracts/broadcast/DeployMainnet.s.sol/1/run-latest.json
  cat > "$FAKE_CHAIN" <<JSON
{"head": 100, "nonce": 18, "counter": 0, "txs": {}, "plan": [], "sent": [], "done": [], "safe": "$SAFE", "terms": "$TERMS",
 "code": {"$SAFE": "0x60", "0xd7f86b4b8cae7d942340ff628f82735b7a20893a": "0x60", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48": "0x60"}}
JSON
}

# driver COMMAND...: the driver with the fakes first on PATH. drive runs it with its output in $ROOT/out and its exit
# status in $status; the braces keep bash's own "Killed" notice for a killed driver out of the test output.
driver() {
  env PATH="$ROOT/bin:$PATH" RPC_URL=http://fake.invalid DEPLOYER_PRIVATE_KEY=fake SAFE_ADDRESS=$SAFE TERMS_HASH=$TERMS \
    FUND_TARGET_WEI=0 RECEIPT_TIMEOUT=2 bash "$ROOT/contracts/script/mainnet-deploy.sh" "$@"
}
drive() {
  { driver "$@" > "$ROOT/out" 2>&1; status=$?; } 2> /dev/null
}

# chain EXPRESSION: evaluates Python over the chain state `d` and saves it. record EXPRESSION: prints one over the record.
chain() { python3 -c 'import json,os,sys; p=os.environ["FAKE_CHAIN"]; d=json.load(open(p)); exec(sys.argv[1]); open(p,"w").write(json.dumps(d))' "$1"; }
record() { python3 -c 'import json,os,sys; d=json.load(open(os.environ["RECORD"])); print(eval(sys.argv[1]))' "$1"; }
plan() { chain "d['plan'] = '$*'.split()"; }
sends() { python3 -c 'import json,os,sys; print(sum(s.startswith(sys.argv[1]) for s in json.load(open(os.environ["FAKE_CHAIN"]))["sent"]))' "$1"; }
subscriptions() { python3 -c 'import json,os; print(sum(t["function"] == "createSubscription()" and t["block"] is not None and not t.get("dropped") for t in json.load(open(os.environ["FAKE_CHAIN"]))["txs"].values()))'; }
creates() { python3 -c 'import json,os,sys; print(" ".join(h for h, t in json.load(open(os.environ["FAKE_CHAIN"]))["txs"].items() if t["created"] and (t["block"] is not None) == (sys.argv[1] == "mined")))' "$1"; }

# is WHAT ACTUAL EXPECTED, says OUTPUT-PATTERN: assertions that mark the running test as failed.
is() { [ "$2" = "$3" ] || { echo "    $1: got '$2', want '$3'"; ok=1; }; }
says() { grep -q -- "$1" "$ROOT/out" || { echo "    output lacks '$1':"; sed 's/^/      /' "$ROOT/out" | tail -5; ok=1; }; }

run() {
  ok=0
  "$1"
  if [ "$ok" = 0 ]; then passed=$((passed + 1)); echo "PASS $1"; else failed=$((failed + 1)); echo "FAIL $1"; fi
  rm -rf "$ROOT"
}

stage1_done() { fresh; drive stage1; is "stage1 exit" "$status" 0; }

# --- the whole procedure ---

test_full_run_records_every_step_and_verifies() {
  fresh
  drive preflight; is "preflight exit" "$status" 0; says "record            none yet"
  drive stage1; is "stage1 exit" "$status" 0
  is "stage 1 status" "$(record 'd["stage1"]["status"]')" mined
  is "subscription from the mined log" "$(record 'd["stage1"]["subscriptionId"]')" 4242
  is "expected nonce" "$(record 'd["expectedNonce"]')" 19
  drive stage1; is "second stage1 refused" "$status" 1; says "already exists"
  drive stage2; is "stage2 exit" "$status" 0; says "website manifest"
  is "recorded CREATE" "$(record 'd["create"]["tx"]')" "$(creates mined)"
  is "recorded stage 2 transactions" "$(record 'len(d["runs"]["stage2"]["transactions"])')" 5
  drive stage2; is "second stage2 refused" "$status" 1; says "already recorded"
  drive resume; is "resume with nothing left" "$status" 0
  drive verify; is "verify exit" "$status" 0
  is "createSubscription broadcasts" "$(sends CreateMainnetSubscription)" 1
  is "subscriptions created" "$(subscriptions)" 1
}

# --- E1: a stage 1 transaction is recorded before anything waits for it ---

test_e1_failed_read_while_waiting_does_not_send_stage1_again() {
  fresh
  FAKE_FAIL=block drive stage1
  is "stage1 exit on a failed read" "$status" 1; says "could not read the latest block"
  is "record after the failed read" "$(record 'd["stage1"]["status"]')" pending
  drive stage1; is "rerun exit" "$status" 0; says "waiting for the recorded stage 1 transaction"
  is "stage 1 status" "$(record 'd["stage1"]["status"]')" mined
  is "createSubscription broadcasts" "$(sends CreateMainnetSubscription)" 1
}

test_e1_forge_failure_after_sending_is_recorded_as_pending() {
  fresh; plan fail
  drive stage1; is "stage1 exit" "$status" 1; says "recorded as pending"
  drive stage2; is "stage2 before stage 1 finishes" "$status" 1; says "stage 1 has not finished"
  drive stage1; is "rerun exit" "$status" 0
  is "createSubscription broadcasts" "$(sends CreateMainnetSubscription)" 1
  is "subscriptions created" "$(subscriptions)" 1
}

test_e1_dropped_stage1_is_sent_again_at_the_same_nonce_only() {
  fresh; plan dropped
  drive stage1; is "stage1 exit" "$status" 1
  local dropped; dropped=$(record 'd["stage1"]["tx"]')
  drive stage1; is "rerun exit" "$status" 0; says "sending stage 1 again"
  is "stage 1 nonce" "$(record 'd["stage1"]["nonce"]')" 18
  [ "$(record 'd["stage1"]["tx"]')" != "$dropped" ] || { echo "    the record still names the dropped transaction"; ok=1; }
  is "createSubscription broadcasts" "$(sends CreateMainnetSubscription)" 2
  is "subscriptions created" "$(subscriptions)" 1
}

test_e1_pending_stage1_is_waited_for_not_replaced() {
  fresh; plan pending
  drive stage1; is "stage1 exit while pending" "$status" 1; says "is not 3 blocks deep"
  drive stage1; is "rerun while still pending" "$status" 1; says "waiting for the recorded stage 1 transaction"
  chain 'd["head"] += 1; [t.update(block=d["head"]) for t in d["txs"].values()]; d["head"] += 5'
  drive stage1; is "rerun once mined" "$status" 0
  is "createSubscription broadcasts" "$(sends CreateMainnetSubscription)" 1
}

test_e1_interrupted_stage1_is_recorded_and_forge_is_stopped() {
  fresh; plan hang
  driver stage1 > "$ROOT/out" 2>&1 &
  local job=$!
  until [ -f "$LATEST" ]; do sleep 0.1; done
  # The hangup goes to the driver itself, which is the job's child.
  kill -HUP "$(pgrep -P "$job" -f mainnet-deploy.sh)"; wait "$job"; is "exit after a hangup" "$?" 130
  says "interrupted; forge stopped"
  is "record after the hangup" "$(record 'd["stage1"]["status"]')" pending
  drive stage1; is "rerun exit" "$status" 0
  is "createSubscription broadcasts" "$(sends CreateMainnetSubscription)" 1
}

test_killed_stage1_refuses_a_fresh_send_over_forges_run_file() {
  fresh; plan kill-driver
  drive stage1; is "killed" "$status" 137
  drive stage1; is "rerun exit" "$status" 1; says "exists but there is no record"
  is "createSubscription broadcasts" "$(sends CreateMainnetSubscription)" 1
}

# --- E2: the CREATE is found among every kept candidate ---

test_e2_dropped_create_that_sorts_first_does_not_hide_the_mined_one() {
  stage1_done; plan dropped fail
  drive stage2; is "first stage2" "$status" 1
  sleep 1.1  # kept run files are named to the second
  drive stage2; is "second stage2" "$status" 1
  is "kept stage 2 run files" "$(ls "$ROOT/deployments" | grep -c '^stage2-failed')" 2
  drive resume; is "resume exit" "$status" 0; says "website manifest"
  is "recorded CREATE" "$(record 'd["create"]["tx"]')" "$(creates mined)"
  is "raffles created" "$(creates mined | wc -w)" 1
}

test_e2_no_mined_candidate_names_create_tx_and_accepts_it() {
  stage1_done; plan dropped
  drive stage2; is "stage2" "$status" 1
  # The operator sent the CREATE again outside the driver, so no kept run file names the mined one.
  chain 'import subprocess; a = subprocess.check_output([os.environ["REAL_CAST"], "compute-address", "0x" + "11" * 20, "--nonce", "19"], text=True).split()[-1].lower(); d["head"] += 1; d["txs"]["0x" + "cc" * 32] = {"from": "0x" + "11" * 20, "nonce": 19, "block": d["head"], "status": 1, "created": a, "logs": [], "function": None}; d["code"][a] = "0x60"; d["head"] += 5'
  drive resume; is "resume without the hash" "$status" 1; says "set CREATE_TX"
  CREATE_TX=0x$(printf 'cc%.0s' $(seq 32)) drive resume; is "resume with CREATE_TX" "$status" 0
  is "recorded CREATE" "$(record 'd["create"]["tx"]')" "0x$(printf 'cc%.0s' $(seq 32))"
}

test_unused_expected_nonce_says_a_fresh_stage2_can_run() {
  stage1_done; plan dropped
  drive stage2; is "stage2" "$status" 1
  drive resume; is "resume" "$status" 1; says "has not used EXPECTED_NONCE; nothing was created"
  drive stage2; is "fresh stage2 again" "$status" 0
}

# --- E3: the record is replaced whole or not at all ---

test_e3_record_write_cut_short_leaves_the_previous_record() {
  stage1_done
  local before; before=$(cat "$RECORD")
  PYTHONPATH=$HERE/failwrite drive stage2; is "stage2 exit when the write fails" "$status" 1
  is "record after the failed write" "$(cat "$RECORD")" "$before"
  is "temporary files left" "$(ls -A "$ROOT/deployments" | grep -c '^\.record-')" 0
  drive resume; is "resume once writes work" "$status" 0
  is "recorded CREATE" "$(record 'd["create"]["tx"]')" "$(creates mined)"
}

# --- stage 2 interruptions ---

test_interrupted_stage2_resumes_without_a_second_create() {
  stage1_done; plan fail
  drive stage2; is "stage2" "$status" 1; says "stage2 stopped"
  drive stage2; is "fresh rerun refused" "$status" 1; says "run resume"
  drive resume; is "resume exit" "$status" 0
  is "raffles created" "$(creates mined | wc -w)" 1
  is "fresh broadcasts" "$(sends 'DeployMainnet fail')" 1
}

# D1: a driver killed outright cannot keep forge's run file. The next step must keep it and use it, not delete it.
test_d1_killed_stage2_leaves_a_run_file_that_resume_keeps_and_uses() {
  stage1_done; plan kill-driver
  chain 'd["history"] = False'  # a pruned node: the CREATE cannot be searched for by nonce
  drive stage2; is "killed" "$status" 137
  is "kept stage 2 run files after the kill" "$(ls "$ROOT/deployments" | grep -c '^stage2')" 0
  drive resume; is "resume exit" "$status" 0
  is "recorded CREATE" "$(record 'd["create"]["tx"]')" "$(creates mined)"
  is "kept copy of the killed run's file" "$(grep -l "$(creates mined)" "$ROOT"/deployments/stage2*.json | wc -l)" 1
}

test_d1_killed_stage2_before_the_create_mined_keeps_its_run_file_too() {
  stage1_done; plan kill-driver
  chain 'd["history"] = False'
  drive stage2; is "killed" "$status" 137
  local dead; dead=$(creates mined)
  # The CREATE was never mined after all: drop it and free its nonce.
  chain 'd["txs"]["'"$dead"'"].update(dropped=True, block=None); d["code"] = {k: v for k, v in d["code"].items() if k in ("'"$SAFE"'", "0xd7f86b4b8cae7d942340ff628f82735b7a20893a", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48")}'
  drive stage2; is "fresh stage2 again" "$status" 0
  is "kept copy of the killed run's file" "$(grep -l "$dead" "$ROOT"/deployments/stage2*.json | wc -l)" 1
  [ "$(record 'd["create"]["tx"]')" != "$dead" ] || { echo "    the record names the dropped CREATE"; ok=1; }
}

# --- two runs at once ---

test_two_stage1_runs_at_once_create_one_subscription() {
  fresh; plan slow-1.5 slow-1.5
  ( drive stage1; echo "$status" > "$ROOT/first" ) &
  sleep 0.5
  ( driver stage1 > "$ROOT/out2" 2>&1; echo $? > "$ROOT/second" ) &
  wait
  is "exit statuses" "$(sort "$ROOT/first" "$ROOT/second" | tr '\n' ' ')" "0 1 "
  is "subscriptions created" "$(subscriptions)" 1
  is "stage 1 status" "$(record 'd["stage1"]["status"]')" mined
}

for t in $(declare -F | awk '{print $3}' | grep '^test_'); do run "$t"; done
echo "$passed passed, $failed failed"
[ "$failed" = 0 ]
