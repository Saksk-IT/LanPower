"""Generate separate cloud, gateway, and phone credentials on a trusted computer."""

from __future__ import annotations

import argparse
import ipaddress
import json
import os
from pathlib import Path
import secrets
from urllib.parse import urlsplit


def write_private(path: Path, value: str):
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
        handle.write(value)
    os.chmod(path, 0o600)


def main():
    parser = argparse.ArgumentParser(description="Prepare LanPower remote credentials")
    parser.add_argument("--cloud-url", required=True)
    parser.add_argument("--lan-config", type=Path, required=True, help="Windows LanPower config.json")
    parser.add_argument("--gateway-id", default="home-router")
    parser.add_argument("--mac", required=True)
    parser.add_argument("--broadcast", required=True)
    parser.add_argument("--database", default="/var/lib/lanpower-cloud/relay.db")
    parser.add_argument("--output", type=Path, default=Path("private"))
    args = parser.parse_args()
    origin = urlsplit(args.cloud_url)
    if (origin.scheme != "https" or not origin.hostname or origin.path or origin.query
            or origin.fragment or origin.username or origin.password):
        parser.error("--cloud-url must be an HTTPS origin")
    if args.output.exists():
        parser.error("output directory already exists; choose a new directory")
    lan = json.loads(args.lan_config.read_text(encoding="utf-8"))
    from cloud_remote.server import Config, HEX_SECRET
    if not isinstance(lan.get("token"), str) or not HEX_SECRET.fullmatch(lan["token"]):
        parser.error("LAN token is invalid")
    try:
        ipaddress.IPv4Address(lan["host_ip"])
        ipaddress.IPv4Address(args.broadcast)
    except (KeyError, ipaddress.AddressValueError):
        parser.error("PC or broadcast IPv4 address is invalid")
    if not isinstance(lan.get("port"), int) or not 1 <= lan["port"] <= 65535:
        parser.error("Windows API port is invalid")
    gateway_secret = secrets.token_hex(32)
    client_secret = secrets.token_hex(32)
    cloud = {
        "gateway_id": args.gateway_id, "gateway_secret": gateway_secret,
        "client_secret": client_secret, "database": args.database, "listen_port": 8765,
    }
    Config(args.gateway_id, gateway_secret, client_secret, Path(args.database)).validate()
    gateway = {
        "gateway_id": args.gateway_id, "gateway_secret": gateway_secret,
        "cloud_url": args.cloud_url, "pc_ip": lan["host_ip"], "port": lan["port"],
        "mac": args.mac, "broadcast": args.broadcast, "lan_token": lan["token"],
    }
    pairing = f"{args.cloud_url}/#lanpower-remote={args.gateway_id}.{client_secret}"
    args.output.mkdir(mode=0o700, parents=True)
    write_private(args.output / "cloud.json", json.dumps(cloud, indent=2) + "\n")
    write_private(args.output / "gateway.json", json.dumps(gateway, indent=2) + "\n")
    write_private(args.output / "remote-pairing.txt", pairing + "\n")
    try:
        import qrcode
        from qrcode.image.svg import SvgPathImage
        image = qrcode.make(pairing, image_factory=SvgPathImage, border=2, box_size=8)
        image.save(str(args.output / "remote-pairing.svg"))
        os.chmod(args.output / "remote-pairing.svg", 0o600)
    except ImportError:
        print("Install qrcode==8.2 to generate remote-pairing.svg from remote-pairing.txt")
    print(f"Private setup files created in {args.output.resolve()}")


if __name__ == "__main__":
    main()
