"""Reject mixed or incomplete Codex Web builds before packaging/deployment."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import tomllib


def verify_scopes(javascript: list[str], css: list[str]) -> int:
    scopes = lambda chunks: set(re.findall(r"data-v-[\da-f]{8}", "\n".join(chunks)))
    missing = scopes(javascript) - scopes(css)
    if missing:
        raise ValueError("Codex Web scripts and scoped styles are from different builds")
    return len(scopes(javascript))


def record_assets(directory: Path, version: str, commit: str | None, built_version: str) -> None:
    files = {path.relative_to(directory).as_posix(): hashlib.sha256(path.read_bytes()).hexdigest()
             for path in sorted(directory.rglob("*"))
             if path.is_file() and path.suffix in {".js", ".css"}}
    verify_scopes([(directory / name).read_text(encoding="utf-8") for name in files if name.endswith(".js")],
                  [(directory / name).read_text(encoding="utf-8") for name in files if name.endswith(".css")])
    manifest = {"format": 1, "version": version, "builtVersion": built_version, "files": files}
    if commit:
        manifest["restoredFrom"] = commit
    (directory / "asset-integrity.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")


def verify_assets(directory: Path, expected_version: str | None = None) -> dict:
    manifest = json.loads((directory / "asset-integrity.json").read_text(encoding="utf-8"))
    if manifest.get("format") != 1 or not re.fullmatch(r"\d+\.\d+\.\d+", manifest.get("version", "")):
        raise ValueError("Invalid Codex Web asset manifest")
    if expected_version and manifest["version"] != expected_version:
        raise ValueError("Codex Web assets do not match the product version")
    files = manifest["files"]
    actual = {path.relative_to(directory).as_posix() for path in directory.rglob("*")
              if path.is_file() and path.suffix in {".js", ".css"}}
    if set(files) != actual or not {"codex.js", "codex.css"}.issubset(files):
        raise ValueError("Codex Web assets are incomplete or contain unverified files")
    javascript, css = [], []
    for name, digest in files.items():
        if not re.fullmatch(r"[\w./-]+\.(?:js|css)", name) or ".." in Path(name).parts:
            raise ValueError("Invalid Codex Web asset path")
        content = (directory / name).read_bytes()
        if hashlib.sha256(content).hexdigest() != digest:
            raise ValueError(f"Codex Web asset differs from its build: {name}")
        (css if name.endswith(".css") else javascript).append(content.decode("utf-8"))
    component_count = verify_scopes(javascript, css)
    return {"version": manifest["version"], "files": len(files), "scopedComponents": component_count}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("directory", nargs="?", type=Path,
                        default=Path(__file__).resolve().parents[1] / "cloud_app/static/codex-ui")
    parser.add_argument("--version")
    parser.add_argument("--version-file", type=Path, help="Cloud pyproject.toml to check against")
    record = parser.add_mutually_exclusive_group()
    record.add_argument("--record-restored-from", help="Record a byte-for-byte historical restoration without rebuilding")
    record.add_argument("--record-build", action="store_true", help="Verify and record a complete new build")
    parser.add_argument("--built-version")
    args = parser.parse_args()
    try:
        version = args.version
        if args.version_file:
            version = tomllib.loads(args.version_file.read_text(encoding="utf-8"))["project"]["version"]
        if args.record_restored_from:
            if not version or not args.built_version:
                parser.error("Restoration requires --version and --built-version")
            record_assets(args.directory, version, args.record_restored_from, args.built_version)
        elif args.record_build:
            if not version:
                parser.error("A new build requires --version or --version-file")
            record_assets(args.directory, version, None, version)
        print(json.dumps(verify_assets(args.directory, version)))
    except (OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit(f"Codex Web asset verification failed: {error}")
