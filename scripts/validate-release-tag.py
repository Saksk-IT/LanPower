"""Require the publication tag to match the product version in this checkout."""
from pathlib import Path
import re
import sys
import tomllib
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
version = (root / "VERSION").read_text(encoding="utf-8").strip()
windows = ET.parse(root / "windows/Directory.Build.props")
cloud = tomllib.loads((root / "cloud_app/pyproject.toml").read_text(encoding="utf-8"))["project"]["version"]
runtime = re.search(r'^VERSION = "([^"]+)"', (root / "cloud_app/app/main.py").read_text(encoding="utf-8"), re.M)
installer = re.search(r'^#define AppVersion "([^"]+)"', (root / "windows/installer/LanPower.iss").read_text(encoding="utf-8"), re.M)
if (windows.findtext("PropertyGroup/Version") != version
        or windows.findtext("PropertyGroup/FileVersion") != f"{version}.0"
        or cloud != version or runtime is None or runtime[1] != version
        or installer is None or installer[1] != version):
    raise SystemExit("VERSION, Windows, installer and Cloud versions must agree before publication")
if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", version or ""):
    raise SystemExit("Expected a version tag matching the product version")
if sys.argv[1] != f"refs/tags/v{version}":
    raise SystemExit(f"Publication requires refs/tags/v{version}; branch runs build artifacts only")
print(f"Publication tag verified: v{version}")
