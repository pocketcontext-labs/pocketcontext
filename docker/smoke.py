#!/usr/bin/env python3
"""Exercise actual hosted image with synthetic data and no real email/S3 writes."""
import argparse
import http.client
import json
import subprocess
import time
import uuid


def docker(*args, check=True, input=None):
    result = subprocess.run(["docker", *args], input=input, text=True, capture_output=True)
    if check and result.returncode:
        raise AssertionError("Docker command failed: " + args[0])
    return result


def request(port, path):
    connection = http.client.HTTPConnection("127.0.0.1", port, timeout=2)
    try:
        connection.request("GET", path, headers={"Host": "synthetic.example.test"})
        response = connection.getresponse()
        return response.status, response.read()
    finally:
        connection.close()


def wait_ready(container):
    deadline = time.monotonic() + 45
    while time.monotonic() < deadline:
        line = docker("port", container, "80/tcp").stdout.strip()
        port = int(line.rsplit(":", 1)[1])
        try:
            if request(port, "/up")[0] == 200:
                return port
        except OSError:
            pass
        if docker("inspect", "--format", "{{.State.Running}}", container).stdout.strip() != "true":
            raise AssertionError("hosted container exited before readiness")
        time.sleep(0.25)
    raise AssertionError("hosted readiness timed out")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--image", required=True)
    args = parser.parse_args()
    suffix = uuid.uuid4().hex[:12]
    volume, name = "pocketcontext-smoke-" + suffix, "pocketcontext-smoke-" + suffix
    env = {
        "POCKETCONTEXT_DOMAIN": "synthetic.example.test",
        "POCKETCONTEXT_OWNER_EMAIL": "owner@example.test",
        "POCKETCONTEXT_SMTP_HOST": "smtp.example.invalid",
        "POCKETCONTEXT_SMTP_PORT": "465", "POCKETCONTEXT_SMTP_TLS": "tls",
        "POCKETCONTEXT_SMTP_USERNAME": "synthetic", "POCKETCONTEXT_SMTP_PASSWORD": "synthetic",
        "POCKETCONTEXT_SMTP_FROM": "login@example.test",
        "POCKETCONTEXT_BACKUP_ENDPOINT": "https://backup.example.invalid",
        "POCKETCONTEXT_BACKUP_REGION": "auto", "POCKETCONTEXT_BACKUP_BUCKET": "synthetic",
        "POCKETCONTEXT_BACKUP_ACCESS_KEY_ID": "synthetic", "POCKETCONTEXT_BACKUP_SECRET_ACCESS_KEY": "synthetic",
        "POCKETCONTEXT_BACKUP_PREFIX": "synthetic",
    }
    options = []
    for key, value in env.items():
        options.extend(["-e", key + "=" + value])
    docker("volume", "create", volume)
    try:
        # A missing configuration is an error before opening application storage.
        missing = docker("run", "--rm", args.image, check=False)
        assert missing.returncode != 0
        docker("run", "-d", "--name", name, "-p", "127.0.0.1::80", "-v", volume + ":/storage", *options, "-e", "POCKETCONTEXT_CONTAINER_COMMAND=init", args.image)
        port = wait_ready(name)
        assert request(port, "/api/bundle/auth-mode")[0] == 200
        assert request(port, "/api/context/schema")[0] in (401, 403)
        assert request(port, "/_/")[0] == 404
        assert request(port, "/.well-known/oauth-authorization-server")[0] == 200
        docker("exec", "-i", name, "sh", "-c", "cat > /tmp/synthetic-note.txt", input="Hosted persistence synthetic evidence.\n")
        docker("exec", name, "pocketcontext", "ingest", "/tmp/synthetic-note.txt", "--title", "Synthetic hosted persistence")
        docker("stop", "--time", "100", name)
        assert docker("inspect", "--format", "{{.State.ExitCode}}", name).stdout.strip() == "0"
        docker("rm", name)
        repeated = docker("run", "--rm", "-v", volume + ":/storage", *options, "-e", "POCKETCONTEXT_CONTAINER_COMMAND=init", args.image, check=False)
        assert repeated.returncode != 0
        docker("run", "-d", "--name", name, "-p", "127.0.0.1::80", "-v", volume + ":/storage", *options, args.image)
        wait_ready(name)
        result = docker("exec", name, "pocketcontext", "sql", "SELECT title FROM sources").stdout
        assert "Synthetic hosted persistence" in result or "Hosted persistence" in result
        # Kill/recreate changes container hostname. Persistent lease and cache must recover.
        docker("kill", name)
        docker("rm", name)
        docker("run", "-d", "--name", name, "-p", "127.0.0.1::80", "-v", volume + ":/storage", *options, args.image)
        wait_ready(name)
        result = docker("exec", name, "pocketcontext", "sql", "SELECT title FROM sources").stdout
        assert "Synthetic hosted persistence" in result or "Hosted persistence" in result
        docker("stop", "--time", "100", name)
        assert docker("inspect", "--format", "{{.State.ExitCode}}", name).stdout.strip() == "0"
        print("Hosted container init, authentication boundary, MCP discovery, persistence, SIGKILL recovery and clean shutdown passed.")
    finally:
        docker("rm", "-f", name, check=False)
        docker("volume", "rm", volume, check=False)


if __name__ == "__main__":
    main()
