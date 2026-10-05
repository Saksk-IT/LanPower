"""Package the public mini-program source with sanitized local HTTP tool settings."""

import argparse
import json
from pathlib import Path
import re
import subprocess
from zipfile import ZipFile, ZIP_DEFLATED


def main():
    root = Path(__file__).resolve().parents[1]
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", type=Path, default=root / "mini_program")
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    version = re.search(r"VERSION:\s*'([0-9]+\.[0-9]+\.[0-9]+)'",
                        (args.source / "utils/version.js").read_text(encoding="utf-8")).group(1)
    output = args.output or root / "windows/out" / f"CodexDock-mini-program-{version}.zip"
    files = subprocess.check_output(["git", "ls-files", "-z", "--", "mini_program"], cwd=root).decode().split("\0")
    output.parent.mkdir(parents=True, exist_ok=True)
    count = 0
    with ZipFile(output, "w", ZIP_DEFLATED) as archive:
        for name in filter(None, files):
            relative = name.removeprefix("mini_program/")
            if relative == "project.private.config.json":
                continue
            content = (args.source / relative).read_bytes()
            if relative == "project.config.json":
                config = json.loads(content)
                config["appid"] = "touristappid"
                content = (json.dumps(config, ensure_ascii=False, indent=2) + "\n").encode("utf-8")
            archive.writestr(relative, content)
            count += 1
        # Never copy the user's private project file, AppID or private tool preferences.
        archive.writestr("project.private.config.json", json.dumps({"setting": {"urlCheck": False}}, indent=2) + "\n")
    print(f"Local HTTP mini-program {version}: {count} public files and sanitized local tool settings -> {output}")


if __name__ == "__main__":
    main()
