import importlib.util
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import unittest

SCRIPT = Path(__file__).resolve().parents[1] / "validate-public-files.py"
spec = importlib.util.spec_from_file_location("public_files", SCRIPT)
validator = importlib.util.module_from_spec(spec)
spec.loader.exec_module(validator)


class PublicationChecks(unittest.TestCase):
    def test_private_paths_and_public_page_configuration(self):
        for path in ("nested/AGENTS.md", ".env.production", "nested/key.pem", "private/notes.md",
                     "data/platform.db-wal", "mini_program/project.private.config.json",
                     "user/codex-remote.json", "user/auth.json", ".codex/config.toml", "codex-home/sessions/rollout.jsonl"):
            self.assertTrue(validator.private_path(path), path)
        for path in ("deploy/docker/.env.example", "mini_program/pages/cloud/cloud.json", "README.md"):
            self.assertFalse(validator.private_path(path), path)

    def test_sensitive_content_is_rejected_without_echoing_it(self):
        for value in ("wx" + "a" * 16, "ghp_" + "A" * 36, "-----BEGIN " + "PRIVATE KEY-----",
                      "10" + "-AB" * 5):
            errors = []
            validator.check_content(value, "example.txt", errors)
            self.assertTrue(errors)
            self.assertNotIn(value, "\n".join(errors))

    def test_demonstration_macs_are_allowed(self):
        errors = []
        validator.check_content("02-11-22-33-44-55 00:11:22:33:44:55 ff:ff:ff:ff:ff:ff", "test.txt", errors)
        self.assertEqual([], errors)

    def test_svg_coordinates_are_not_partial_mac_addresses(self):
        errors = []
        validator.check_content(
            '<path d="M551 386c30-18 75-9 101 15-8 35-32 59-68 61-23-10-34-35-33-76z"/>'
            '<path d="M607 250c14-16 37-23 59-17-12-19-37-24-60-13-13 7-22 19-26 34z"/>',
            "drawing.html", errors)
        self.assertEqual([], errors)
        for separator in ("-", ":"):
            value = separator.join(("10", "11", "22", "33", "44", "55"))
            errors = []
            validator.check_content('mac:"' + value + '"', "device.json", errors)
            self.assertTrue(errors)
            self.assertNotIn(value, "\n".join(errors))

    def test_staged_secret_cannot_be_hidden_by_clean_working_copy(self):
        with tempfile.TemporaryDirectory() as folder:
            root = Path(folder)
            (root / "scripts").mkdir()
            shutil.copyfile(SCRIPT, root / "scripts/validate-public-files.py")
            for name in ("router_gateway/config.example.json", "router_gateway/config.v2.example.json",
                         "mini_program/utils/wol.js", "mini_program/project.config.json"):
                target = root / name
                target.parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(SCRIPT.parent.parent / name, target)
            def git(*args):
                subprocess.run(["git", *args], cwd=root, capture_output=True, check=True)
            git("init")
            git("config", "user.name", "Publication test")
            git("config", "user.email", "test@users.noreply.github.com")
            git("add", ".")
            git("commit", "-m", "test fixture")
            sentinel = root / "release-note.txt"
            sentinel.write_text("wx" + "a" * 16, encoding="utf-8")
            git("add", "release-note.txt")
            sentinel.write_text("safe working copy", encoding="utf-8")
            result = subprocess.run([sys.executable, str(root / "scripts/validate-public-files.py")],
                                    cwd=root, capture_output=True, text=True)
            self.assertNotEqual(0, result.returncode)
            self.assertIn("personal WeChat AppID", result.stderr)
            git("add", "release-note.txt")
            result = subprocess.run([sys.executable, str(root / "scripts/validate-public-files.py")],
                                    cwd=root, capture_output=True, text=True)
            self.assertEqual(0, result.returncode, result.stderr)


if __name__ == "__main__":
    unittest.main()
