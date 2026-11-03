"""Fetch and verify the pinned dTax tax engine (CLAUDE.md rule 5).

The engine is used exactly as published: no source change, fork, vendored
patch or monkey-patching. This tool is the single way the engine source
enters our builds, and it proves that what we build is byte-for-byte the
pinned upstream commit.

    python verify_engine.py fetch DEST     clone the pinned commit's engine paths into DEST and verify
    python verify_engine.py verify DIR     verify an existing copy (e.g. the engine-service build input)
    python verify_engine.py lock DIR       print a lock body for DIR (only when re-pinning)

The lock (engine.lock.json) records the upstream repository, the commit, the
git tree id of each pinned path, and a SHA-256 manifest digest over every file.
Standard library only.
"""
import hashlib
import json
import subprocess  # nosec B404 - runs git with fixed arguments and a pinned commit
import sys
from pathlib import Path

LOCK = Path(__file__).with_name("engine.lock.json")


class Mismatch(Exception):
    pass


def load_lock(path=None):
    return json.loads(Path(path or LOCK).read_text(encoding="utf-8"))


def _files(root, paths):
    root = Path(root)
    out = []
    for rel in paths:
        p = root / rel
        if p.is_symlink():
            raise Mismatch(f"symlink not allowed: {rel}")
        if p.is_file():
            out.append(rel)
        elif p.is_dir():
            for f in sorted(p.rglob("*")):
                if f.is_symlink():
                    raise Mismatch(f"symlink not allowed: {f.relative_to(root).as_posix()}")
                if f.is_file():
                    out.append(f.relative_to(root).as_posix())
        else:
            raise Mismatch(f"missing: {rel}")
    return sorted(set(out))


def manifest(root, paths):
    """{relative path: sha256} for every file under the pinned paths."""
    root = Path(root)
    return {rel: hashlib.sha256((root / rel).read_bytes()).hexdigest() for rel in _files(root, paths)}


def digest(files):
    h = hashlib.sha256()
    for rel in sorted(files):
        h.update(f"{rel}\0{files[rel]}\n".encode())
    return h.hexdigest()


def verify(root, lock=None):
    """Raise Mismatch naming every added, removed or changed file."""
    lock = lock or load_lock()
    got = manifest(root, lock["paths"])
    want = lock["files"]
    problems = [f"changed: {p}" for p in sorted(set(got) & set(want)) if got[p] != want[p]]
    problems += [f"added: {p}" for p in sorted(set(got) - set(want))]
    problems += [f"removed: {p}" for p in sorted(set(want) - set(got))]
    if problems or digest(got) != lock["manifest_sha256"]:
        raise Mismatch("engine source differs from the pin:\n  " + "\n  ".join(problems or ["manifest digest"]))
    return digest(got)


def _git(*args, cwd):
    return subprocess.run(["git", *args], cwd=cwd, check=True, capture_output=True, text=True).stdout.strip()  # nosec B603 B607


def fetch(dest, lock=None):
    """Shallow-fetch exactly the pinned commit and check out only the pinned paths."""
    lock = lock or load_lock()
    dest = Path(dest)
    dest.mkdir(parents=True, exist_ok=False)
    _git("init", "-q", cwd=dest)
    _git("remote", "add", "origin", lock["repository"], cwd=dest)
    _git("fetch", "-q", "--depth", "1", "origin", lock["commit"], cwd=dest)
    if _git("rev-parse", "FETCH_HEAD", cwd=dest) != lock["commit"]:
        raise Mismatch("fetched commit is not the pinned commit")
    for rel, tree in lock["git_trees"].items():
        actual = _git("rev-parse", f"FETCH_HEAD:{rel}", cwd=dest)
        if actual != tree:
            raise Mismatch(f"git tree id of {rel} is {actual}, pinned {tree}")
    _git("checkout", "-q", "FETCH_HEAD", "--", *lock["paths"], cwd=dest)
    return verify(dest, lock)


def make_lock(root, paths, repository, commit, git_trees):
    files = manifest(root, paths)
    return {"repository": repository, "commit": commit, "paths": list(paths),
            "git_trees": git_trees, "files": files, "manifest_sha256": digest(files)}


def main(argv):
    if len(argv) != 2 or argv[0] not in {"fetch", "verify", "lock"}:
        print(__doc__)
        return 2
    cmd, target = argv
    try:
        if cmd == "fetch":
            d = fetch(target)
        elif cmd == "verify":
            d = verify(target)
        else:
            lock = load_lock()
            print(json.dumps(make_lock(target, lock["paths"], lock["repository"], lock["commit"],
                                       lock["git_trees"]), indent=2, sort_keys=True))
            return 0
    except Mismatch as exc:
        print(f"FAIL: {exc}", file=sys.stderr)
        return 1
    lock = load_lock()
    print(f"OK: dTax engine at {lock['commit']} unmodified ({len(lock['files'])} files, manifest sha256 {d})")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
