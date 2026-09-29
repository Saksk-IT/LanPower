"""Run the router shell installer against temporary files and fake router commands."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path
import signal
import subprocess
import tempfile
import time
import unittest


SCRIPTS = Path(__file__).resolve().parents[1] / "scripts"


@unittest.skipUnless(os.name == "posix", "router shell integration tests require Linux")
class InstallTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.base = root / "data"
        self.run_dir = root / "run"
        self.tools = root / "tools"
        self.uci_dir = root / "uci"
        for directory in (self.base, self.run_dir, self.tools, self.uci_dir):
            directory.mkdir()
        self.config_source = root / "gateway-source.json"
        self.config_source.write_text('{"lan_token":"synthetic-test-only"}\n', encoding="utf-8")
        self.env = os.environ.copy()
        self.env.update({
            "PATH": f"{self.tools}:{self.env['PATH']}",
            "LANPOWER_BASE": str(self.base),
            "LANPOWER_RUN_DIR": str(self.run_dir),
            "LANPOWER_START_DELAY": "0",
            "LANPOWER_RESTART_DELAY": "1",
            "LANPOWER_HEALTH_WAIT": "3",
            "LANPOWER_HEALTH_STABLE": "1",
            "LANPOWER_STOP_WAIT": "2",
            "LANPOWER_DROPBEAR_INIT": str(root / "dropbear"),
            "MOCK_UCI_DIR": str(self.uci_dir),
            "MOCK_NVRAM_LOG": str(root / "nvram.log"),
            "MOCK_START_LOG": str(root / "start.log"),
        })
        self.write_tool("uname", """#!/bin/sh
if [ "${1:-}" = -m ]; then echo aarch64; else /usr/bin/uname "$@"; fi
""")
        self.write_tool("uci", """#!/bin/sh
if [ "${1:-}" = -q ]; then shift; fi
case "$1" in
  get) cat "$MOCK_UCI_DIR/$2" 2>/dev/null ;;
  set) key=${2%%=*}; value=${2#*=}; printf '%s' "$value" > "$MOCK_UCI_DIR/$key" ;;
  delete) rm -f "$MOCK_UCI_DIR/$2" "$MOCK_UCI_DIR/$2".* ;;
  commit) exit 0 ;;
  *) exit 1 ;;
esac
""")
        self.write_tool("nvram", """#!/bin/sh
printf '%s\n' "$*" >> "$MOCK_NVRAM_LOG"
""")
        dropbear = Path(self.env["LANPOWER_DROPBEAR_INIT"])
        dropbear.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        dropbear.chmod(0o700)
        self.addCleanup(self.stop_processes)

    def write_tool(self, name: str, content: str) -> Path:
        path = self.tools / name
        path.write_text(content, encoding="utf-8")
        path.chmod(0o700)
        return path

    def fake_gateway(self, version: str, behavior: str = "run") -> Path:
        path = Path(self.temp.name) / f"gateway-{version}"
        path.write_text(f"""#!/bin/sh
case "$*" in
  *-check-config*) {'exit 1' if behavior == 'invalid' else 'exit 0'} ;;
