"""Audit the npm packages that actually ship in the service image.

Reads the package@version directories of a `pnpm deploy` output
(node_modules/.pnpm) and asks the OSV database (api.osv.dev) for known
vulnerabilities in each exact version. Exits 1 if any are found.

    python3 scripts/audit_runtime.py DEPLOY_DIR
"""
import json
import re
import sys
import urllib.request
from pathlib import Path

OSV = "https://api.osv.dev/v1/querybatch"


def shipped(deploy_dir):
    out = []
    for d in sorted((Path(deploy_dir) / "node_modules" / ".pnpm").iterdir()):
        m = re.fullmatch(r"(@?[^@]+?)@(\d[^_(]*)(?:[_(].*)?", d.name)
        if not m:
            continue  # workspace links (e.g. @dtax+shared-types@file+...) and lock.yaml
        out.append((m.group(1).replace("+", "/", 1) if m.group(1).startswith("@") else m.group(1), m.group(2)))
    return out


def query(pkgs):
    body = json.dumps({"queries": [{"package": {"ecosystem": "npm", "name": n}, "version": v} for n, v in pkgs]})
    req = urllib.request.Request(OSV, data=body.encode(), headers={"content-type": "application/json"})
    with urllib.request.urlopen(req, timeout=60) as r:  # nosec B310 - fixed https URL
        return json.load(r)["results"]


def main(argv):
    if len(argv) != 1:
        print(__doc__)
        return 2
    pkgs = shipped(argv[0])
    if not pkgs:
        print("FAIL: no packages found", file=sys.stderr)
        return 1
    found = 0
    for (name, ver), res in zip(pkgs, query(pkgs)):
        ids = [v["id"] for v in res.get("vulns", [])]
        if ids:
            found += 1
            print(f"VULNERABLE {name}@{ver}: {', '.join(ids)}")
    print(f"{'FAIL' if found else 'OK'}: {len(pkgs)} shipped packages checked against OSV, {found} with known vulnerabilities")
    return 1 if found else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
