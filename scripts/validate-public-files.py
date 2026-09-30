"""Check tracked runtime files and staged gateway examples before publication."""
import json
from pathlib import Path, PurePosixPath
import re
import subprocess


ROOT = Path(__file__).resolve().parent.parent
PRIVATE_NAMES = {
    "agents.md", "project.private.config.json", "config.json", "gateway.json",
    "cloud.json", "device-credentials.json", "credentials.dat",
    "command-receipts.json", "cloud-replay.jsonl", "gateway.lock", "seen.json",
    "setup-code",
}
LOCAL_DOCUMENTS = {
    "docs/architecture-v2-cloud-direct.md",
    "docs/router-gateway-implementation.md",
}
EXAMPLE_VALUES = {
    "mac": "02-11-22-33-44-55",
    "pc_ip": "192.168.1.100",
    "broadcast": "192.168.1.255",
    "cloud_url": "https://power.example.com",
}
SECRET_FIELDS = {
    "gateway_secret", "lan_token", "access_token", "refresh_token",
    "client_secret", "password",
}


def git(*args: str) -> bytes:
    return subprocess.check_output(["git", *args], cwd=ROOT)


def check_example(value, location: str, errors: list[str]) -> None:
    if isinstance(value, list):
        for index, item in enumerate(value):
            check_example(item, f"{location}[{index}]", errors)
    elif isinstance(value, dict):
        for key, item in value.items():
            field = f"{location}.{key}"
            normalized = item.upper().replace(":", "-") if key == "mac" and isinstance(item, str) else item
            if key in EXAMPLE_VALUES and normalized != EXAMPLE_VALUES[key]:
                errors.append(f"{field}: use the documented demonstration value")
            if key in SECRET_FIELDS and item not in (None, "") and not (
                isinstance(item, str) and item.startswith("REPLACE_")
            ):
                errors.append(f"{field}: use a REPLACE_ placeholder")
            check_example(item, field, errors)


def main() -> None:
    paths = git("ls-files", "-z").decode("utf-8").split("\0")
    errors: list[str] = []
    for path in filter(None, paths):
        parts = PurePosixPath(path.lower())
        name = parts.name
        is_page_config = path == "mini_program/pages/cloud/cloud.json"
        if ((name in PRIVATE_NAMES and not is_page_config) or "private" in parts.parts
                or name == ".env" or name.startswith(".env.") and name != ".env.example"
                or name.endswith((".db", ".sqlite", ".sqlite3", ".log")) or ".log." in name
                or "recovery-codes" in name and name.endswith(".txt")
                or path.lower() in LOCAL_DOCUMENTS):
            errors.append(f"{path}: private runtime file or local document must not be tracked")
    for path in ("router_gateway/config.example.json", "router_gateway/config.v2.example.json"):
        check_example(json.loads(git("show", f":{path}")), path, errors)
    path = "mini_program/utils/wol.js"
    source = git("show", f":{path}").decode("utf-8")
    for name, field in (("PC_MAC", "mac"), ("BROADCAST", "broadcast")):
        match = re.search(rf"(?m)^const\s+{name}\s*=\s*['\"]([^'\"]+)['\"]", source)
        if match is None:
            errors.append(f"{path}.{name}: expected a demonstration default")
        else:
            check_example({field: match[1]}, path, errors)
    if errors:
        raise SystemExit("\n".join(errors))
    print("Public file paths, gateway examples and mini-program defaults verified")


if __name__ == "__main__":
    main()
