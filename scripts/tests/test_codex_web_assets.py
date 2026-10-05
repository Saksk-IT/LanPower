import hashlib
import importlib.util
import json
from pathlib import Path
import tempfile
import unittest


spec = importlib.util.spec_from_file_location(
    "codex_web_assets", Path(__file__).resolve().parents[1] / "verify-codex-web-assets.py")
assets = importlib.util.module_from_spec(spec)
spec.loader.exec_module(assets)


class WebAssetTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        (self.root / "assets").mkdir()
        (self.root / "codex.js").write_text('const scope="data-v-1234abcd";', encoding="utf-8")
        (self.root / "codex.css").write_text('.input[data-v-1234abcd]{display:flex}', encoding="utf-8")
        (self.root / "assets/language.js").write_text('export default {}', encoding="utf-8")
        self.manifest()

    def manifest(self):
        files = {path.relative_to(self.root).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
                 for path in self.root.rglob("*") if path.is_file() and path.suffix in {".js", ".css"}}
        (self.root / "asset-integrity.json").write_text(json.dumps(
            {"format": 1, "version": "1.23.3", "files": files}), encoding="utf-8")

    def test_complete_build(self):
        self.assertEqual(assets.verify_assets(self.root, "1.23.3")["files"], 3)

    def test_new_build_records_verified_files_without_restoration_claim(self):
        assets.record_assets(self.root, "1.23.3", None, "1.23.3")
        manifest = json.loads((self.root / "asset-integrity.json").read_text(encoding="utf-8"))
        self.assertNotIn("restoredFrom", manifest)
        self.assertEqual(assets.verify_assets(self.root, "1.23.3")["files"], 3)

    def test_replaced_stylesheet_rejected(self):
        (self.root / "codex.css").write_text('body{color:red}', encoding="utf-8")
        with self.assertRaisesRegex(ValueError, "differs from its build"):
            assets.verify_assets(self.root)

    def test_mixed_scoped_styles_rejected_even_with_valid_hashes(self):
        (self.root / "codex.css").write_text('.input[data-v-5678abcd]{display:flex}', encoding="utf-8")
        self.manifest()
        with self.assertRaisesRegex(ValueError, "different builds"):
            assets.verify_assets(self.root)

    def test_missing_dynamic_chunk_rejected(self):
        (self.root / "assets/language.js").unlink()
        with self.assertRaisesRegex(ValueError, "incomplete"):
            assets.verify_assets(self.root)

    def test_old_build_rejected(self):
        with self.assertRaisesRegex(ValueError, "product version"):
            assets.verify_assets(self.root, "1.23.4")


if __name__ == "__main__":
    unittest.main()
