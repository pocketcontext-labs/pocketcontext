#!/usr/bin/env python3
"""Generate non-secret, SSH-only PocketDeploy rehearsal phases; never contact providers."""
import argparse
from datetime import datetime, timedelta, timezone
import ipaddress
import json
import os
from pathlib import Path
import re
import uuid

BINDINGS = (
    "WIKICONTEXT_S3_BUCKET", "WIKICONTEXT_S3_ENDPOINT", "WIKICONTEXT_S3_REGION",
    "WIKICONTEXT_S3_ACCESS_KEY_ID", "WIKICONTEXT_S3_SECRET_ACCESS_KEY", "WIKICONTEXT_S3_FORCE_PATH_STYLE",
    "LITESTREAM_BUCKET", "LITESTREAM_PATH", "LITESTREAM_ENDPOINT", "LITESTREAM_REGION",
    "LITESTREAM_ACCESS_KEY_ID", "LITESTREAM_SECRET_ACCESS_KEY", "LITESTREAM_SYNC_INTERVAL",
)
PROVIDER_FIELDS = {
    "oci": {"oci-config-file-profile", "oci-auth", "oci-region", "oci-compartment-id", "oci-subnet-id", "oci-availability-domain", "oci-shape", "oci-ocpus", "oci-memory-in-gbs", "oci-boot-volume-size-in-gbs", "oci-boot-volume-vpus-per-gb"},
    "digitalocean": {"digitalocean-account-id", "digitalocean-region", "digitalocean-vpc-id", "digitalocean-size", "digitalocean-image"},
    "gcp": {"gcp-project", "gcp-zone", "gcp-network", "gcp-subnet", "gcp-machine-type", "gcp-image-project", "gcp-image-family", "gcp-boot-disk-size-gb", "gcp-boot-disk-type"},
}
class Invalid(ValueError):
    pass

def require(condition, message):
    if not condition:
        raise Invalid(message)

