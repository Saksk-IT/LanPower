"""Check the installed official Runtime without reading login files or running inference."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
import queue
import shutil
import subprocess
import tempfile
import threading


def verify(executable: str):
    with tempfile.TemporaryDirectory(prefix="LanPower-codex-protocol-") as temp:
        root = Path(temp).resolve()
        schema = root / "schema"
        result = subprocess.run([executable, "app-server", "generate-json-schema", "--out", str(schema)],
                                capture_output=True, timeout=45)
        if result.returncode: raise RuntimeError("schema_generation_failed")
        expected = {"ThreadStartParams": {"cwd", "model", "approvalPolicy", "sandbox"},
            "ThreadResumeParams": {"threadId", "approvalPolicy", "sandbox"},
            "ThreadListParams": {"cwd", "limit", "cursor", "sourceKinds"},
            "ThreadReadParams": {"threadId", "includeTurns"},
            "TurnStartParams": {"threadId", "input", "approvalPolicy", "sandboxPolicy"},
            "TurnInterruptParams": {"threadId", "turnId"},
            "TurnSteerParams": {"threadId", "expectedTurnId", "input"},
            "CommandExecutionRequestApprovalResponse": {"decision"},
            "FileChangeRequestApprovalResponse": {"decision"},
            "PermissionsRequestApprovalResponse": {"permissions", "scope"},
            "ToolRequestUserInputResponse": {"answers"}}
        for name, keys in expected.items():
            document = json.loads(next(schema.rglob(name + ".json")).read_text(encoding="utf-8"))
            if not keys <= document.get("properties", {}).keys(): raise RuntimeError("schema_incompatible")
        env = dict(os.environ, CODEX_HOME=str(root / "home"))
        (root / "home").mkdir()
        process = subprocess.Popen([executable, "app-server", "--listen", "stdio://"], cwd=root, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True,
            encoding="utf-8", creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        messages = queue.Queue()
        def read():
            for line in process.stdout: messages.put(json.loads(line))
        worker = threading.Thread(target=read, daemon=True); worker.start()
        def call(method, params, ident):
            process.stdin.write(json.dumps({"id": ident, "method": method, "params": params}) + "\n"); process.stdin.flush()
            while True:
                value = messages.get(timeout=30)
                if value.get("id") == ident:
                    if "error" in value: raise RuntimeError("runtime_rpc_failed")
                    return value["result"]
        try:
            call("initialize", {"clientInfo": {"name": "lanpower_verify", "version": "1.10.0"}}, "init")
            process.stdin.write('{"method":"initialized","params":{}}\n'); process.stdin.flush()
            call("thread/list", {"limit": 5}, "list")
            created = call("thread/start", {"cwd": str(root), "approvalPolicy": "on-request", "sandbox": "workspace-write"}, "start")
            listed = call("thread/list", {"cwd": str(root), "sourceKinds": ["cli", "vscode", "appServer", "unknown"]}, "after")
        finally:
            process.terminate(); process.wait(timeout=10); worker.join(timeout=5)
            process.stdin.close(); process.stdout.close()
        print("Official Codex Runtime: schema, stdio initialization, create and list passed; no login data or inference used. Empty threads remain local until their first turn.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(); parser.add_argument("--codex", default=shutil.which("codex"))
    options = parser.parse_args()
    if not options.codex: raise SystemExit("Codex CLI is not installed")
    verify(options.codex)
