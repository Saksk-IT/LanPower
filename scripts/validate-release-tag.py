"""Require the publication tag to match the product version in this checkout."""
from pathlib import Path
import re
import sys
import xml.etree.ElementTree as ET

root = Path(__file__).resolve().parent.parent
version = ET.parse(root / "windows/Directory.Build.props").findtext("PropertyGroup/Version")
if len(sys.argv) != 2 or not re.fullmatch(r"\d+\.\d+\.\d+", version or ""):
    raise SystemExit("Expected a version tag matching the product version")
if sys.argv[1] != f"refs/tags/v{version}":
    raise SystemExit(f"Publication requires refs/tags/v{version}; branch runs build artifacts only")
print(f"Publication tag verified: v{version}")
