#!/usr/bin/env python3
"""Explicit standalone rehearsal through existing PocketDeploy SSH; no ONCE/cloud reconciliation."""
import argparse
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
from prepare_config import BINDINGS
from shared_host_remote import check_scope

def private_json(path):
    info = path.lstat()
    if not stat.S_ISREG(info.st_mode) or info.st_mode & 0o077 or info.st_uid != os.getuid() or info.st_nlink != 1:
        raise ValueError("Owned mode-0600 regular JSON required")
    return json.loads(path.read_text())

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("status", "stage", "start-old", "candidate", "stop", "remove"))
    parser.add_argument("--config", required=True, type=Path, help="Existing pocketdeploy-v1 colors.yml")
    parser.add_argument("--scope", required=True, type=Path, help="Private reviewed rehearsal scope JSON")
    parser.add_argument("--private-env", type=Path, help="Clone-only startup environment JSON; never shell sourced")
    parser.add_argument("--prepared-dir", type=Path, help="Prepared clone pb_data plus sibling preparation receipt; stage only")
    args = parser.parse_args()
    try:
        from pocketdeploy.config import load
        from pocketdeploy.runtime import session
        config = load(args.config, env={}, resolve=False)
        scope = private_json(args.scope); check_scope(scope)
        if config["profile"] != scope["existingProfile"] or not config.get("compute-require-existing-state"):
            raise ValueError("Existing controller required")
        payload = {"action": "prepare-upload" if args.action == "stage" else args.action, "scope": scope}
        if args.action in ("start-old", "candidate"):
            if args.private_env is None: raise ValueError("Clone bindings required")
            env = private_json(args.private_env)
            if set(env) != set(BINDINGS): raise ValueError("Exact clone storage bindings required")
            payload.update(environment=env, environment_keys=list(BINDINGS))
        source = Path(__file__).with_name("shared_host_remote.py").read_text()
        with session(config, read_only=True) as deployment:
            if deployment.state.deployment_id != scope["existingDeploymentId"]:
                raise ValueError("Existing deployment identity mismatch")
            connection = deployment.cloud.connection()
            if args.action == "stage":
                if args.prepared_dir is None: raise ValueError("Prepared clone directory required")
                from shared_host_remote import verify_prepared
                verify_prepared(args.prepared_dir, scope)
            result = deployment.host.run_python(connection, source, payload, timeout=3600)
            if args.action == "stage":
                transport = deployment.host.prepare_transport(connection)
                target = "ubuntu@" + connection["ip"] + ":/var/lib/wikicontext-rehearsal/" + scope["id"] + "/"
                for local, destination in ((str(args.prepared_dir.resolve()) + "/", target + "prepared/"), (str(args.prepared_dir.parent / (args.prepared_dir.name + ".preparation.json")), target + "prepared.preparation.json")):
                    transfer = subprocess.run(["rsync", "-a", "--chmod=Du=rwx,Dgo=,Fu=rw,Fgo=", "--rsync-path=sudo rsync", "-e", transport.rsync_shell(), local, destination], capture_output=True, text=True, timeout=1800)
                    if transfer.returncode: raise ValueError("Private prepared data transfer failed")
                result = {"staged": True, "started": False}
        print(json.dumps(result))
    except Exception:
        parser.exit(1, "Rehearsal refused or failed; private configuration and remote output suppressed. Preserve existing data and inspect the reviewed scope.\n")

if __name__ == "__main__": main()
