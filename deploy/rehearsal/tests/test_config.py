import copy
from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import unittest

MODULE = Path(__file__).resolve().parents[1] / "prepare_config.py"
spec = importlib.util.spec_from_file_location("prepare_config", MODULE)
config = importlib.util.module_from_spec(spec)
spec.loader.exec_module(config)
NOW = datetime(2026, 10, 11, tzinfo=timezone.utc)

def fixture(provider="gcp"):
    providers = {
        "gcp": {"gcp-project": "synthetic-project", "gcp-zone": "europe-west3-a", "gcp-network": "synthetic-network", "gcp-subnet": "synthetic-subnet", "gcp-machine-type": "e2-small", "gcp-image-project": "ubuntu-os-cloud", "gcp-image-family": "ubuntu-2404-lts-amd64", "gcp-boot-disk-size-gb": 50, "gcp-boot-disk-type": "pd-balanced"},
        "digitalocean": {"digitalocean-account-id": "synthetic-account", "digitalocean-region": "fra1", "digitalocean-vpc-id": "synthetic-vpc", "digitalocean-size": "s-1vcpu-2gb", "digitalocean-image": "ubuntu-24-04-x64"},
        "oci": {"oci-config-file-profile": "SYNTHETIC", "oci-auth": "security_token", "oci-region": "eu-frankfurt-1", "oci-compartment-id": "ocid1.compartment.synthetic", "oci-subnet-id": "ocid1.subnet.synthetic", "oci-availability-domain": "synthetic-ad", "oci-shape": "VM.Standard.A1.Flex", "oci-ocpus": 1, "oci-memory-in-gbs": 6, "oci-boot-volume-size-in-gbs": 50, "oci-boot-volume-vpus-per-gb": 10},
    }
    return {"profile": "wiki-clone-synthetic", "source": {"profile": "synthetic-source", "deploymentId": "11111111-1111-4111-8111-111111111111", "host": "wiki.example.test"}, "provider": provider, "providerFields": providers[provider], "sshSources": ["203.0.113.7/32"], "cloneHost": "wiki-clone.localhost", "oldImage": "ghcr.io/example/wiki@sha256:" + "a" * 64, "candidateImage": "ghcr.io/example/wiki@sha256:" + "b" * 64, "appCPUs": 1, "appMemoryMB": 2048, "expiresUtc": "2026-10-12T00:00:00Z", "maximumCostUSD": 10}

class ConfigurationTests(unittest.TestCase):
    def test_three_phases_preserve_identity_and_exclude_public_delivery(self):
        for provider in config.PROVIDER_FIELDS:
            phases = config.phases(fixture(provider), NOW)
            self.assertEqual(phases["host.yml"]["once"]["applications"], [])
            for phase in phases.values():
                self.assertEqual(phase["compute-http-sources"], [])
                self.assertEqual(phase["provider-smtp"], "no-infra")
                self.assertEqual(phase["provider-dns"], "no-infra")
                self.assertEqual(phase["state-file"], ".colors.sqlite")
            old, new = [phases[name]["once"]["applications"][0] for name in ("restored.yml", "candidate.yml")]
            self.assertEqual({**old, "image": new["image"]}, new)
            self.assertTrue(old["disable_tls"])
            self.assertEqual(old["deploy-strategy"], "stop-first")
            self.assertNotIn("github", old)
            self.assertTrue(phases["restored.yml"]["compute-require-existing-state"])
            self.assertTrue(all(value.startswith("app-wikicontext-rehearsal-") for value in old["env"].values()))

    def test_public_network_production_host_and_source_identity_refused(self):
        for key, value in [("sshSources", ["0.0.0.0/0"]), ("sshSources", ["203.0.113.0/24"]), ("cloneHost", "wiki.pocketcontext.com"), ("profile", "synthetic-source"), ("oldImage", "ghcr.io/example/wiki:latest"), ("maximumCostUSD", 0), ("expiresUtc", "2026-11-01T00:00:00Z")]:
            with self.subTest(key=key):
                data = fixture(); data[key] = value
                with self.assertRaises(config.Invalid): config.phases(data, NOW)

    def test_extra_bindings_or_provider_fields_refused(self):
        for where in ("root", "provider"):
            data = fixture()
            if where == "root": data["env"] = {"SECRET": "synthetic"}
            else: data["providerFields"]["access-token"] = "synthetic"
            with self.assertRaises(config.Invalid): config.phases(data, NOW)

if __name__ == "__main__": unittest.main()
