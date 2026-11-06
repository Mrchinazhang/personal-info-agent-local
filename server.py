#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
个人信息管家 · 本地离线版服务端
==================================================================
零费用、零云资源、零第三方 API Key。前端 app.js 与云端版字节级一致，
靠 local-cloud.js 把 SDK 调用转到这里的同源 /api。

    Flask  ->  静态页面 + /api/*
    SQLite ->  items / item_links / chats / reports
    模型   ->  ① 本机 Ollama（装了就自动用，仍然免费）
              ② 内置纯 Python 规则引擎（没装 Ollama 也能完整跑通所有按钮）

安全边界：
    * 默认只监听 127.0.0.1，不监听 0.0.0.0，不对局域网开放；
    * /api 校验 Origin 与本机 Host 一致，拒绝跨站表单/恶意网页调用；
    * 请求体 4 MiB 上限；表名、列名、排序字段全部白名单，
      SQL 一律参数化，任何用户输入都不会拼进 SQL 文本；
    * 模型地址强制 loopback，避免被当成 SSRF 跳板；
    * 只放行白名单静态文件，杜绝目录穿越读到 server.py / data/*.db。

启动：  python server.py            （默认 http://127.0.0.1:8771）
        python server.py --port 9000
"""
from __future__ import annotations

import argparse
import json
import os
import re
import sqlite3
import sys
import threading
import time
import urllib.error
import urllib.request
import webbrowser
from contextlib import contextmanager
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urlparse

from flask import Flask, Response, jsonify, request, send_from_directory, stream_with_context

BASE_DIR = Path(__file__).resolve().parent
DEFAULT_DB = BASE_DIR / "data" / "pia.db"
MAX_BODY_BYTES = 4 * 1024 * 1024
MAX_ROWS = 200
MAX_LIMIT = 1000
MAX_PROMPT_CHARS = 200_000
DEFAULT_PORT = 8771

# ---------------------------------------------------------------- 配置
def ollama_base() -> str:
    """模型地址只允许本机回环；不允许通过环境变量指向任意外网主机。"""
    raw = os.environ.get("PIA_OLLAMA", "http://127.0.0.1:11434").rstrip("/")
    parsed = urlparse(raw)
    if parsed.scheme not in ("http", "https") or parsed.hostname not in (
        "127.0.0.1", "localhost", "::1"
    ):
        raise RuntimeError("PIA_OLLAMA 只允许指向本机回环地址（127.0.0.1 / localhost）")
    return raw


def ollama_timeout() -> float:
    try:
        return min(max(float(os.environ.get("PIA_OLLAMA_TIMEOUT", "120")), 5.0), 600.0)
    except ValueError:
        return 120.0


def db_path() -> Path:
    """每次调用都读环境变量，方便测试注入临时数据库。"""
    return Path(os.environ.get("PIA_DB") or str(DEFAULT_DB))


# ---------------------------------------------------------------- 数据模型
# 列类型只用于「序列化 / 反序列化」，不是 SQL DDL 的来源。
#   JSON  -> 数据库存 TEXT(json)，返回给前端时还原成 list
#   BOOL  -> 数据库存 0/1，返回时还原成 true/false
TABLES = {
    "items": {
        "id": "INTEGER", "title": "TEXT", "content": "TEXT", "category": "TEXT",
        "tags": "JSON", "summary": "TEXT", "key_points": "JSON",
        "is_todo": "BOOL", "todo_done": "BOOL", "due_date": "TEXT",
        "priority": "TEXT", "created_at": "TEXT", "updated_at": "TEXT",
    },
    "item_links": {
        "id": "INTEGER", "source_id": "INTEGER", "target_id": "INTEGER",
        "reason": "TEXT", "created_at": "TEXT",
    },
    "chats": {
        "id": "INTEGER", "question": "TEXT", "answer": "TEXT",
        "refs": "JSON", "created_at": "TEXT",
    },
    "reports": {
        "id": "INTEGER", "period_label": "TEXT", "range_days": "INTEGER",
        "summary": "TEXT", "highlights": "JSON", "actions": "JSON",
        "item_count": "INTEGER", "created_at": "TEXT",
    },
}

JSON_ARRAY_COLUMNS = {"tags", "key_points", "refs", "highlights", "actions"}

SCHEMA = """
CREATE TABLE IF NOT EXISTS items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  category TEXT NOT NULL DEFAULT 'idea',
  tags TEXT NOT NULL DEFAULT '[]',
  summary TEXT NOT NULL DEFAULT '',
  key_points TEXT NOT NULL DEFAULT '[]',
  is_todo INTEGER NOT NULL DEFAULT 0,
  todo_done INTEGER NOT NULL DEFAULT 0,
  due_date TEXT,
  priority TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_items_created ON items(created_at DESC);
CREATE INDEX IF NOT EXISTS idx_items_category ON items(category);

CREATE TABLE IF NOT EXISTS item_links (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source_id INTEGER NOT NULL,
  target_id INTEGER NOT NULL,
  reason TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_links_source ON item_links(source_id);
CREATE INDEX IF NOT EXISTS idx_links_target ON item_links(target_id);

CREATE TABLE IF NOT EXISTS chats (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  question TEXT NOT NULL DEFAULT '',
  answer TEXT NOT NULL DEFAULT '',
  refs TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_chats_created ON chats(created_at DESC);

CREATE TABLE IF NOT EXISTS reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  period_label TEXT NOT NULL DEFAULT '',
  range_days INTEGER NOT NULL DEFAULT 7,
  summary TEXT NOT NULL DEFAULT '',
  highlights TEXT NOT NULL DEFAULT '[]',
  actions TEXT NOT NULL DEFAULT '[]',
  item_count INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reports_created ON reports(created_at DESC);
"""

STATIC_FILES = {
    "index.html": "text/html; charset=utf-8",
    "app.js": "application/javascript; charset=utf-8",
    "i18n.js": "application/javascript; charset=utf-8",
    "i18n-dict.js": "application/javascript; charset=utf-8",
    "config.js": "application/javascript; charset=utf-8",
    "local-cloud.js": "application/javascript; charset=utf-8",
    "styles.css": "text/css; charset=utf-8",
}


def now_iso() -> str:
    # 带 Z 的 ISO8601，与前端 new Date().toISOString() 同形状
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def connect() -> sqlite3.Connection:
    path = db_path()
    path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(str(path), timeout=15)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")
    conn.execute("PRAGMA busy_timeout = 15000")
    return conn


@contextmanager
def db_conn():
    """with sqlite3.Connection 只负责提交/回滚，并**不会关闭**连接。
    Windows 上未关闭的句柄会让临时数据库删不掉，所以统一走这里。"""
    conn = connect()
    try:
        with conn:
            yield conn
    finally:
        conn.close()


def init_db() -> None:
    with db_conn() as conn:
        conn.executescript(SCHEMA)


_JSON1_CACHE = {}


def has_json1(conn: sqlite3.Connection) -> bool:
    """SQLite >= 3.38 内置 JSON 函数；老版本自动降级为 instr 匹配。"""
    key = str(db_path())
    if key not in _JSON1_CACHE:
        try:
            conn.execute("SELECT value FROM json_each('[1]')").fetchone()
            _JSON1_CACHE[key] = True
        except sqlite3.Error:
            _JSON1_CACHE[key] = False
    return _JSON1_CACHE[key]


def encode_value(table: str, col: str, value):
    kind = TABLES[table][col]
    if kind == "JSON":
        if value is None:
            value = [] if col in JSON_ARRAY_COLUMNS else {}
        return json.dumps(value, ensure_ascii=False)
    if kind == "BOOL":
        return 1 if value else 0
    if kind == "INTEGER":
        if value is None or value == "":
            return None
        try:
            return int(value)
        except (TypeError, ValueError):
            return None
    if value is None:
        return None
    return value if isinstance(value, (int, float)) else str(value)


def decode_row(table: str, row) -> dict:
    out = dict(row)
    for col, kind in TABLES[table].items():
        if col not in out:
            continue
        if kind == "JSON":
            raw = out[col]
            try:
                out[col] = json.loads(raw) if raw else ([] if col in JSON_ARRAY_COLUMNS else {})
            except (TypeError, ValueError):
                out[col] = [] if col in JSON_ARRAY_COLUMNS else {}
        elif kind == "BOOL":
            out[col] = bool(out[col])
    return out


# ---------------------------------------------------------------- 错误
class ApiError(Exception):
    def __init__(self, code: str, message: str, status: int = 400):
        super().__init__(message)
        self.code, self.message, self.status = code, message, status


def api_error(code: str, message: str, status: int = 400):
    return jsonify({"data": None, "error": {"code": code, "message": message}}), status


def db_error(code: str, message: str):
    """数据库业务错误按 Supabase 习惯用 HTTP 200 + error 对象返回，
    这样 app.js 的 res.error / unwrap() 分支完全不用改。"""
    return jsonify({"data": None, "error": {"code": code, "message": message}})


def read_json() -> dict:
    raw = request.get_data(cache=True)
    if len(raw) > MAX_BODY_BYTES:
        raise ApiError("request_too_large", "请求体超过 4 MiB 上限", 413)
    try:
        body = json.loads(raw.decode("utf-8"))
    except (UnicodeDecodeError, ValueError):
        raise ApiError("invalid_json", "请求体不是合法 JSON")
    if not isinstance(body, dict):
        raise ApiError("invalid_json", "请求体必须是 JSON 对象")
    return body


def guard_origin():
    origin = request.headers.get("Origin")
    if not origin:
        # 同源表单 / curl / 测试客户端不带 Origin；服务只绑回环，可以放行
        return None
    parsed = urlparse(origin)
    if parsed.scheme not in ("http", "https"):
        return api_error("origin_rejected", "非法 Origin", 403)
    if parsed.hostname not in ("127.0.0.1", "localhost", "::1"):
        return api_error("origin_rejected", "只允许本机页面调用 /api", 403)
    if parsed.netloc != request.host:
        return api_error("origin_rejected", "Origin 与本机地址不一致", 403)
    return None


app = Flask(__name__, static_folder=None)
app.config["MAX_CONTENT_LENGTH"] = MAX_BODY_BYTES


@app.before_request
def _guard():
    if request.path.startswith("/api/") and request.method in ("POST", "PUT", "PATCH", "DELETE"):
        return guard_origin()
    return None


@app.after_request
def _headers(resp):
    resp.headers["X-Content-Type-Options"] = "nosniff"
    resp.headers["Referrer-Policy"] = "no-referrer"
    return resp


@app.errorhandler(ApiError)
def _on_api_error(e: ApiError):
    return api_error(e.code, e.message, e.status)


@app.errorhandler(413)
def _too_large(_e):
    return api_error("request_too_large", "请求体超过 4 MiB 上限", 413)


# ---------------------------------------------------------------- 静态页面
@app.get("/")
def _root():
    return _static("index.html")


@app.get("/<path:name>")
def _static(name: str):
    if name.startswith("api/") or name not in STATIC_FILES:
        return api_error("not_found", "文件不存在", 404)
    resp = send_from_directory(str(BASE_DIR), name, mimetype=STATIC_FILES[name], max_age=0)
    resp.headers["Cache-Control"] = "no-cache"
    return resp


@app.get("/api/health")
def health():
    return jsonify({
        "data": {
            "ok": True,
            "db": str(db_path()),
            "ollama": bool(probe_ollama()),
            "engine": "ollama + local-rules",
        },
        "error": None,
    })


# ---------------------------------------------------------------- /api/db
def allow_table(name):
    if name not in TABLES:
        raise ApiError("invalid_table", f"不允许访问的表：{name}")
    return name


def allow_col(table, name):
    if name not in TABLES[table]:
        raise ApiError("invalid_column", f"不允许访问的列：{name}")
    return '"' + name + '"'


def build_where(table, filters, conn, require: bool = False):
    if filters is None:
        filters = []
    if not isinstance(filters, list):
        raise ApiError("invalid_filter", "filters 必须是数组")
    clauses, params = [], []
    for f in filters:
        if not isinstance(f, dict):
            raise ApiError("invalid_filter", "过滤条件格式错误")
        kind = f.get("kind")
        if kind == "eq":
            col = f.get("column")
            allow_col(table, col)
            clauses.append(f'"{col}" = ?')
            params.append(encode_value(table, col, f.get("value")))
        elif kind == "contains":
            col = f.get("column")
            allow_col(table, col)
            arr = f.get("value")
            if not isinstance(arr, list):
                raise ApiError("invalid_filter", "contains 需要数组")
            arr = [str(x)[:120] for x in arr[:16]]
            if not arr:
                clauses.append("0 = 1")
            elif has_json1(conn):
                marks = ",".join("?" for _ in arr)
                clauses.append(
                    f'EXISTS (SELECT 1 FROM json_each("{col}") WHERE value IN ({marks}))'
                )
                params.extend(arr)
            else:
                # 老 SQLite 无 JSON1：用字符串子串匹配，宁可略宽也不让功能失效
                tests = [f'instr(COALESCE("{col}", \'\'), ?) > 0' for _ in arr]
                clauses.append("(" + " OR ".join(tests) + ")")
                params.extend(str(x) for x in arr)
        elif kind == "or":
            expr = str(f.get("expr") or "")
            if len(expr) > 2000:
                raise ApiError("invalid_filter", "or 表达式过长")
            sub, sub_params = [], []
            for part in expr.split(","):
                m = re.fullmatch(r"\s*([a-z_][a-z0-9_]*)\.eq\.(.*?)\s*", part)
                if not m:
                    raise ApiError("invalid_filter", "or 只支持 col.eq.value 形式")
                col, val = m.group(1), m.group(2)
                allow_col(table, col)
                sub.append(f'"{col}" = ?')
                sub_params.append(encode_value(table, col, val))
            if not sub:
                raise ApiError("invalid_filter", "or 表达式为空")
            clauses.append("(" + " OR ".join(sub) + ")")
            params.extend(sub_params)
        else:
            raise ApiError("invalid_filter", f"不支持的过滤类型：{kind}")
    if require and not clauses:
        raise ApiError("unsafe_query", "更新 / 删除必须带过滤条件，拒绝全表操作")
    sql = (" WHERE " + " AND ".join(clauses)) if clauses else ""
    return sql, params


def build_order(table, order):
    if not order:
        return ""
    col = order.get("column")
    allow_col(table, col)
    return f' ORDER BY "{col}" ' + ("ASC" if order.get("ascending") is not False else "DESC")


def safe_limit(value):
    if value is None:
        return None
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ApiError("invalid_limit", "limit 必须是整数")
    return min(max(n, 1), MAX_LIMIT)


def fetch_rows(conn, table, where, params, order, limit):
    sql = f'SELECT * FROM "{table}"' + where + order
    if limit is not None:
        sql += " LIMIT ?"
        rows = conn.execute(sql, list(params) + [limit]).fetchall()
    else:
        rows = conn.execute(sql, list(params)).fetchall()
    return [decode_row(table, r) for r in rows]


@app.post("/api/db")
def db_query():
    body = read_json()
    try:
        table = allow_table(body.get("table"))
        op = body.get("op")
        if op not in ("select", "insert", "update", "delete"):
            raise ApiError("invalid_op", f"不支持的操作：{op}")
        order_sql = build_order(table, body.get("order")) if op == "select" else ""
        limit_n = safe_limit(body.get("limit")) if op == "select" else None
    except ApiError:
        raise

    # 单次连接包住整次读写，保证 insert / update / delete 在一个事务里
    with db_conn() as conn:
        try:
            where, params = build_where(
                table, body.get("filters"), conn, require=op in ("update", "delete")
            )
            if op == "select":
                cols = body.get("columns") or "*"
                if cols != "*":
                    if not isinstance(cols, list) or len(cols) > 40:
                        raise ApiError("invalid_column", "columns 格式错误")
                    collist = ", ".join('"' + c + '"' for c in cols if c in TABLES[table])
                    if not collist:
                        raise ApiError("invalid_column", "没有可用列")
                else:
                    collist = "*"
                sql = f'SELECT {collist} FROM "{table}"' + where + order_sql
                args = list(params)
                if limit_n is not None:
                    sql += " LIMIT ?"
                    args.append(limit_n)
                rows = conn.execute(sql, args).fetchall()
                data = [decode_row(table, r) if collist == "*" else dict(r) for r in rows]
                return jsonify({"data": data, "error": None})

            if op == "insert":
                payload = body.get("payload")
                rows = payload if isinstance(payload, list) else [payload]
                if not rows or len(rows) > MAX_ROWS or not all(isinstance(r, dict) for r in rows):
                    raise ApiError("invalid_payload", f"insert 需要 1-{MAX_ROWS} 条对象")
                created = []
                stamp = now_iso()
                for row in rows:
                    cols = {k: v for k, v in row.items() if k in TABLES[table] and k != "id"}
                    if "created_at" in TABLES[table]:
                        cols.setdefault("created_at", stamp)
                    if "updated_at" in TABLES[table]:
                        cols.setdefault("updated_at", stamp)
                    # JSON / 布尔列补默认值，decode_row 才能稳定还原
                    for c, kind in TABLES[table].items():
                        if c in ("id", "created_at", "updated_at"):
                            continue
                        if kind == "JSON":
                            cols.setdefault(c, [] if c in JSON_ARRAY_COLUMNS else {})
                        elif kind == "BOOL":
                            cols.setdefault(c, False)
                        elif kind == "INTEGER":
                            pass
                        elif c in ("title", "content", "category", "summary", "reason",
                                   "question", "answer", "period_label"):
                            cols.setdefault(c, "")
                    names = list(cols)
                    marks = ",".join("?" for _ in names)
                    values = [encode_value(table, c, cols[c]) for c in names]
                    cur = conn.execute(
                        f'INSERT INTO "{table}" (' + ",".join('"' + n + '"' for n in names) +
                        f") VALUES ({marks})", values,
                    )
                    created.append(cur.lastrowid)
                out = []
                if body.get("returning") and created:
                    marks = ",".join("?" for _ in created)
                    out = [decode_row(table, r) for r in conn.execute(
                        f'SELECT * FROM "{table}" WHERE id IN ({marks}) ORDER BY id', created
                    ).fetchall()]
                return jsonify({"data": out, "error": None})

            if op in ("update", "delete"):
                before = []
                if body.get("returning"):
                    before = [dict(r) for r in conn.execute(
                        f'SELECT * FROM "{table}"' + where, params
                    ).fetchall()]

                if op == "update":
                    patch = body.get("payload")
                    if not isinstance(patch, dict) or not patch:
                        raise ApiError("invalid_payload", "update 需要非空对象")
                    cols = {k: v for k, v in patch.items() if k in TABLES[table] and k != "id"}
                    if not cols:
                        raise ApiError("invalid_payload", "没有可更新的列")
                    if "updated_at" in TABLES[table] and "updated_at" not in cols:
                        cols["updated_at"] = now_iso()
                    sets = ",".join('"' + c + '" = ?' for c in cols)
                    values = [encode_value(table, c, cols[c]) for c in cols]
                    cur = conn.execute(
                        f'UPDATE "{table}" SET {sets}' + where, values + list(params)
                    )
                    out = []
                    if body.get("returning"):
                        ids = [r["id"] for r in before]
                        if ids:
                            marks = ",".join("?" for _ in ids)
                            out = [decode_row(table, r) for r in conn.execute(
                                f'SELECT * FROM "{table}" WHERE id IN ({marks}) ORDER BY id', ids
                            ).fetchall()]
                    return jsonify({"data": out, "error": None})

                # delete：返回被删掉的行（与 Supabase .select() 语义一致）
                conn.execute(f'DELETE FROM "{table}"' + where, params)
                return jsonify({
                    "data": [decode_row(table, r) for r in before],
                    "error": None,
                })
        except ApiError:
            raise
        except sqlite3.Error as e:
            return db_error("db_error", f"数据库操作失败：{e}")


# ---------------------------------------------------------------- 模型目录
def probe_ollama(timeout: float = 1.2):
    """返回 Ollama 已安装模型名列表；没装 / 没启动就返回 []（不报错、不阻塞启动）。"""
    try:
        base = ollama_base()
        with urllib.request.urlopen(base + "/api/tags", timeout=timeout) as resp:
            if resp.status != 200:
                return []
            data = json.loads(resp.read(1_000_000).decode("utf-8", "replace"))
        names = []
        for m in data.get("models", []):
            name = m.get("name") or m.get("model")
            if isinstance(name, str) and name.strip() and len(name) < 200:
                names.append(name.strip())
        return names[:50]
    except (OSError, ValueError, KeyError, urllib.error.URLError, RuntimeError):
        return []


@app.get("/api/llm/models")
def llm_models():
    ollama = probe_ollama()
    models = [{
        "id": "local-rules",
        "name": "本地规则引擎 · 离线可用 / Offline rules",
        "isDefault": not ollama,
    }]
    for i, name in enumerate(ollama):
        models.append({
            "id": "ollama:" + name,
            "name": name + " (Ollama)",
            "isDefault": i == 0,
        })
    return jsonify({"models": models, "error": None})


# ------------------------------------------------------- 纯 Python 规则引擎
# 说明：这不是大模型，是确定性的关键词 / 抽取式算法。目标是「没装 Ollama
# 时所有按钮都能用、且永不报错」，而不是假装很聪明。README 里如实说明。
ZH_STOP = set("这个 那个 我们 你们 他们 以及 但是 因为 所以 可以 需要 一个 一些 什么 怎么 如果 已经 这些 那些 自己 现在 时候 内容 用户 输入 记录 资料 输出 请按 要求 字段 说明 摘要 标题 正文 要点 标签 关联 生成 整理 以下 下面 相关 信息 没有 不要 控制 不超过".split())
EN_STOP = set("the and for with that this from have has will your you are not but can should into about content user input output fields title summary tags notes please return json only based below following max chars each under note body related reason source target items analysis every within".split())

TODO_WORDS = ("待办", "任务", "记得", "别忘", "明天", "后天", "下周", "截止", "完成", "提交", "开会", "复习", "交上去", "购买", "联系", "预约", "修复", "deadline", "todo", "task", "remind", "submit", "finish", "meeting", "buy", "call", "email", "fix", "schedule")
MATERIAL_WORDS = ("http://", "https://", "参考", "资料", "文档", "链接", "引用", "摘自", "定义", "教程", "论文", "出处", "source", "reference", "documentation", "tutorial", "definition", "article", "paper", "docs")
URGENT_WORDS = ("紧急", "立刻", "马上", "尽快", "最高优先", "urgent", "asap", "critical", "immediately")


def detect_lang(system_text: str, user_text: str) -> str:
    # i18n 的 sys() 在英文模式会追加这句话，比按汉字比例猜更准
    if "Respond in English" in system_text:
        return "en"
    cjk = len(re.findall(r"[\u4e00-\u9fff]", user_text[:4000]))
    return "zh" if cjk > 20 else "en"


def sentences(text: str):
    parts = re.split(r"(?<=[。！？!?；;\n])\s*|\n+", str(text or ""))
    return [p.strip(" \t\r\n-—·") for p in parts if len(p.strip()) >= 4]


def keywords(text: str, limit: int = 8):
    text = str(text or "").lower()
    counts = {}
    for seg in re.findall(r"[\u4e00-\u9fff]{2,}", text):
        if len(seg) <= 4:
            keys = [seg]
        else:
            keys = [seg[i:i + 2] for i in range(len(seg) - 1)]
        for k in keys:
            if k not in ZH_STOP:
                counts[k] = counts.get(k, 0) + 1
    for w in re.findall(r"[a-z][a-z0-9_-]{2,}", text):
        if w not in EN_STOP and not w.isdigit():
            counts[w] = counts.get(w, 0) + 1
    return [w for w, _ in sorted(counts.items(), key=lambda x: (-x[1], -len(x[0]), x[0]))[:limit]]


def overlap(a: str, b: str) -> int:
    sa = set(keywords(a, 20))
    sb = set(keywords(b, 20))
    return len(sa & sb)


def clip(text: str, n: int) -> str:
    s = re.sub(r"\s+", " ", str(text or "")).strip()
    return s[:n]


def quoted_block(text: str) -> str:
    blocks = re.findall(r'"""\s*\n?(.*?)\n?\s*"""', text, re.S)
    return blocks[-1].strip() if blocks else ""


def after_marker(text: str, patterns) -> str:
    for p in patterns:
        m = re.search(p, text, re.I)
        if m:
            return text[m.end():].strip()
    return ""


def guess_date(text: str, lang: str):
    m = re.search(r"(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})", text)
    if m:
        try:
            return datetime(int(m.group(1)), int(m.group(2)), int(m.group(3))).strftime("%Y-%m-%d")
        except ValueError:
            pass
    today = datetime.now().date()
    if re.search(r"明天|明日|tomorrow", text, re.I):
        return (today + timedelta(days=1)).isoformat()
    if re.search(r"后天|day after tomorrow", text, re.I):
        return (today + timedelta(days=2)).isoformat()
    if re.search(r"下周|next week", text, re.I):
        return (today + timedelta(days=7)).isoformat()
    m = re.search(r"(\d{1,2})\s*月\s*(\d{1,2})\s*[日号]", text)
    if m:
        try:
            return datetime(today.year, int(m.group(1)), int(m.group(2))).strftime("%Y-%m-%d")
        except ValueError:
            pass
    return None


def guess_category(text: str, forced=None) -> str:
    if forced in ("idea", "material", "todo"):
        return forced
    low = text.lower()
    if any(w in low for w in MATERIAL_WORDS):
        return "material"
    if any(w in low for w in TODO_WORDS) or guess_date(text, "zh"):
        return "todo"
    return "idea"


def forced_category(prompt: str):
    m = re.search(r"(?:指定分类为|category\s+(?:as|is|to))\s*(idea|material|todo)", prompt, re.I)
    return m.group(1).lower() if m else None


def classify_block(text: str, lang: str, forced=None) -> dict:
    # 这里保留换行：多段落文本要靠 \n 切句，不能像 clip() 那样压成一行
    text = str(text or "")[:4000]
    sents = sentences(text) or [text]
    cat = guess_category(text, forced)
    is_todo = cat == "todo" or bool(re.search(
        r"待办|记得|别忘|需要(?:去|做)|to-?do|remember to|need to", text, re.I))
    kw = keywords(text, 4)
    tags = (kw or ["记录", "note"])[:4]
    points = [clip(s, 30) for s in sents[:4] if clip(s, 4)]
    if not points:
        points = [clip(text, 30)]
    title = clip(sents[0] or text, 20) or ("新记录" if lang == "zh" else "New note")
    return {
        "title": title,
        "content": text[:1200],
        "category": cat,
        "tags": tags,
        "summary": clip(sents[0], 60) if sents else clip(text, 60),
        "key_points": points[:4],
        "is_todo": bool(is_todo),
        "due_date": guess_date(text, lang),
        "priority": "high" if any(w in text.lower() for w in URGENT_WORDS) else None,
    }


def rule_output(messages, want_json: bool) -> str:
    system_text = "\n".join(
        str(m.get("content") or "") for m in messages if m.get("role") == "system"
    )
    user_text = ""
    for m in reversed(messages):
        if m.get("role") == "user":
            user_text = str(m.get("content") or "")
            break
    if len(user_text) > MAX_PROMPT_CHARS:
        user_text = user_text[:MAX_PROMPT_CHARS]
    lang = detect_lang(system_text, user_text)
    zh = lang == "zh"

    def j(obj):
        return json.dumps(obj, ensure_ascii=False)

    # ---- 1. 长文导入拆解："analysis" + "items"
    if '"items":[' in user_text or '"analysis"' in user_text and '"items"' in user_text:
        raw = quoted_block(user_text) or after_marker(
            user_text, [r"内容如下\s*[:：]", r"Content\s*:", r"Source\s*:"])
        chunks = [c for c in re.split(r"\n\s*\n|[。！？!?]\s*\n", raw) if len(c.strip()) >= 8]
        if len(chunks) == 1 and len(chunks[0]) > 400:
            # 整段没有空行时按句子再切，避免一篇长文只产出 1 条
            chunks = [c for c in sentences(chunks[0]) if len(c) >= 8] or chunks
        if not chunks:
            chunks = [raw[i:i + 300] for i in range(0, len(raw), 300)]
        seen, items = set(), []
        for c in chunks[:24]:
            key = re.sub(r"\s+", "", c)[:60]
            if key in seen:
                continue
            seen.add(key)
            items.append(classify_block(c, lang))
            if len(items) >= 12:
                break
        analysis = clip(
            ("共拆解出 %d 条内容，主要涉及：%s。" % (len(items), "、".join(keywords(raw, 4)) or "以上内容")
             if zh else
             "Split into %d notes. Main topics: %s." % (len(items), ", ".join(keywords(raw, 4)) or "the text above")),
            200)
        result = {"analysis": analysis, "items": items}
        return j(result) if want_json else analysis

    # ---- 2. 批量关联：{"links":[...]}
    if '"links":[' in user_text:
        entries = [(m.group(1), int(m.group(2)), m.group(3))
                   for m in re.finditer(r"\b([NO])(\d+)\s+\[[^\]]*\]\s*([^\n]*)", user_text)]
        news = [e for e in entries if e[0] == "N"]
        links = []
        for a, aid, atxt in news:
            for b in entries:
                if b[1] == aid or (a == "N" and b[0] == "N" and b[1] <= aid):
                    continue
                if overlap(atxt, b[2]) < 1:
                    continue
                links.append({"source": aid, "target": b[1],
                              "reason": clip("关键词相近" if zh else "overlapping keywords", 20)})
                if len(links) >= 8:
                    break
            if len(links) >= 8:
                break
        return j({"links": links})

    # ---- 3. 新条目关联：{"related":[...]}
    if '"related":[' in user_text:
        head = re.split(r"已有记录列表\s*[:：]|Existing notes\s*:", user_text)[0]
        cands = [(int(m.group(1)), m.group(0)) for m in
                 re.finditer(r"\bID\s+(\d+)[^\n]*", user_text)]
        scored = sorted(((overlap(head, t), i, t) for i, t in cands),
                        key=lambda x: -x[0])
        rel = [{"id": i, "reason": clip("主题关键词相近" if zh else "shared keywords", 25)}
               for score, i, _ in scored if score > 0][:3]
        return j({"related": rel})

    # ---- 4. 重点提取：{"points":[...]}
    if '"points":[' in user_text:
        body = after_marker(user_text, [r"正文\s*[:：]", r"Content\s*:", r"Body\s*:",
                                        r"记录\s*[:：]", r"Note\s*:"])
        sents = sentences(body or user_text)
        if not sents:
            sents = [clip(body, 30)]
        pts = [clip(s, 30) for s in sents[:5] if clip(s, 4)]
        return j({"points": pts or [clip(body, 30)]})

    # ---- 5. 阶段总结：{"summary","highlights","actions"}
    if '"highlights"' in user_text and '"actions"' in user_text:
        lines = [l.strip() for l in user_text.splitlines() if l.strip().startswith("[")]
        titles = []
        for l in lines:
            m = re.match(r"\[[^\]]*\]\s*([^|]+)", l)
            if m:
                titles.append(clip(m.group(1), 40))
        titles = titles[:6]
        topics = keywords("\n".join(titles), 5)
        n = len(titles) or 1
        summary = (
            "本阶段共记录 %d 条内容，主要围绕%s展开。%s" % (
                n, "、".join(topics[:3]) or "若干主题",
                "建议继续补齐未完成事项并定期回顾。" if zh else "")
            if zh else
            "This period contains %d notes, mainly about %s. Keep closing open items and review regularly." % (
                n, ", ".join(topics[:3]) or "several topics")
        )
        highlights = titles[:5] or ["暂无可汇总的标题" if zh else "No titles yet"]
        actions = ([("推进「%s」" % t) for t in titles[:3]] if zh else
                   [("Follow up on %s" % t) for t in titles[:3]])
        actions.append("整理并标记已完成的待办" if zh else "Mark finished todos as done")
        return j({"summary": clip(summary, 300), "highlights": highlights,
                  "actions": actions[:5]})

    # ---- 6. 快速记录分类
    if ("- category:" in user_text and "key_points" in user_text) or "字段说明" in user_text or "Fields:" in user_text:
        raw = quoted_block(user_text)
        if not raw:
            raw = after_marker(user_text, [r"用户输入\s*[:：]", r"User input\s*:"])
        return j(classify_block(raw or user_text, lang, forced_category(user_text)))

    # ---- 7. 智能问答（带 [ID:n] 引用）
    if "[ID:" in user_text or "用户问题" in user_text or "User question" in user_text:
        q = after_marker(user_text, [r"用户问题\s*[:：]", r"User question\s*:", r"Question\s*:"])
        q = clip(q.split("\n")[0], 300) or "?"
        ctx_block = re.split(
            r"请基于以上内容回答|Answer the user's question|Answer based on", user_text
        )[0]
        blocks = [b.strip() for b in ctx_block.split("\n---\n") if b.strip()]
        scored = []
        for b in blocks:
            m = re.search(r"\bID\s+(\d+)", b)
            if not m:
                continue
            scored.append((overlap(q, b), int(m.group(1)), b))
        scored.sort(key=lambda x: (-x[0], -x[1]))
        hits = [x for x in scored if x[0] > 0][:3]
        if not hits:
            return ("资料中没有提到与「%s」直接相关的内容，可以换个问法或先记录一些相关资料。" % q
                    if zh else
                    "Your notes do not mention \"%s\" directly. Try a different question or add more notes first." % q)
        parts = []
        for score, i, b in hits:
            body = after_marker(b, [r"正文\s*[:：]", r"Body\s*:", r"摘要\s*[:：]", r"Summary\s*:"])
            txt = clip(body or b, 130)
            parts.append("%s [ID:%d]" % (txt, i))
        head = "根据资料库整理：" if zh else "Based on your notes: "
        sep = "\n" if zh else "\n"
        return clip(head + sep.join(parts), 300)

    # ---- 8. 待办计划（纯文本流式输出）
    if "推进计划" in user_text or "actionable plan" in user_text.lower() or re.search(r"\b1\.\s", user_text):
        lines = [l.strip() for l in user_text.splitlines()
                 if re.match(r"^\s*\d+\.\s", l)]
        todos = [re.sub(r"^\s*\d+\.\s*", "", l) for l in lines][:20]
        if not todos:
            return "资料中没有可整理的待办。" if zh else "No todos to organise."
        urgent = [t for t in todos if any(w in t.lower() for w in URGENT_WORDS) or "截止" in t or "due" in t.lower()]
        ordered = urgent + [t for t in todos if t not in urgent]
        out = []
        if zh:
            out.append("按紧急与重要程度排序后的推进顺序：")
            out += ["%d. %s" % (i + 1, clip(t, 90)) for i, t in enumerate(ordered)]
            out.append("接下来最值得先做的 3 件事：" + "；".join(clip(t, 40) for t in ordered[:3]))
            out.append("可以把同一主题的小任务合并，把跨天的大任务拆成可当天完成的步骤。")
        else:
            out.append("Ordered by urgency and importance:")
            out += ["%d. %s" % (i + 1, clip(t, 90)) for i, t in enumerate(ordered)]
            out.append("Top 3 to start with: " + "; ".join(clip(t, 40) for t in ordered[:3]))
            out.append("Merge small tasks on the same topic; split multi-day tasks into same-day steps.")
        return "\n".join(out)

    # ---- 9. 兜底：抽取式摘要，绝不返回空串导致 parseJSON 崩
    raw = quoted_block(user_text) or user_text
    sents = sentences(raw)[:4]
    fallback = clip("。".join(sents) if zh else ". ".join(sents), 300)
    return j({"summary": fallback, "items": [], "points": [], "related": [], "links": []}) \
        if want_json else (fallback or ("已整理完毕" if zh else "Done"))


def chunk_text(text: str, size: int = 28):
    """把整段答案切成小片段，让前端的流式渲染（onDelta）真的有东西可画。"""
    for i in range(0, len(text), size):
        yield text[i:i + size]
        time.sleep(0.006)


def rules_stream(messages, want_json: bool):
    try:
        text = rule_output(messages, want_json)
    except Exception as e:  # 规则引擎绝不能把页面卡死
        text = json.dumps({"error": "local_rules_failed", "detail": str(e)[:200]},
                          ensure_ascii=False) if want_json else ("本地整理失败：" + str(e)[:120])
    yield from chunk_text(text)


def ollama_stream(model: str, messages, want_json: bool, temperature):
    payload = {
        "model": model,
        "messages": [{"role": m.get("role", "user"), "content": str(m.get("content") or "")}
                     for m in messages],
        "stream": True,
        "options": {"temperature": float(temperature)},
    }
    if want_json:
        payload["format"] = "json"
    req = urllib.request.Request(
        ollama_base() + "/api/chat",
        data=json.dumps(payload, ensure_ascii=False).encode("utf-8"),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        resp = urllib.request.urlopen(req, timeout=ollama_timeout())
    except (OSError, urllib.error.URLError, ValueError, RuntimeError):
        yield from rules_stream(messages, want_json)
        return
    sent = False
    fell_back = False
    try:
        with resp:
            for raw in resp:
                line = raw.decode("utf-8", "replace").strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except ValueError:
                    continue
                if obj.get("error"):
                    raise RuntimeError(str(obj["error"])[:200])
                content = (obj.get("message") or {}).get("content")
                if content:
                    sent = True
                    yield content
    except (OSError, ValueError, RuntimeError):
        if not sent:
            fell_back = True
            yield from rules_stream(messages, want_json)
    # 模型连上了却一个字都没吐（模型名不存在 / 空响应）→ 降级，且只降级一次
    if not sent and not fell_back:
        yield from rules_stream(messages, want_json)


@app.post("/api/llm/chat")
def llm_chat():
    body = read_json()
    messages = body.get("messages")
    if not isinstance(messages, list) or not messages:
        raise ApiError("invalid_messages", "messages 必须是非空数组")
    clean = []
    total = 0
    for m in messages[:20]:
        if not isinstance(m, dict):
            raise ApiError("invalid_messages", "消息格式错误")
        content = str(m.get("content") or "")
        total += len(content)
        if total > MAX_PROMPT_CHARS:
            raise ApiError("prompt_too_large", "提示词超过 20 万字符上限")
        clean.append({"role": str(m.get("role") or "user"), "content": content})
    want_json = bool(body.get("json"))
    try:
        temperature = min(max(float(body.get("temperature") or 0.7), 0.0), 2.0)
    except (TypeError, ValueError):
        temperature = 0.7

    model = str(body.get("model") or "")
    if model.startswith("ollama:") and probe_ollama(timeout=0.8):
        gen = ollama_stream(model[len("ollama:"):], clean, want_json, temperature)
    else:
        gen = rules_stream(clean, want_json)

    def ndjson():
        try:
            for piece in gen:
                if piece:
                    yield json.dumps({"content": piece}, ensure_ascii=False) + "\n"
        except Exception as e:
            yield json.dumps({"error": "stream_failed: " + str(e)[:200]},
                             ensure_ascii=False) + "\n"

    return Response(
        stream_with_context(ndjson()),
        mimetype="application/x-ndjson; charset=utf-8",
        headers={"Cache-Control": "no-store", "X-Accel-Buffering": "no"},
    )


# ---------------------------------------------------------------- 入口
def main(argv=None):
    parser = argparse.ArgumentParser(description="个人信息管家 · 本地离线版")
    parser.add_argument("--host", default=os.environ.get("PIA_HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PIA_PORT", DEFAULT_PORT)))
    parser.add_argument("--debug", action="store_true")
    parser.add_argument("--open-browser", action="store_true",
                        help="服务起来后自动打开浏览器（启动脚本用）")
    args = parser.parse_args(argv)

    if args.host not in ("127.0.0.1", "localhost", "::1") and not os.environ.get("PIA_ALLOW_LAN"):
        print("[拒绝] 默认只监听本机回环；确需局域网访问请显式设置 PIA_ALLOW_LAN=1", file=sys.stderr)
        return 2
    try:
        ollama_base()
    except RuntimeError as e:
        print("[拒绝] " + str(e), file=sys.stderr)
        return 2

    init_db()
    models = probe_ollama()
    print("=" * 62)
    print("  个人信息管家 · 本地离线版")
    print("  打开： http://%s:%d" % ("127.0.0.1" if args.host == "::1" else args.host, args.port))
    print("  数据： %s" % db_path())
    print("  模型： %s" % (", ".join(models) if models else "本地规则引擎（未检测到 Ollama）"))
    print("  费用： ¥0 / 0 token / 无任何云端调用")
    print("=" * 62)
    if args.open_browser:
        def _open():
            time.sleep(1.0)
            try:
                webbrowser.open("http://127.0.0.1:%d/" % args.port)
            except Exception:
                pass
        threading.Thread(target=_open, daemon=True).start()
    app.run(host=args.host, port=args.port, debug=args.debug, threaded=True,
            use_reloader=False)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
