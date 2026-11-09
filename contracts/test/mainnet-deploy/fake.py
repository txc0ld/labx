#!/usr/bin/env python3
"""Offline stand-ins for cast, forge, node and sleep, for run.sh. Nothing here opens a network connection.

The chain is one JSON file (FAKE_CHAIN): a head block number, the deployer's starting nonce, and every transaction the
fake forge has sent, each mined, pending or dropped. `plan` is a list of modes, one consumed per forge broadcast; with no
plan left a broadcast succeeds. `sent` logs every broadcast forge was asked for, which is what the tests count.
"""
import fcntl
import hashlib
import json
import os
import signal
import subprocess
import sys
import time

CHAIN = os.environ.get("FAKE_CHAIN", "")
DEPLOYER = "0x1111111111111111111111111111111111111111"
COORDINATOR = "0xd7f86b4b8cae7d942340ff628f82735b7a20893a"
SUBSCRIPTION_CREATED = "0x1d3015d7ba850fa198dc7b1a3f5d42779313a681035f77c8c03764c61005518d"
SUBSCRIPTION_ID = 4242
STEPS = ["setNativePayment(bool)", "addConsumer(uint256,address)", "transferOwnership(address)",
         "requestSubscriptionOwnerTransfer(uint256,address)"]


class State:
    """The chain file, held under a lock so two drivers can run at once."""

    def __enter__(self):
        self.file = open(CHAIN, "r+")
        fcntl.flock(self.file, fcntl.LOCK_EX)
        self.data = json.load(self.file)
        return self.data

    def __exit__(self, *error):
        self.file.seek(0)
        self.file.truncate()
        self.file.write(json.dumps(self.data, indent=1))
        self.file.close()


def block_hash(number):
    return "0x" + hashlib.sha256(f"block-{number}".encode()).hexdigest()


def known(tx):
    return not tx.get("dropped")


def latest_nonce(state, at=None):
    mined = [t["nonce"] for t in state["txs"].values() if known(t) and t["block"] is not None
             and (at is None or t["block"] <= at)]
    return max([state["nonce"]] + [n + 1 for n in mined])


def pending_nonce(state):
    return max([latest_nonce(state)] + [t["nonce"] + 1 for t in state["txs"].values() if known(t)])


def receipt(state, tx_hash):
    tx = state["txs"].get(tx_hash)
    if not tx or not known(tx) or tx["block"] is None:
        return None
    return {"transactionHash": tx_hash, "blockNumber": hex(tx["block"]), "blockHash": block_hash(tx["block"]),
            "status": hex(tx.get("status", 1)), "contractAddress": tx.get("created"), "logs": tx.get("logs", [])}


def real_cast(args):
    sys.exit(subprocess.call([os.environ["REAL_CAST"]] + args))


def cast(args):
    command = args[0]
    if command in ("keccak", "compute-address", "from-wei"):
        real_cast(args)
    if command in os.environ.get("FAKE_FAIL", "").split(","):
        sys.exit(1)
    with State() as state:
        if command == "chain-id":
            print(1)
        elif command == "rpc":
            tx = state["txs"].get(args[2])
            if args[1] == "eth_getTransactionReceipt":
                print(json.dumps(receipt(state, args[2])))
            elif tx and known(tx):
                print(json.dumps({"hash": args[2], "from": tx["from"], "nonce": hex(tx["nonce"])}))
            else:
                print("null")
        elif command == "receipt":
            found = receipt(state, args[1])
            if not found:
                sys.exit(1)
            print(json.dumps(found))
        elif command == "block-number":
            print(state["head"])
        elif command == "block":
            number = state["head"] if args[1] == "latest" else int(args[1])
            if number > state["head"]:
                sys.exit(1)
            if "--field" in args:
                print(block_hash(number))
            else:
                txs = [{"hash": h, "from": t["from"], "nonce": hex(t["nonce"])}
                       for h, t in state["txs"].items() if known(t) and t["block"] == number]
                print(json.dumps({"number": hex(number), "hash": block_hash(number), "transactions": txs}))
        elif command == "tx":
            tx = state["txs"][args[1]]
            print(tx["nonce"] if args[2] == "nonce" else json.dumps({"from": tx["from"], "nonce": hex(tx["nonce"])}))
        elif command == "nonce":
            at = args[args.index("--block") + 1] if "--block" in args else "latest"
            if at == "pending":
                print(pending_nonce(state))
            elif at == "latest":
                print(latest_nonce(state))
            elif not state.get("history", True):
                sys.exit(1)  # a pruned node has no state at an old block
            else:
                print(latest_nonce(state, int(at)))
        elif command == "code":
            print(state["code"].get(args[1].lower(), "0x"))
        elif command == "codehash":
            print("0x" + "ab" * 32)
        elif command == "call":
            answers = {"getThreshold()(uint256)": "2", "getOwners()(address[])": "[0x00000000000000000000000000000000000000A1]",
                       "owner()(address)": DEPLOYER, "pendingOwner()(address)": state["safe"],
                       "paused()(bool)": "true", "termsHash()(bytes32)": state["terms"]}
            print(answers[args[2]])
        elif command == "balance":
            print(10 ** 18)
        elif command == "gas-price":
            print(10 ** 9)
        else:
            sys.exit(f"fake cast: unknown command {command}")


