"""Check the Git index and commit metadata before publishing source or packages."""
import json
from pathlib import Path, PurePosixPath
import re
import subprocess


ROOT = Path(__file__).resolve().parent.parent
PRIVATE_NAMES = {
    "agents.md", "project.private.config.json", "config.json", "gateway.json",
    "cloud.json", "device-credentials.json", "credentials.dat",
    "command-receipts.json", "cloud-replay.jsonl", "gateway.lock", "seen.json",
    "setup-code", "auto-targets.json", "codex-remote.json", "auth.json", "tokens.json",
}
LOCAL_DOCUMENTS = {
    "router-gateway-implementation.md",
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
CONTENT_PATTERNS = {
    "personal WeChat AppID": re.compile(r"\bwx[0-9a-fA-F]{16}\b"),
    "private key": re.compile(r"-----BEGIN (?:[A-Z0-9]+ )?PRIVATE KEY-----"),
    "GitHub credential": re.compile(r"\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b"),
}
# A MAC is a complete token, not six numbers within a longer SVG coordinate run.
MAC_PATTERN = re.compile(r"(?i)(?<![\w-])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![\w-])")
PUBLIC_MACS = {"00-00-00-00-00-00", "FF-FF-FF-FF-FF-FF", "00-11-22-33-44-55"}


def private_path(path: str) -> bool:
    parts = PurePosixPath(path.lower())
    name = parts.name
    return ((name in PRIVATE_NAMES and path != "mini_program/pages/cloud/cloud.json")
            or any(part in parts.parts for part in ("private", ".codex", "codex-home")) or name == ".env"
            or name.startswith(".env.") and name != ".env.example"
            or name.endswith((".db", ".sqlite", ".sqlite3", ".log", ".pem", ".key", ".pfx", ".p12",
                              ".db-wal", ".db-shm", ".sqlite-wal", ".sqlite-shm"))
            or ".log." in name or ".local." in name or ".private." in name
            or "recovery-codes" in name and name.endswith(".txt")
            or path.lower() in LOCAL_DOCUMENTS)


def check_content(source: str, path: str, errors: list[str]) -> None:
    for description, pattern in CONTENT_PATTERNS.items():
        if pattern.search(source):
            errors.append(f"{path}: remove {description}; values are not printed")
    for match in MAC_PATTERN.finditer(source):
        mac = match[0].upper().replace(":", "-")
        if mac not in PUBLIC_MACS and not int(mac[:2], 16) & 2:
            errors.append(f"{path}: use a locally administered demonstration MAC")
            break


def staged_blobs():
    entries = git("ls-files", "--stage", "-z").split(b"\0")
    with subprocess.Popen(["git", "cat-file", "--batch"], cwd=ROOT,
                          stdin=subprocess.PIPE, stdout=subprocess.PIPE) as process:
        try:
            for entry in filter(None, entries):
                metadata, path = entry.split(b"\t", 1)
                _, oid, stage = metadata.split()
                if stage != b"0":
                    raise SystemExit("Resolve merge conflicts before publication")
                process.stdin.write(oid + b"\n")
                process.stdin.flush()
                header = process.stdout.readline().split()
                content = process.stdout.read(int(header[2]))
                process.stdout.read(1)
                yield path.decode("utf-8"), content
        finally:
            process.stdin.close()


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
    errors: list[str] = []
    for path, content in staged_blobs():
        if private_path(path):
            errors.append(f"{path}: private runtime file or local document must not be tracked")
        try:
            source = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        if "\0" not in source:
            check_content(source, path, errors)
    emails = git("log", "HEAD", "--format=%ae%n%ce").decode("utf-8").splitlines()
    if any(not (email.endswith("@users.noreply.github.com") or email == "noreply@github.com") for email in emails):
        errors.append("Commit metadata: use GitHub noreply addresses before publishing")
    config = json.loads(git("show", ":mini_program/project.config.json"))
    if config.get("appid") != "touristappid":
        errors.append("mini_program/project.config.json: use touristappid in the public project")
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
    print("Public file paths, staged contents, examples, AppID and commit email metadata verified")


if __name__ == "__main__":
    main()
