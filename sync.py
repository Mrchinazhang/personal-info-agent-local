#!/usr/bin/env python3
"""一键同步：把「本地运行版」的代码变更同步到这个 GitHub 仓库，并提交推送。

背景
----
本机有两个独立目录：
  * 运行版（源）：E:\\WorkBuddy缓存文件\\Agent\\personal-info-agent-local
      日常真正跑 Flask 服务、存放 data/pia.db 的地方。
  * 开源仓库（目标）：E:\\Github Desktop\\personal-info-agent-local
      只放代码，不放任何笔记数据。

安全约定
--------
1. 只按 SYNC_FILES 白名单复制，**绝不删除**目标目录里的任何文件。
2. README.md 由仓库独立维护（含仓库地址、CI 徽章、clone 步骤），**永不覆盖**。
3. .github/、CONTRIBUTING.md、SECURITY.md 是仓库专属文件，源目录没有，永不触碰。
4. data/、*.db、__pycache__、*.pyc 不在白名单里，永远不会被同步或提交。
5. 只 git add 本次变化的文件，不 force push，推送前校验 origin 是预期仓库。

用法
----
    python sync.py                 # 同步 + 提交 + 推送
    python sync.py --dry-run       # 只预览会同步哪些文件，不写入、不提交
    python sync.py --no-push       # 只提交，不推送
    python sync.py -m "fix: ..."   # 自定义提交信息
    python sync.py --src D:\\xxx   # 源目录换了位置时手动指定

Windows 用户直接双击 sync.bat 即可（等价于不带参数运行）。
"""
from __future__ import annotations

import argparse
import hashlib
import subprocess
import sys
from datetime import datetime
from pathlib import Path

DEFAULT_SRC = Path(r"E:\WorkBuddy缓存文件\Agent\personal-info-agent-local")
EXPECTED_REMOTE = "Mrchinazhang/personal-info-agent-local"

# 只同步这些「运行版与仓库版共用」的代码文件。顺序稳定，便于阅读输出。
SYNC_FILES = (
    ".gitignore",
    "LICENSE",
    "app.js",
    "config.js",
    "i18n-dict.js",
    "i18n.js",
    "index.html",
    "local-cloud.js",
    "requirements.txt",
    "server.py",
    "start.bat",
    "start.sh",
    "styles.css",
    "tests/local.test.js",
    "tests/test_server.py",
)

# 仓库专属：源目录没有，同步时一律不动。README.md 单独在下面说明。
REPO_ONLY = (
    "README.md",
    ".github/FUNDING.yml",
    ".github/workflows/ci.yml",
    "CONTRIBUTING.md",
    "SECURITY.md",
)


def md5(path: Path) -> str | None:
    """文件不存在返回 None；数据库等大文件也用同一口径，避免误判。"""
    if not path.is_file():
        return None
    return hashlib.md5(path.read_bytes()).hexdigest()


def collect_changes(src: Path, dst: Path) -> list[str]:
    """返回白名单里内容不一致的相对路径；源目录缺文件属于异常，直接报错。"""
    changed = []
    for rel in SYNC_FILES:
        s = src / rel
        d = dst / rel
        if not s.is_file():
            raise FileNotFoundError("源目录缺少文件：" + str(s))
        if md5(s) != md5(d):
            changed.append(rel)
    return changed


def apply_changes(src: Path, dst: Path, changed: list[str]) -> None:
    """只覆盖白名单中变化的文件，从不删除、从不递归清空目录。"""
    for rel in changed:
        target = dst / rel
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes((src / rel).read_bytes())


def run_git(dst: Path, *args: str, check: bool = True) -> subprocess.CompletedProcess:
    proc = subprocess.run(
        ["git", *args],
        cwd=str(dst),
        capture_output=True,
        encoding="utf-8",
        errors="replace",
    )
    if check and proc.returncode != 0:
        raise RuntimeError(
            "git " + " ".join(args) + " 失败：\n" + (proc.stdout or "") + (proc.stderr or "")
        )
    return proc


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="把本地运行版的代码同步到 GitHub 仓库")
    ap.add_argument("--src", type=Path, default=DEFAULT_SRC, help="运行版目录")
    ap.add_argument("--dst", type=Path, default=Path(__file__).resolve().parent, help="仓库目录")
    ap.add_argument("--dry-run", action="store_true", help="只预览，不写入、不提交")
    ap.add_argument("--no-push", action="store_true", help="只提交，不推送")
    ap.add_argument("-m", "--message", default=None, help="自定义提交信息")
    args = ap.parse_args(argv)

    src: Path = args.src.resolve()
    dst: Path = args.dst.resolve()

    print("源目录（运行版）：" + str(src))
    print("目标目录（仓库）：" + str(dst))
    print("同步白名单：%d 个代码文件" % len(SYNC_FILES))
    print("独立维护、跳过：README.md + %d 个仓库专属文件" % (len(REPO_ONLY) - 1))
    print()

    if not src.is_dir():
        print("[错误] 源目录不存在，运行版可能已被清理或移动。")
        print("       用 --src 指定正确路径，例如：python sync.py --src D:\\my\\local")
        return 2

    try:
        changed = collect_changes(src, dst)
    except FileNotFoundError as e:
        print("[错误] " + str(e))
        print("       白名单要求源文件齐全；若文件确实删掉了，请同步修改 sync.py 的 SYNC_FILES。")
        return 2

    if not changed:
        print("没有文件变化，无需同步、无需提交。")
        return 0

    print("检测到 %d 个文件有变化：" % len(changed))
    for rel in changed:
        print("   " + rel)
    print()

    if args.dry_run:
        print("[dry-run] 仅预览：未写入文件、未 git add / commit / push。")
        return 0

    apply_changes(src, dst, changed)
    print("已复制 %d 个文件；仓库专属文件一个都没动。" % len(changed))

    if not (dst / ".git").exists():
        print("[错误] 目标目录不是 git 仓库：" + str(dst))
        return 3

    remote = run_git(dst, "remote", "get-url", "origin", check=False)
    if remote.returncode != 0 or EXPECTED_REMOTE not in (remote.stdout or ""):
        print("[错误] origin 不是预期仓库 " + EXPECTED_REMOTE + "，已停止，避免推错地方。")
        print("       当前 origin: " + (remote.stdout or "(未配置)").strip())
        return 3

    run_git(dst, "add", "--", *changed)
    status = run_git(dst, "status", "--porcelain").stdout.strip()
    if not status:
        print("文件已恢复为与仓库一致，无需提交。")
        return 0

    message = args.message or (
        "sync: 从本地运行版同步 %d 个文件（%s）" % (len(changed), datetime.now().strftime("%Y-%m-%d %H:%M"))
    )
    run_git(dst, "commit", "-m", message)
    print("已提交：" + message)

    if args.no_push:
        print("[--no-push] 已跳过推送，需要时手动 git push origin main")
    else:
        pushed = run_git(dst, "push", "origin", "main", check=False)
        if pushed.returncode != 0:
            print("[错误] 推送失败，提交仍留在本地：")
            print((pushed.stdout or "") + (pushed.stderr or ""))
            return 4
        print("已推送到 origin/main")

    print()
    print("提醒：README.md 由仓库独立维护。若运行版的说明有更新，请手动合并过来。")
    return 0


if __name__ == "__main__":
    sys.exit(main())