def phases(spec, now=None):
    require(isinstance(spec, dict) and set(spec) == {"profile", "source", "provider", "providerFields", "sshSources", "cloneHost", "oldImage", "candidateImage", "appCPUs", "appMemoryMB", "expiresUtc", "maximumCostUSD"}, "Use the exact non-secret specification fields.")
    profile = spec["profile"]
    require(isinstance(profile, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,39}", profile), "Invalid clone profile.")
    source = spec["source"]
    require(isinstance(source, dict) and set(source) == {"profile", "deploymentId", "host"}, "Record source identity separately.")
    try:
        uuid.UUID(source["deploymentId"])
    except (ValueError, TypeError, AttributeError):
        raise Invalid("Source deployment identity must be recorded as a UUID.") from None
    require(profile != source["profile"], "Clone must use a distinct profile and fresh state.")
    host = spec["cloneHost"]
    require(isinstance(host, str) and re.fullmatch(r"[a-z][a-z0-9-]{0,39}\.localhost", host) and host != source["host"], "Clone hostname must be a distinct single-label .localhost name.")
    provider = spec["provider"]
    require(provider in PROVIDER_FIELDS, "Select oci, digitalocean or gcp.")
    fields = spec["providerFields"]
    require(isinstance(fields, dict) and set(fields) == PROVIDER_FIELDS[provider], "Provide exactly the selected provider's non-secret fields.")
    for value in fields.values():
        require(type(value) in (str, int, float) and (not isinstance(value, str) or (value.strip() and "REQUIRED" not in value and "<" not in value and not any(ord(c) < 32 for c in value))), "Replace every provider placeholder with an explicit value.")
    ssh = spec["sshSources"]
    require(isinstance(ssh, list) and bool(ssh), "Explicit operator SSH addresses are required.")
    try:
        networks = [ipaddress.ip_network(item, strict=True) for item in ssh]
        require(all(net.version == 4 and net.prefixlen == 32 and not net.network_address.is_unspecified and not net.network_address.is_multicast for net in networks), "SSH access must name individual IPv4 /32 operator addresses.")
    except (ValueError, TypeError):
        raise Invalid("SSH access must name individual IPv4 /32 operator addresses.") from None
    for key in ("oldImage", "candidateImage"):
        require(isinstance(spec[key], str) and re.fullmatch(r"[a-z0-9][a-z0-9./_-]*@sha256:[a-f0-9]{64}", spec[key]), "Both images must be immutable repository digests.")
    require(spec["oldImage"] != spec["candidateImage"], "Old and candidate image digests must differ.")
    require(type(spec["appCPUs"]) is int and 1 <= spec["appCPUs"] <= 16, "Set an application CPU bound from 1 to 16.")
    require(type(spec["appMemoryMB"]) is int and 512 <= spec["appMemoryMB"] <= 65536, "Set an application memory bound from 512 to 65536 MiB.")
    require(type(spec["maximumCostUSD"]) in (int, float) and 0 < spec["maximumCostUSD"] < float("inf"), "Record a positive approved cost ceiling.")
    try:
        expires = datetime.fromisoformat(spec["expiresUtc"].replace("Z", "+00:00"))
        now = now or datetime.now(timezone.utc)
        require(expires.utcoffset() == timedelta(0) and now < expires <= now + timedelta(days=7), "Set a UTC teardown deadline within seven days.")
    except (ValueError, TypeError, AttributeError):
        raise Invalid("Set a UTC teardown deadline within seven days.") from None
    common = {"schema-version": 1, "profile": profile, "provider-compute": provider,
              "state-file": ".colors.sqlite", "workdir": ".colors", "compute-prevent-destroy": True,
              "compute-require-existing-state": False, "compute-ssh-sources": ssh, "compute-http-sources": [],
              "provider-dns": "no-infra", "provider-smtp": "no-infra", "once-version": "v0.3.3", "ssh-user": "ubuntu",
              "ssh-private-key-file": ".ssh/id_ed25519", "ssh-public-key-file": ".ssh/id_ed25519.pub", "ssh-known-hosts-file": ".ssh/known_hosts", **fields}
    if provider == "digitalocean":
        common["digitalocean-token-env"] = "COLORS_PAR_DIGITALOCEAN_ACCESS_TOKEN"
    host_phase = {**common, "once": {"applications": []}}
    env = {key: "app-wikicontext-rehearsal-" + key.lower().replace("_", "-") for key in BINDINGS}
    app = {"host": host, "image": spec["oldImage"], "disable_tls": True, "manage-dns": False, "smtp": False,
           "auto_update": False, "auto_backup": False, "deploy-strategy": "stop-first", "deploy-stop-timeout": 300,
           "deploy-ready-timeout": 900, "health-path": "/api/health", "cpus": spec["appCPUs"], "memory": spec["appMemoryMB"], "env": env}
    restored = {**common, "compute-require-existing-state": True, "once": {"applications": [app]}}
    candidate = {**restored, "once": {"applications": [{**app, "image": spec["candidateImage"]}]}}
    return {"host.yml": host_phase, "restored.yml": restored, "candidate.yml": candidate}

def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("spec", type=Path)
    parser.add_argument("output", type=Path, help="New deployment directory; existing paths are refused")
    args = parser.parse_args()
    try:
        spec = json.loads(args.spec.read_text())
        configs = phases(spec)
        args.output.mkdir(mode=0o700, parents=False, exist_ok=False)
        for name, value in {**configs, "colors.yml": configs["host.yml"], "scope.json": spec}.items():
            with (args.output / name).open("x", encoding="utf-8") as file:
                os.chmod(file.name, 0o600)
                json.dump(value, file, indent=2); file.write("\n")
        (args.output / ".gitignore").write_text(".envrc.private\n.colors*\n.ssh/\n*.tar.gz\n*.private.json\n*.plan.json\n")
    except (OSError, ValueError, KeyError, TypeError):
        parser.exit(1, "Rehearsal configuration refused; check the non-secret specification and use a new output directory.\n")
    print("Prepared SSH-only host, restored-image and candidate phases. No provider operations performed.")
if __name__ == "__main__":
    main()
