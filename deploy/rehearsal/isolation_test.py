#!/usr/bin/env python3
"""Synthetic local Docker check; never reads deployment state or contacts cloud providers."""
import argparse
import http.client
import json
import socket
import subprocess
import time
import uuid


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True, help="Already available WikiContext test image")
    args = parser.parse_args()
    name = "wiki-isolation-" + uuid.uuid4().hex
    app, volume, private_net, peer_net = [name + suffix for suffix in ("-app", "-data", "-private", "-peer")]
    def run(*command, timeout=60):
        result = subprocess.run(["docker", *command], capture_output=True, text=True, timeout=timeout)
        if result.returncode: raise RuntimeError("Synthetic Docker operation failed; output suppressed")
        return result.stdout
    with socket.socket() as probe:
        probe.bind(("127.0.0.1", 0)); port = probe.getsockname()[1]
    created=[]
    try:
        for network in (private_net, peer_net):
            run("network", "create", "--label", "com.pocketcontext.purpose=synthetic-isolation-test", network);created.append(("network",network))
        run("volume", "create", "--label", "com.pocketcontext.purpose=synthetic-isolation-test", volume);created.append(("volume",volume))
        run("run", "-d", "--name", app, "--label", "com.pocketcontext.purpose=synthetic-isolation-test", "--network", private_net, "--cpus", "0.5", "--memory", "512m", "--publish", f"127.0.0.1:{port}:80", "--mount", f"type=volume,src={volume},dst=/storage", "--entrypoint", "/usr/bin/python3", args.image, "-m", "http.server", "80", "--directory", "/storage")
        created.append(("container",app))
        # Raw inspection stays in this process; emit only test outcomes.
        record=json.loads(run("container","inspect",app))[0]
        assert record["HostConfig"]["PortBindings"] == {"80/tcp":[{"HostIp":"127.0.0.1","HostPort":str(port)}]}
        assert "once" not in record["Config"].get("Labels",{})
        assert set(record["NetworkSettings"]["Networks"]) == {private_net}
        for attempt in range(30):
            connection=http.client.HTTPConnection("127.0.0.1",port,timeout=2)
            try:
                connection.request("GET","/",headers={"Host":"wiki-rehearsal.localhost"})
                if connection.getresponse().status==200:break
            except OSError:time.sleep(.2)
            finally:connection.close()
        else:raise RuntimeError("Synthetic loopback server unavailable")
        private_ip=record["NetworkSettings"]["Networks"][private_net]["IPAddress"]
        gateway=json.loads(run("network","inspect",peer_net))[0]["IPAM"]["Config"][0]["Gateway"]
        # A separate application bridge cannot reach the host's loopback publication
        # or connect directly to the private application's bridge address.
        code="""import socket,sys
for address,port in [(sys.argv[1],int(sys.argv[2])),(sys.argv[3],80)]:
 try:
  connection=socket.create_connection((address,port),timeout=2)
 except OSError: continue
 connection.close(); raise SystemExit(1)
"""
        run("run","--rm","--network",peer_net,"--entrypoint","/usr/bin/python3",args.image,"-c",code,gateway,str(port),private_ip,timeout=15)
        print("PASS: loopback-only publication, no ONCE registration, separate application network, peer-network denial")
    finally:
        for kind,target in reversed(created):
            command=("rm","-f",target) if kind=="container" else (kind,"rm",target)
            run(*command)

if __name__ == "__main__":main()