def send(state, kind, nonce, function, mined=True, created=None, logs=None):
    """Sends one transaction and returns its hash, or None when the nonce is already taken, as a node refuses it."""
    if any(known(t) and t["nonce"] == nonce for t in state["txs"].values()):
        return None
    state["counter"] += 1
    tx_hash = "0x" + hashlib.sha256(f"{kind}-{state['counter']}".encode()).hexdigest()
    block = None
    if mined:
        state["head"] += 1
        block = state["head"]
    state["txs"][tx_hash] = {"from": DEPLOYER, "nonce": nonce, "block": block, "status": 1, "created": created,
                             "logs": logs or [], "function": function}
    return tx_hash


def write_run(transactions):
    path = "contracts/broadcast/DeployMainnet.s.sol/1/run-latest.json"
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w") as f:
        f.write(json.dumps({"transactions": transactions}))


def entry(tx_hash, kind, function, nonce):
    return {"hash": tx_hash, "transactionType": kind, "function": function, "transaction": {"nonce": hex(nonce)}}


def forge(args):
    """Modes, one per broadcast, from `plan`:
    ok            everything is sent and mined
    pending       stage 1 is sent and stays in the mempool
    fail          the first transaction is mined, then forge exits 1 (stage 2: only the CREATE is sent)
    dropped       the first transaction is sent, then no node knows it; forge exits 1
    kill-driver   as fail, then the driver is killed outright before it can keep the run file
    hang          as fail, but forge then waits to be stopped
    slow-N        waits N seconds between simulating and sending, then ok
    """
    target = next(a for a in args if ":" in a).split(":")[1]
    if "--sig" in args:  # verify(): passes once every stage 2 step is mined
        with State() as state:
            sys.exit(0 if all(s in state["done"] for s in STEPS) else 1)
    with State() as state:
        mode = state["plan"].pop(0) if state["plan"] else "ok"
        state["sent"].append(f"{target} {mode}")
        nonce = latest_nonce(state)  # the simulation reads the nonce; the send comes later
    fresh = target == "DeployMainnet" and os.environ["DEPLOY_MODE"] == "fresh"
    bound = os.environ.get("STAGE1_NONCE") if target == "CreateMainnetSubscription" else os.environ.get("EXPECTED_NONCE")
    if (target == "CreateMainnetSubscription" or fresh) and bound is not None and nonce != int(bound):
        sys.exit("NonceMoved")
    if mode.startswith("slow"):
        time.sleep(float(mode.split("-")[1]))
        mode = "ok"
    with State() as state:
        mined = mode not in ("pending", "dropped")
        if target == "CreateMainnetSubscription":
            log = {"address": COORDINATOR, "topics": [SUBSCRIPTION_CREATED, "0x%064x" % SUBSCRIPTION_ID],
                   "data": "0x" + DEPLOYER[2:].rjust(64, "0")}
            tx_hash = send(state, "stage1", nonce, "createSubscription()", mined=mined, logs=[log])
            run = [entry(tx_hash, "CALL", "createSubscription()", nonce)]
        elif fresh:
            created = subprocess.check_output(
                [os.environ["REAL_CAST"], "compute-address", DEPLOYER, "--nonce", str(nonce)], text=True).split()[-1].lower()
            tx_hash = send(state, "create", nonce, None, mined=mined, created=created)
            run = [entry(tx_hash, "CREATE", None, nonce)]
            if tx_hash and mined:
                state["code"][created] = "0x60"
            for i, step in enumerate(STEPS):
                sent = send(state, "call", nonce + 1 + i, step) if mode == "ok" and tx_hash else None
                run.append(entry(sent, "CALL", step, nonce + 1 + i))
                if sent:
                    state["done"].append(step)
        else:  # resume: only the steps that are not mined yet
            assert os.environ["RAFFLE_ADDRESS"]
            run, tx_hash = [], "none needed"
            for step in [s for s in STEPS if s not in state["done"]]:
                run.append(entry(send(state, "call", nonce, step), "CALL", step, nonce))
                state["done"].append(step)
                nonce += 1
        if tx_hash and mode == "dropped":
            state["txs"][tx_hash]["dropped"] = True
        if run:
            write_run(run)
        state["head"] += 5  # every mined transaction is deep enough at once
    if mode == "kill-driver":
        os.kill(os.getppid(), signal.SIGKILL)
    if mode == "hang":
        time.sleep(60)
    sys.exit(0 if mode in ("ok", "pending") and tx_hash else 1)


def main():
    tool = os.path.basename(sys.argv[0])
    if tool == "cast":
        cast(sys.argv[1:])
    elif tool == "forge":
        forge(sys.argv[1:])
    elif tool == "node":
        print(DEPLOYER)
    # sleep: returns at once, so the driver's waits cost nothing


main()
