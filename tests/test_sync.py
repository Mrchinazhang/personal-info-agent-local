"""sync.py 的零依赖单元测试（临时目录，绝不触碰真实运行版或真实仓库）。

运行：python -m unittest discover -s tests -p "test_*.py" -v
"""
import contextlib
import importlib.util
import io
import pathlib
import tempfile
import unittest

ROOT = pathlib.Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("sync_tool", ROOT / "sync.py")
sync = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(sync)


class SyncToolTest(unittest.TestCase):
    def setUp(self):
        self._tmp = tempfile.TemporaryDirectory()
        base = pathlib.Path(self._tmp.name)
        self.src = base / "src"
        self.dst = base / "dst"
        (self.src / "tests").mkdir(parents=True)
        (self.dst / "tests").mkdir(parents=True)
        (self.dst / ".git").mkdir()
        for rel in sync.SYNC_FILES:
            p = self.src / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("v1:" + rel, encoding="utf-8")
        # 仓库专属文件：源目录没有，同步后必须仍然存在
        (self.dst / ".github" / "workflows").mkdir(parents=True)
        for rel in sync.REPO_ONLY:
            p = self.dst / rel
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text("repo-only:" + rel, encoding="utf-8")
        # 个人数据：必须永远不参与同步
        (self.src / "data").mkdir()
        (self.src / "data" / "pia.db").write_bytes(b"private notes")
        (self.src / "__pycache__").mkdir()
        (self.src / "__pycache__" / "server.cpython-313.pyc").write_bytes(b"bytecode")

    def tearDown(self):
        self._tmp.cleanup()

    def run_main(self, *argv):
        buf = io.StringIO()
        with contextlib.redirect_stdout(buf):
            code = sync.main(list(argv))
        return code, buf.getvalue()

    # ---- 白名单边界 ----
    def test_whitelist_never_includes_readme_or_private_data(self):
        for rel in sync.SYNC_FILES:
            self.assertNotEqual(rel, "README.md", "README 由仓库独立维护，绝不能进白名单")
            self.assertNotIn("data/", rel)
            self.assertNotIn("__pycache__", rel)
            self.assertFalse(rel.endswith((".db", ".pyc", ".log")))
        self.assertIn("README.md", sync.REPO_ONLY)
        self.assertIn(".github/workflows/ci.yml", sync.REPO_ONLY)
        self.assertIn("CONTRIBUTING.md", sync.REPO_ONLY)
        self.assertIn("SECURITY.md", sync.REPO_ONLY)

    def test_first_collect_reports_every_whitelisted_file(self):
        changed = sync.collect_changes(self.src, self.dst)
        self.assertEqual(set(changed), set(sync.SYNC_FILES))
        self.assertNotIn("data/pia.db", changed)

    def test_missing_source_file_raises(self):
        (self.src / "server.py").unlink()
        with self.assertRaises(FileNotFoundError):
            sync.collect_changes(self.src, self.dst)

    # ---- 复制行为 ----
    def test_apply_writes_only_changed_files(self):
        changed = sync.collect_changes(self.src, self.dst)
        sync.apply_changes(self.src, self.dst, changed)
        self.assertEqual(sync.collect_changes(self.src, self.dst), [])
        for rel in changed:
            self.assertEqual((self.dst / rel).read_text(encoding="utf-8"), "v1:" + rel)

    def test_repo_only_files_are_never_deleted_or_overwritten(self):
        sync.apply_changes(self.src, self.dst, sync.collect_changes(self.src, self.dst))
        for rel in sync.REPO_ONLY:
            p = self.dst / rel
            self.assertTrue(p.exists(), rel + " 被误删")
            self.assertEqual(p.read_text(encoding="utf-8"), "repo-only:" + rel)

    def test_private_db_and_bytecode_never_reach_destination(self):
        sync.apply_changes(self.src, self.dst, sync.collect_changes(self.src, self.dst))
        self.assertFalse((self.dst / "data" / "pia.db").exists())
        self.assertFalse((self.dst / "__pycache__").exists())

    def test_single_file_change_reports_only_that_file(self):
        sync.apply_changes(self.src, self.dst, sync.collect_changes(self.src, self.dst))
        (self.src / "server.py").write_text("v2:server.py", encoding="utf-8")
        self.assertEqual(sync.collect_changes(self.src, self.dst), ["server.py"])

    # ---- main 流程 ----
    def test_dry_run_writes_nothing_and_never_calls_git(self):
        calls = []
        original = sync.run_git
        sync.run_git = lambda *a, **k: calls.append(a)
        try:
            code, out = self.run_main("--src", str(self.src), "--dst", str(self.dst), "--dry-run")
        finally:
            sync.run_git = original
        self.assertEqual(code, 0)
        self.assertIn("dry-run", out)
        self.assertEqual(calls, [])
        self.assertFalse((self.dst / "server.py").exists(), "dry-run 不应写入任何文件")

    def test_no_changes_never_calls_git(self):
        sync.apply_changes(self.src, self.dst, sync.collect_changes(self.src, self.dst))
        calls = []
        original = sync.run_git
        sync.run_git = lambda *a, **k: calls.append(a)
        try:
            code, out = self.run_main("--src", str(self.src), "--dst", str(self.dst))
        finally:
            sync.run_git = original
        self.assertEqual(code, 0)
        self.assertIn("没有文件变化", out)
        self.assertEqual(calls, [])

    def test_missing_source_directory_returns_error_code(self):
        code, out = self.run_main("--src", str(self.src) + "-gone", "--dst", str(self.dst))
        self.assertEqual(code, 2)
        self.assertIn("源目录不存在", out)

    def test_full_sync_calls_add_commit_push_in_order(self):
        calls = []

        class FakeProc:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_git(dst, *args, **kwargs):
            calls.append(args)
            out = FakeProc()
            if args[0] == "remote":
                out.stdout = "git@github.com:Mrchinazhang/personal-info-agent-local.git\n"
            elif args[0] == "status":
                out.stdout = "M  server.py\n"
            return out

        original = sync.run_git
        sync.run_git = fake_git
        try:
            code, out = self.run_main("--src", str(self.src), "--dst", str(self.dst),
                                      "-m", "sync: test")
        finally:
            sync.run_git = original
        self.assertEqual(code, 0)
        self.assertIn("已推送到 origin/main", out)
        self.assertEqual(calls[0], ("remote", "get-url", "origin"))
        self.assertEqual(calls[1][0], "add")
        self.assertIn("--", calls[1])
        self.assertEqual(calls[2], ("status", "--porcelain"))
        self.assertEqual(calls[3], ("commit", "-m", "sync: test"))
        self.assertEqual(calls[4], ("push", "origin", "main"))

    def test_no_push_skips_push(self):
        calls = []

        class FakeProc:
            returncode = 0
            stdout = ""
            stderr = ""

        def fake_git(dst, *args, **kwargs):
            calls.append(args)
            out = FakeProc()
            if args[0] == "remote":
                out.stdout = "git@github.com:Mrchinazhang/personal-info-agent-local.git\n"
            elif args[0] == "status":
                out.stdout = "M  server.py\n"
            return out

        original = sync.run_git
        sync.run_git = fake_git
        try:
            code, out = self.run_main("--src", str(self.src), "--dst", str(self.dst), "--no-push")
        finally:
            sync.run_git = original
        self.assertEqual(code, 0)
        self.assertIn("已跳过推送", out)
        self.assertNotIn(("push", "origin", "main"), calls)

    def test_wrong_remote_is_refused_before_commit(self):
        calls = []

        class FakeProc:
            returncode = 0
            stdout = "git@github.com:someone-else/other-repo.git\n"
            stderr = ""

        original = sync.run_git
        sync.run_git = lambda *a, **k: (calls.append(a) or FakeProc())
        try:
            code, out = self.run_main("--src", str(self.src), "--dst", str(self.dst))
        finally:
            sync.run_git = original
        self.assertEqual(code, 3)
        self.assertIn("origin 不是预期仓库", out)
        self.assertEqual(len(calls), 1, "校验失败后不应执行 add / commit / push")


if __name__ == "__main__":
    unittest.main(verbosity=2)
