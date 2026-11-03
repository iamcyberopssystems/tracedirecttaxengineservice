"""Tests for the dTax engine integrity check (CLAUDE.md rule 5).

Offline: they build a fake engine tree, lock it, then show that any changed,
added or removed file, or a symlink, is refused. A separate check verifies the
committed lock is self-consistent. The real upstream fetch runs in CI
(job engine-integrity).
"""
import json
import tempfile
import unittest
from pathlib import Path

import verify_engine as v

PATHS = ["packages/tax-engine", "LICENSE"]


def tree(root):
    root = Path(root)
    (root / "packages/tax-engine/src/methods").mkdir(parents=True)
    (root / "packages/tax-engine/src/methods/fifo.ts").write_text("export const fifo = 1;\n")
    (root / "packages/tax-engine/package.json").write_text('{"name": "@dtax/tax-engine"}\n')
    (root / "LICENSE").write_text("GNU AFFERO GENERAL PUBLIC LICENSE\n")
    return v.make_lock(root, PATHS, "https://example.invalid/dtax.git", "0" * 40, {})


class VerifyTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.root = Path(self.tmp.name)
        self.lock = tree(self.root)

    def tearDown(self):
        self.tmp.cleanup()

    def test_unchanged_copy_passes(self):
        self.assertEqual(v.verify(self.root, self.lock), self.lock["manifest_sha256"])

    def test_one_byte_change_is_named(self):
        f = self.root / "packages/tax-engine/src/methods/fifo.ts"
        f.write_text(f.read_text().replace("1", "2"))
        with self.assertRaisesRegex(v.Mismatch, "changed: packages/tax-engine/src/methods/fifo.ts"):
            v.verify(self.root, self.lock)

    def test_added_file_is_refused(self):
        (self.root / "packages/tax-engine/src/patch.ts").write_text("// vendored patch\n")
        with self.assertRaisesRegex(v.Mismatch, "added: packages/tax-engine/src/patch.ts"):
            v.verify(self.root, self.lock)

    def test_removed_file_is_refused(self):
        (self.root / "LICENSE").unlink()
        with self.assertRaisesRegex(v.Mismatch, "missing: LICENSE"):
            v.verify(self.root, self.lock)
        (self.root / "LICENSE").write_text("GNU AFFERO GENERAL PUBLIC LICENSE\n")
        (self.root / "packages/tax-engine/package.json").unlink()
        with self.assertRaisesRegex(v.Mismatch, "removed: packages/tax-engine/package.json"):
            v.verify(self.root, self.lock)

    def test_symlink_is_refused(self):
        (self.root / "packages/tax-engine/link.ts").symlink_to(self.root / "LICENSE")
        with self.assertRaisesRegex(v.Mismatch, "symlink"):
            v.verify(self.root, self.lock)

    def test_cli_exit_codes(self):
        lock_path = self.root / "lock.json"
        lock_path.write_text(json.dumps(self.lock))
        original = v.LOCK
        v.LOCK = lock_path
        try:
            self.assertEqual(v.main(["verify", str(self.root)]), 0)
            (self.root / "LICENSE").write_text("changed\n")
            self.assertEqual(v.main(["verify", str(self.root)]), 1)
            self.assertEqual(v.main(["bogus"]), 2)
        finally:
            v.LOCK = original


class CommittedLockTests(unittest.TestCase):
    def test_lock_is_consistent_and_pins_a_full_commit(self):
        lock = v.load_lock()
        self.assertRegex(lock["commit"], r"^[0-9a-f]{40}$")
        self.assertEqual(lock["repository"], "https://github.com/dTaxLab/dtax.git")
        self.assertEqual(v.digest(lock["files"]), lock["manifest_sha256"])
        self.assertEqual(set(lock["git_trees"]), set(lock["paths"]))
        self.assertIn("packages/tax-engine/LICENSE", lock["files"])
        self.assertIn("packages/tax-engine/src/methods/india-vda.ts", lock["files"])


if __name__ == "__main__":
    unittest.main()
