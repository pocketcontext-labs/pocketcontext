#!/usr/bin/env -S uv run --script
# /// script
# requires-python = ">=3.11"
# dependencies = ["boto3==1.40.57"]
# ///
"""Real hosted image + local HTTPS S3 populated backup/restore rehearsal.

All accounts, credentials, notes and buckets are synthetic. No email is sent.
Run: uv run docker/recovery.py --image pocketcontext:hosted-local
"""
import argparse
import base64
import hashlib
import http.client
import io
import json
import os
from pathlib import Path
import subprocess
import tarfile
import tempfile
import time
from urllib.parse import parse_qs, urlencode, urlparse
import uuid

import boto3
from botocore.config import Config

MOTO_IMAGE = "motoserver/moto:5.1.15@sha256:8860b18917e1ee4d067df19a406ae95dc26037e6965d5b499e1cffd33755b914"
DOMAIN = "synthetic.example.test"
ORIGIN = "https://" + DOMAIN


def docker(*args, check=True, input=None):
    result = subprocess.run(["docker", *args], input=input, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError("Docker operation failed: " + args[0])
    return result


def request(port, path, body=None, token="", form=False):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
    headers = {"Host": DOMAIN, "Origin": ORIGIN}
    if token:
        headers["Authorization"] = "Bearer " + token
    data = None
    if body is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded" if form else "application/json"
        data = urlencode(body) if form else json.dumps(body)
    try:
        connection.request("POST" if body is not None else "GET", path, data, headers)
        response = connection.getresponse()
        raw = response.read()
        try:
            result = json.loads(raw)
        except ValueError:
            result = raw.decode(errors="replace")
        return response.status, result
    finally:
        connection.close()


def wait_ready(name):
    deadline = time.monotonic() + 90
    while time.monotonic() < deadline:
        port = int(docker("port", name, "80/tcp").stdout.strip().rsplit(":", 1)[1])
        try:
            if request(port, "/up")[0] == 200:
                return port
        except OSError:
            pass
        if docker("inspect", "--format", "{{.State.Running}}", name).stdout.strip() != "true":
            raise AssertionError("container exited before readiness")
        time.sleep(0.2)
    raise AssertionError("container did not become ready")


def local_token(name):
    # Ordinary local-key exchange inside this synthetic test container. The token
    # is held only in this process; neither it nor raw Docker metadata is printed.
    script = '''import glob,http.client,json,pathlib,socket
path=glob.glob('/storage/private/cache/pocketcontext/*/local.key')[0]
key=pathlib.Path(path).read_text()
sock=socket.socket(socket.AF_UNIX);sock.connect(str(pathlib.Path(path).with_name('server.sock')))
c=http.client.HTTPConnection('pocketcontext.internal');c.sock=sock
c.request('POST','/api/bundle/token','{}',{'Host':'pocketcontext.internal','X-PocketContext-Local-Key':key,'Content-Type':'application/json'})
r=c.getresponse();assert r.status==200
print(json.loads(r.read())['token'])
'''
    return docker("exec", "-i", name, "python3", "-", input=script).stdout.strip()


def mcp_grant(port, reader_token):
    status, client = request(port, "/oauth/register", {
        "client_name": "Synthetic recovery verifier", "redirect_uris": ["https://client.example.test/callback"],
        "token_endpoint_auth_method": "none",
    })
    assert status == 201
    verifier = base64.urlsafe_b64encode(os.urandom(32)).decode().rstrip("=")
    challenge = base64.urlsafe_b64encode(hashlib.sha256(verifier.encode()).digest()).decode().rstrip("=")
    query = {"client_id": client["client_id"], "redirect_uri": "https://client.example.test/callback",
             "response_type": "code", "code_challenge_method": "S256", "code_challenge": challenge,
             "resource": ORIGIN + "/mcp", "scope": "knowledge", "state": "synthetic"}
    status, approved = request(port, "/oauth/authorize?" + urlencode(query), {"approve": True}, reader_token)
    assert status == 200
    code = parse_qs(urlparse(approved["redirect"]).query)["code"][0]
    status, tokens = request(port, "/oauth/token", {
        "grant_type": "authorization_code", "client_id": client["client_id"], "code": code,
        "redirect_uri": query["redirect_uri"], "code_verifier": verifier, "resource": ORIGIN + "/mcp",
    }, form=True)
    assert status == 200
    return client["client_id"], tokens


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    suffix = uuid.uuid4().hex[:12]
    source_name, restored_name = "pc-recovery-source-" + suffix, "pc-recovery-restored-" + suffix
    source_volume, restored_volume = source_name, restored_name
    fixture_name, network = "pc-recovery-s3-" + suffix, "pc-recovery-net-" + suffix
    containers = [source_name, restored_name, fixture_name]
    volumes = [source_volume, restored_volume]
    with tempfile.TemporaryDirectory(prefix="pc-recovery-") as temp:
        temp = Path(temp)
        cert, key = temp / "fixture-ca.pem", temp / "fixture-key.pem"
        command = ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
                   "-keyout", str(key), "-out", str(cert), "-subj", "/CN=s3fixture",
                   "-addext", "subjectAltName=DNS:s3fixture,IP:127.0.0.1"]
        subprocess.run(command, check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        os.chmod(cert, 0o644)
        try:
            docker("network", "create", network)
            docker("run", "-d", "--name", fixture_name, "--network", network, "--network-alias", "s3fixture",
                   "-p", "127.0.0.1::5000", "-v", str(cert) + ":/fixture-ca.pem:ro", "-v", str(key) + ":/fixture-key.pem:ro",
                   "--entrypoint", "moto_server", MOTO_IMAGE, "-H", "0.0.0.0", "-p", "5000",
                   "--ssl-cert", "/fixture-ca.pem", "--ssl-key", "/fixture-key.pem")
            port = int(docker("port", fixture_name, "5000/tcp").stdout.strip().rsplit(":", 1)[1])
            s3 = boto3.client("s3", endpoint_url=f"https://127.0.0.1:{port}", region_name="us-east-1",
                              aws_access_key_id="synthetic", aws_secret_access_key="synthetic", verify=str(cert),
                              config=Config(signature_version="s3v4", s3={"addressing_style": "path"}, proxies={},
                                            connect_timeout=2,read_timeout=2,retries={"max_attempts":0}))
            bucket = "synthetic-recovery-" + suffix
            env = {
                "POCKETCONTEXT_DOMAIN": DOMAIN, "POCKETCONTEXT_OWNER_EMAIL": "owner@example.test",
                "POCKETCONTEXT_SMTP_HOST": "smtp.example.invalid", "POCKETCONTEXT_SMTP_PORT": "465",
                "POCKETCONTEXT_SMTP_TLS": "tls", "POCKETCONTEXT_SMTP_USERNAME": "synthetic",
                "POCKETCONTEXT_SMTP_PASSWORD": "synthetic", "POCKETCONTEXT_SMTP_FROM": "login@example.test",
                "POCKETCONTEXT_BACKUP_ENDPOINT": "https://s3fixture:5000",
                "POCKETCONTEXT_BACKUP_REGION": "us-east-1", "POCKETCONTEXT_BACKUP_BUCKET": bucket,
                "POCKETCONTEXT_BACKUP_ACCESS_KEY_ID": "synthetic", "POCKETCONTEXT_BACKUP_SECRET_ACCESS_KEY": "synthetic",
                "POCKETCONTEXT_BACKUP_PREFIX": "recovery", "AWS_CA_BUNDLE": "/fixture-ca.pem",
                "NO_PROXY": "s3fixture,127.0.0.1", "no_proxy": "s3fixture,127.0.0.1",
            }
            options = ["--network", network, "-v", str(cert) + ":/fixture-ca.pem:ro"]
            for name, value in env.items():
                options += ["-e", name + "=" + value]
            deadline = time.monotonic() + 60
            while True:
                try:
                    s3.create_bucket(Bucket=bucket)
                    break
                except Exception:
                    if time.monotonic() > deadline:
                        raise AssertionError("synthetic HTTPS S3 fixture did not start") from None
                    time.sleep(0.2)
            for volume in volumes:
                docker("volume", "create", volume)
            docker("run", "-d", "--name", source_name, "-p", "127.0.0.1::80", "-v", source_volume + ":/storage", *options, args.image, "init")
            source_port = wait_ready(source_name)
            originals = [("synthetic-evidence.log", b"Synthetic recovery evidence: preserve every original including .log files.\n"),
                         ("synthetic-original.bin", bytes(range(256)) * 8)]
            sources = []
            for filename, content in originals:
                script = "import base64,pathlib;pathlib.Path(" + repr("/tmp/" + filename) + ").write_bytes(base64.b64decode(" + repr(base64.b64encode(content).decode()) + "))"
                docker("exec", "-i", source_name, "python3", "-", input=script)
                result = json.loads(docker("exec", source_name, "pocketcontext", "ingest", "/tmp/" + filename, "--title", filename).stdout)
                sources.append((result["source"], content))
            old_reader = local_token(source_name)
            assert request(source_port, "/api/context/schema", token=old_reader)[0] == 200
            client, old_mcp = mcp_grant(source_port, old_reader)
            backup = json.loads(docker("exec", source_name, "pocketcontext-container", "backup").stdout)
            assert backup["ok"] is True
            source_port = wait_ready(source_name)
            assert request(source_port, "/api/context/schema", token=old_reader)[0] == 200, "normal backup restart preserves login"
            remote = s3.get_object(Bucket=bucket, Key=backup["key"])
            archive = remote["Body"].read()
            assert hashlib.sha256(archive).hexdigest() == remote["Metadata"]["sha256"]
            with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as tar:
                manifest = json.load(tar.extractfile("manifest.json"))
                entries = {entry.name: tar.extractfile(entry).read() for entry in tar if entry.isfile() and entry.name != "manifest.json"}
            for name, entry in manifest["files"].items():
                assert hashlib.sha256(entries[name]).hexdigest() == entry["sha256"]
            for _, original in originals:
                assert original in entries.values(), "complete archive includes each original"
            assert any("mcp-oauth-" in name for name in entries), "backup actually includes authorization state to invalidate"
            prepared = json.loads(docker("exec", source_name, "pocketcontext-container", "prepare-upgrade").stdout)
            assert prepared["ok"] and prepared["paused"]
            docker("stop", "--time", "100", source_name)
            assert docker("inspect", "--format", "{{.State.ExitCode}}", source_name).stdout.strip() == "0"
            result = docker("run", "--rm", "-v", restored_volume + ":/storage", *options, args.image, "restore", backup["key"])
            assert json.loads(result.stdout)["ok"]
            docker("run", "-d", "--name", restored_name, "-p", "127.0.0.1::80", "-v", restored_volume + ":/storage", *options, args.image)
            restored_port = wait_ready(restored_name)
            assert request(restored_port, "/api/context/schema", token=old_reader)[0] in (401, 403), "restored browser token revoked"
            assert request(restored_port, "/mcp", {"jsonrpc": "2.0", "id": 1, "method": "initialize", "params": {}}, old_mcp["access_token"])[0] == 401, "restored MCP access revoked"
            assert request(restored_port, "/oauth/token", {"grant_type": "refresh_token", "client_id": client,
                "refresh_token": old_mcp["refresh_token"], "resource": ORIGIN + "/mcp"}, form=True)[0] in (400, 401), "restored MCP refresh revoked"
            fresh = local_token(restored_name)
            assert request(restored_port, "/api/context/schema", token=fresh)[0] == 200
            _, new_mcp = mcp_grant(restored_port, fresh)
            assert new_mcp["access_token"] != old_mcp["access_token"], "restored instance supports a fresh MCP connection"
            for source, original in sources:
                result = json.loads(docker("exec", restored_name, "pocketcontext", "original", source, "--out", "/tmp/" + source).stdout)
                assert result["sha256"] == hashlib.sha256(original).hexdigest()
                recovered = docker("exec", restored_name, "python3", "-c", "import hashlib,pathlib;print(hashlib.sha256(pathlib.Path('/tmp/" + source + "').read_bytes()).hexdigest())").stdout.strip()
                assert recovered == hashlib.sha256(original).hexdigest()
            assert "preserve every original" in docker("exec", restored_name, "pocketcontext", "sql", "SELECT body FROM passages ORDER BY ordinal").stdout
            docker("stop", "--time", "100", restored_name)
            assert docker("inspect", "--format", "{{.State.ExitCode}}", restored_name).stdout.strip() == "0"
            print("Actual-image populated HTTPS S3 backup, remote hashes, pre-upgrade checkpoint, empty-volume restore, original hashes and credential invalidation passed.")
        finally:
            for container in containers:
                docker("rm", "-f", container, check=False)
            for volume in volumes:
                docker("volume", "rm", volume, check=False)
            docker("network", "rm", network, check=False)


if __name__ == "__main__":
    main()