esac
printf '%s\\n' '{version}' >> "$MOCK_START_LOG"
{'exit 1' if behavior == 'crash' else 'exec sleep 3600'}
""", encoding="utf-8")
        path.chmod(0o700)
        return path

    def install(self, binary: Path) -> subprocess.CompletedProcess:
        return subprocess.run(["sh", str(SCRIPTS / "install.sh"), str(binary), str(self.config_source)],
                              env=self.env, capture_output=True, text=True, timeout=25)

    def live_pid(self, filename: str) -> int:
        pid = int((self.run_dir / filename).read_text(encoding="utf-8").strip())
        self.assertTrue(self.is_alive(pid), f"PID {pid} is not running")
        return pid

    @staticmethod
    def is_alive(pid: int) -> bool:
        try:
            os.kill(pid, 0)
            stat = Path(f"/proc/{pid}/stat")
            return not stat.exists() or stat.read_text(encoding="utf-8").split()[2] != "Z"
        except (OSError, IndexError):
            return False

    def stop_processes(self):
        pids = []
        for name in ("lanpower-gateway-supervisor.pid", "lanpower-gateway-child.pid"):
            path = self.run_dir / name
            if path.exists():
                try:
                    pids.append(int(path.read_text(encoding="utf-8")))
                except ValueError:
                    pass
        for pid in pids:
            if self.is_alive(pid):
                os.kill(pid, signal.SIGTERM)
        deadline = time.monotonic() + 3
        while time.monotonic() < deadline and any(self.is_alive(pid) for pid in pids):
            time.sleep(0.05)
        for pid in pids:
            if self.is_alive(pid):
                os.kill(pid, signal.SIGKILL)

    def test_normal_first_install_uses_no_ssh(self):
        result = self.install(self.fake_gateway("v1"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.live_pid("lanpower-gateway-supervisor.pid")
        self.live_pid("lanpower-gateway-child.pid")
        self.assertIn("v1", (self.base / "lanpower-gateway").read_text(encoding="utf-8"))
        self.assertEqual((self.base / "maintenance.conf").read_text(encoding="utf-8").strip(), "maintenance_ssh=false")
        self.assertFalse(Path(self.env["MOCK_NVRAM_LOG"]).exists())
        self.assertEqual((self.uci_dir / "firewall.lanpower_startup.reload").read_text(encoding="utf-8"), "1")

    def test_normal_upgrade_keeps_previous_binary(self):
        self.assertEqual(self.install(self.fake_gateway("v1")).returncode, 0)
        first_pid = self.live_pid("lanpower-gateway-child.pid")
        result = self.install(self.fake_gateway("v2"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotEqual(self.live_pid("lanpower-gateway-child.pid"), first_pid)
        self.assertFalse(self.is_alive(first_pid))
        self.assertIn("v2", (self.base / "lanpower-gateway").read_text(encoding="utf-8"))
        self.assertIn("v1", (self.base / "lanpower-gateway.previous").read_text(encoding="utf-8"))

    def test_failed_upgrade_restores_previous_and_secrets(self):
        self.assertEqual(self.install(self.fake_gateway("v1")).returncode, 0)
        config_before = hashlib.sha256((self.base / "gateway.json").read_bytes()).digest()
        startup_before = (self.base / "startup.sh").read_bytes()
        uci_before = {p.name: p.read_bytes() for p in self.uci_dir.iterdir()}
        result = self.install(self.fake_gateway("bad", "crash"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("upgrade failed and rolled back", result.stderr)
        self.assertIn("v1", (self.base / "lanpower-gateway").read_text(encoding="utf-8"))
        self.assertEqual((self.base / "startup.sh").read_bytes(), startup_before)
        self.assertEqual({p.name: p.read_bytes() for p in self.uci_dir.iterdir()}, uci_before)
        self.assertEqual(hashlib.sha256((self.base / "gateway.json").read_bytes()).digest(), config_before)
        self.live_pid("lanpower-gateway-child.pid")

    def test_invalid_candidate_leaves_current_process_untouched(self):
        self.assertEqual(self.install(self.fake_gateway("v1")).returncode, 0)
        first_pid = self.live_pid("lanpower-gateway-child.pid")
        startup_before = (self.base / "startup.sh").read_bytes()
        config_before = (self.base / "gateway.json").read_bytes()
        result = self.install(self.fake_gateway("invalid", "invalid"))
        self.assertNotEqual(result.returncode, 0)
        self.assertNotIn("rolled back", result.stderr)
        self.assertEqual(self.live_pid("lanpower-gateway-child.pid"), first_pid)
        self.assertIn("v1", (self.base / "lanpower-gateway").read_text(encoding="utf-8"))
        self.assertEqual((self.base / "startup.sh").read_bytes(), startup_before)
        self.assertEqual((self.base / "gateway.json").read_bytes(), config_before)

    def test_first_install_failure_does_not_claim_rollback(self):
        result = self.install(self.fake_gateway("bad", "crash"))
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("no previous Gateway to restore", result.stderr)
        self.assertNotIn("upgrade failed and rolled back", result.stderr)
        self.assertFalse((self.base / "lanpower-gateway").exists())
        self.assertTrue((self.base / "gateway.json").exists())

    def test_legacy_upgrade_preserves_ssh_only_as_explicit_option(self):
        (self.base / "lanpower-gateway").write_bytes(self.fake_gateway("legacy").read_bytes())
        (self.base / "startup.sh").write_text("#!/bin/sh\nnvram set ssh_en=1\n", encoding="utf-8")
        result = self.install(self.fake_gateway("v2"))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertIn("Migrated existing SSH recovery", result.stdout)
        self.assertEqual((self.base / "maintenance.conf").read_text(encoding="utf-8").strip(), "maintenance_ssh=true")
        self.assertIn("set ssh_en=1", Path(self.env["MOCK_NVRAM_LOG"]).read_text(encoding="utf-8"))


if __name__ == "__main__":
    unittest.main()
