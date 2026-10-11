import importlib.util
import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('local_once', Path(__file__).parents[1] / 'local_once.py')
m = importlib.util.module_from_spec(spec)
spec.loader.exec_module(m)


class LocalOnceTests(unittest.TestCase):
    def test_binary_checksum_before_docker(self):
        with tempfile.TemporaryDirectory() as root:
            binary = Path(root) / 'once'
            binary.write_bytes(b'not pinned')
            with patch.object(m.Engine, 'outer') as docker:
                with self.assertRaises(ValueError):
                    m.Engine.create(binary)
                docker.assert_not_called()

    def test_name_scope(self):
        for name in ['once', 'wiki-once-production', 'wiki-once-' + '../' * 12]:
            with self.assertRaises(ValueError):
                m.Engine(name)

    def test_cleanup_does_not_need_running_port_allocation(self):
        engine = m.Engine('wiki-once-33c60524-b4e4-480a-85bc-546e09aec4c5')
        record = {'Config': {'Labels': {m.LABEL: engine.name}, 'Image': m.DIND}, 'Mounts': [{'Type': 'volume', 'Name': engine.volume, 'Destination': '/var/lib/docker'}], 'HostConfig': {'NetworkMode': 'default', 'PidMode': '', 'RestartPolicy': {'Name': 'no'}, 'Memory': 4 * 1024**3, 'NanoCpus': 2 * 10**9, 'PortBindings': {'80/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}], '9000/tcp': [{'HostIp': '127.0.0.1', 'HostPort': ''}]}}, 'NetworkSettings': {'Ports': {}}, 'State': {'Running': False}}
        with patch.object(engine, 'outer', side_effect=lambda *args: json.dumps([record]).encode()):
            self.assertEqual(engine.inspect(cleanup=True), {})
            record['HostConfig']['PortBindings']['80/tcp'][0]['HostIp'] = '0.0.0.0'
            with self.assertRaises(RuntimeError):
                engine.inspect(cleanup=True)

    def test_unclean_stop_prevents_update(self):
        engine = m.Engine('wiki-once-33c60524-b4e4-480a-85bc-546e09aec4c5')
        state = {'name': 'once-app-wiki', 'running': False, 'exit_code': 137, 'oom': False}
        with patch.object(m, 'application', return_value=state), patch.object(engine, 'docker'), patch.object(engine, 'once') as once:
            with self.assertRaises(RuntimeError):
                m.update(engine, 'registry/wiki@sha256:' + 'a' * 64)
            once.assert_not_called()

    def test_rebind_changes_only_replica_binding_and_preserves_data(self):
        import io
        import tarfile
        import hashlib
        with tempfile.TemporaryDirectory() as root:
            source, rebound = Path(root) / 'old.tar.gz', Path(root) / 'rollback.tar.gz'
            settings = {'host': 'wiki-rehearsal.localhost', 'disableTLS': True, 'autoUpdate': False, 'env': {'LITESTREAM_PATH': 'old/path', 'SYNTHETIC_SECRET': 'private'}, 'backup': {}}
            values = {'once.application.json': json.dumps(settings).encode(), 'once.volume.json': b'{}', 'data/pb_data/data.db': b'synthetic database'}
            with tarfile.open(source, 'w:gz') as archive:
                for name, payload in values.items():
                    entry = tarfile.TarInfo(name)
                    entry.size = len(payload)
                    archive.addfile(entry, io.BytesIO(payload))
            before = hashlib.sha256(source.read_bytes()).hexdigest()
            receipt = m.rebind_replica(source, rebound, 'rehearsals/33c60524-b4e4-480a-85bc-546e09aec4c5/data.db')
            self.assertEqual(receipt['source_sha256'], before)
            self.assertEqual(hashlib.sha256(source.read_bytes()).hexdigest(), before)
            with tarfile.open(rebound) as archive:
                actual = {entry.name: archive.extractfile(entry).read() for entry in archive}
            self.assertEqual(actual['data/pb_data/data.db'], values['data/pb_data/data.db'])
            changed = json.loads(actual['once.application.json'])
            changed['env']['LITESTREAM_PATH'] = settings['env']['LITESTREAM_PATH']
            self.assertEqual(changed, settings)

    def test_rebind_refuses_traversal(self):
        import io
        import tarfile
        with tempfile.TemporaryDirectory() as root:
            source, rebound = Path(root) / 'bad.tar.gz', Path(root) / 'rollback.tar.gz'
            with tarfile.open(source, 'w:gz') as archive:
                entry = tarfile.TarInfo('data/../escape')
                entry.size = 1
                archive.addfile(entry, io.BytesIO(b'x'))
            with self.assertRaises(ValueError):
                m.rebind_replica(source, rebound, 'rehearsals/33c60524-b4e4-480a-85bc-546e09aec4c5/data.db')
