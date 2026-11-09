# -*- coding: utf-8 -*-
"""
本地离线版后端验收测试（零第三方依赖，只依赖 Flask + 标准库 unittest）

运行：
    python -m unittest discover -s tests -v
    python tests/test_server.py

特点：
    * 用临时 SQLite 文件，绝不碰真实 data/pia.db；
    * 把 Ollama 指向 127.0.0.1:1，保证「没装 Ollama」这条路径被真实覆盖；
    * 不发任何外网请求，全程 Flask test_client。
"""
from __future__ import annotations

import json
import os
import shutil
import sqlite3
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

ROOT = Path(__file__).resolve().parents[1]
if str(ROOT) not in sys.path:
    sys.path.insert(0, str(ROOT))

os.environ["PIA_OLLAMA"] = "http://127.0.0.1:1"  # 必然拒绝连接，模拟未安装 Ollama
_TMP = tempfile.TemporaryDirectory(prefix="pia-test-", ignore_cleanup_errors=True)
os.environ["PIA_DB"] = str(Path(_TMP.name) / "test.db")

import server  # noqa: E402  （必须在环境变量设置之后导入）


def db(table, op, **kw):
    body = {"table": table, "op": op}
    body.update(kw)
    return body


def post_db(client, payload, **headers):
    return client.post("/api/db", json=payload, headers=headers)


def chat_json(client, prompt, system="你是整理引擎，只输出 JSON。", lang="zh", **extra):
    sys_text = system + ("\n\nRespond in English. Keep JSON keys unchanged."
                         if lang == "en" else "")
    payload = {
        "model": "local-rules",
        "messages": [{"role": "system", "content": sys_text},
                     {"role": "user", "content": prompt}],
        "json": True,
    }
    payload.update(extra)
    return client.post("/api/llm/chat", json=payload)


def stream_text(resp) -> str:
    out = []
    for line in resp.get_data(as_text=True).splitlines():
        line = line.strip()
        if not line:
            continue
        obj = json.loads(line)          # 每行必须是合法 NDJSON
        assert "error" not in obj, obj
        out.append(obj["content"])
    return "".join(out)


# ---------------------------------------------------------------- 阶段 2-A 迁移夹具
def build_v0_db(path, rows=2):
    """构造一个「阶段 2 之前的旧库」：只有基线四表 + 若干 items，无 schema_migrations。"""
    old = os.environ.get("PIA_DB")
    os.environ["PIA_DB"] = str(path)
    try:
        with server.db_conn() as conn:
            conn.executescript(server.SCHEMA)
            for i in range(rows):
                conn.execute(
                    "INSERT INTO items (title,content,category,created_at,updated_at) "
                    "VALUES (?,?,?,?,?)",
                    ("旧条目%d" % i, "内容", "idea", server.now_iso(), server.now_iso()),
                )
    finally:
        if old is None:
            os.environ.pop("PIA_DB", None)
        else:
            os.environ["PIA_DB"] = old


def schema_signature(conn):
    """完整结构签名：字段属性 / 索引唯一性 / 索引字段顺序 / 索引 SQL / 外键定义。

    table_info 元组含 (cid, name, type, notnull, dflt_value, pk)；
    foreign_key_list 元组含 (..., table, from, to, on_update, on_delete, match)。
    """
    tables = {}
    rows = conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' "
        "AND name NOT LIKE 'sqlite_%' ORDER BY name").fetchall()
    for (name,) in rows:
        columns = tuple(tuple(r) for r in conn.execute(
            "PRAGMA table_info(%s)" % name).fetchall())
        indexes = []
        for row in conn.execute("PRAGMA index_list(%s)" % name).fetchall():
            iname, unique = row[1], row[2]
            index_cols = tuple(tuple(r) for r in conn.execute(
                "PRAGMA index_info(%s)" % iname).fetchall())
            sql_row = conn.execute(
                "SELECT sql FROM sqlite_master WHERE type='index' AND name=?",
                (iname,)).fetchone()
            indexes.append((iname, unique, index_cols, sql_row[0] if sql_row else None))
        fks = tuple(tuple(r) for r in conn.execute(
            "PRAGMA foreign_key_list(%s)" % name).fetchall())
        tables[name] = (columns, tuple(indexes), fks)
    return tables


def patch_backup_failure():
    """让 backup_db() 中源连接的 backup() 抛错，用于故障安全测试。"""
    real_connect = sqlite3.connect

    class ExplodingConnection:
        def __init__(self, inner):
            self._inner = inner

        def backup(self, *a, **k):
            raise OSError("injected backup failure")

        def close(self):
            self._inner.close()

        def __getattr__(self, name):
            return getattr(self._inner, name)

    state = {"n": 0}

    def fake_connect(path, *a, **kw):
        inner = real_connect(path, *a, **kw)
        state["n"] += 1
        return ExplodingConnection(inner) if state["n"] == 1 else inner

    return mock.patch.object(server.sqlite3, "connect", side_effect=fake_connect)


# ---------------------------------------------------------------- 提示词样本
def p_classify(lang):
    if lang == "zh":
        return ("请整理下面这段用户输入，并按要求输出 JSON。\n字段说明：\n"
                "- category: 只能是 idea（灵感）、material（资料）、todo（待办）之一\n"
                "- key_points: 2-4 条重点信息\n- is_todo: 是否包含需要后续执行的动作\n\n"
                "用户输入：\n\"\"\"\n明天下午三点开会讨论博物馆传感器接入方案，记得带实训报告\n\"\"\"")
    return ("Organize the user input below and return JSON as specified.\nFields:\n"
            "- category: exactly one of idea, material, todo\n"
            "- key_points: 2-4 key points\n- is_todo: whether an action is required\n\n"
            "User input:\n\"\"\"\nSubmit the museum sensor report tomorrow, remember to email the tutor\n\"\"\"")


def p_import(lang):
    body = ("把温湿度传感器接到 Flask 后端，采集博物馆展厅数据。\n\n"
            "参考文档 https://example.com/docs 说明了 API 鉴权方式。\n\n"
            "下周三前完成实训报告初稿，交给老师审阅。")
    if lang == "zh":
        return ('请读取下面这段外部内容，输出 JSON：\n'
                '{"analysis":"整体分析","items":[{"title":"标题","content":"内容",'
                '"category":"idea|material|todo","tags":["标签"],"summary":"摘要",'
                '"key_points":["重点"],"is_todo":布尔,"due_date":"YYYY-MM-DD 或 null",'
                '"priority":"high|medium|low|null"}]}\n\n内容如下：\n"""\n' + body + '\n"""')
    return ('Read the external content below, return JSON:\n'
            '{"analysis":"overall analysis","items":[{"title":"title","content":"content",'
            '"category":"idea|material|todo","tags":["tag"],"summary":"summary",'
            '"key_points":["point"],"is_todo":boolean,"due_date":"YYYY-MM-DD or null",'
            '"priority":"high|medium|low|null"}]}\n\nContent:\n"""\n' + body + '\n"""')


def p_related(lang):
    if lang == "zh":
        return ("新记录：\n标题：传感器接入\n摘要：博物馆温湿度采集\n标签：物联网\n\n"
                "已有记录列表：\n"
                "ID 7 | [资料] Flask 接口文档 | 标签: 物联网,Flask | 摘要: 传感器数据入库\n"
                "ID 8 | [想法] 做雷达图 | 标签: 可视化 | 摘要: matplotlib 中文配置\n\n"
                '请从已有记录中挑选与新记录真正相关的 0-3 条，输出 JSON：'
                '{"related":[{"id":数字,"reason":"关联理由"}]}。没有时返回 {"related":[]}。')
    return ("New note:\nTitle: Sensor wiring\nSummary: museum temperature logging\nTags: iot\n\n"
            "Existing notes:\n"
            "ID 7 | [material] Flask API docs | Tags: iot,Flask | Summary: sensor ingest\n"
            "ID 8 | [idea] Radar chart | Tags: charts | Summary: matplotlib fonts\n\n"
            'Return JSON: {"related":[{"id":number,"reason":"why"}]}. Return {"related":[]} if none.')


def p_links(lang):
    if lang == "zh":
        return ("新导入的条目：\nN11 [资料] Flask 接口文档 — 传感器数据入库\n"
                "N12 [想法] 雷达图 — matplotlib 中文字体\n\n"
                "已有条目：\nO7 [资料] 传感器接入 — 物联网温湿度采集\n\n"
                '请找出真正相关的配对，最多 8 对。输出 JSON：'
                '{"links":[{"source":数字,"target":数字,"reason":"理由"}]}\n')
    return ("New notes:\nN11 [material] Flask API docs — sensor ingest\n"
            "N12 [idea] Radar chart — matplotlib fonts\n\n"
            "Existing notes:\nO7 [material] Sensor wiring — iot temperature logging\n\n"
            'Return JSON: {"links":[{"source":number,"target":number,"reason":"why"}]}\n')


def p_points(lang):
    if lang == "zh":
        return ('从下面这条记录中提取 3-5 条重点信息，输出 JSON：{"points":["..."]}\n\n'
                '记录：\n标题：物联网实训\n正文：传感器接入 Flask 之后要配置中文字体。'
                '下周提交实训报告。数据需要按天汇总。')
    return ('Extract 3-5 key points, return JSON: {"points":["..."]}\n\n'
            'Note:\nTitle: IoT practice\nContent: Wire sensors into Flask. '
            'Configure CJK fonts. Submit the report next week.')


def p_report(lang):
    brief = ("[想法] 物联网实训想法 | 传感器接进 Flask | 标签: 物联网 | 2026-11-06\n"
             "[资料] 云平台文档 | API 鉴权说明 | 标签: Flask | 2026-11-05\n"
             "[待办] 完成实训报告 | 写完交上去 | 标签: 报告 | 2026-11-04")
    if lang == "zh":
        return ('以下是用户在最近 7 天记录的 3 条内容：\n\n' + brief +
                '\n\n请生成阶段总结，输出 JSON：\n'
                '{"summary":"阶段总结","highlights":["重点进展"],"actions":["行动建议"]}')
    return ('Here are 3 notes from the last 7 days:\n\n' + brief +
            '\n\nReturn JSON:\n'
            '{"summary":"period summary","highlights":["highlight"],"actions":["action"]}')


def p_ask(lang):
    ctx = ("ID 3 | [资料] Flask 接口文档\n摘要：传感器数据入库\n正文：用 requests 调用新大陆云平台 API，"
           "把温湿度写入数据库。\n要点：配置 AccessKey；按天聚合\n"
           "---\n"
           "ID 4 | [想法] 雷达图\n摘要：matplotlib 中文配置\n正文：指定 SimHei 字体解决乱码。\n要点：无")
    if lang == "zh":
        return ("以下是用户资料库中最相关的内容片段：\n\n" + ctx +
                "\n\n请基于以上内容回答用户的问题。要求：\n1. 只依据资料作答。\n"
                "2. 引用到某条内容时，在其后标注 [ID:数字]。\n\n用户问题：传感器数据怎么入库？")
    return ("Most relevant excerpts from the user's library:\n\n" + ctx +
            "\n\nAnswer the user's question using only the material above. Rules: \n"
            "1. Use only the material.\n2. Append [ID:number].\n\nUser question: how to store sensor data?")


def p_plan(lang):
    todos = ("1. 完成实训报告（截止：2026-11-10）\n2. 配置中文字体\n3. 紧急：修复登录回调")
    if lang == "zh":
        return ("这些是用户当前未完成的待办：\n" + todos +
                "\n\n请把它们整理成一份可执行的推进计划：按紧急与重要程度排序，"
                "指出哪些可以合并或拆解，并给出接下来最值得先做的 3 件事。控制在 350 字以内。")
    return ("These are the user's open to-dos:\n" + todos +
            "\n\nTurn them into an actionable plan: sort by urgency and importance, "
            "say which can be merged or split, and name the 3 most valuable next steps.")


# ---------------------------------------------------------------- 测试用例
class StaticAndHealthTest(unittest.TestCase):
    def setUp(self):
        self.c = server.app.test_client()

    def test_index_serves_local_scripts_without_cdn(self):
        r = self.c.get("/")
        self.assertEqual(r.status_code, 200)
        html = r.get_data(as_text=True)
        self.assertIn("local-cloud.js", html)
        self.assertNotIn("cdn.jsdelivr.net", html)
        self.assertNotIn("sharecode", html)

    def test_whitelisted_static_files(self):
        for name in server.STATIC_FILES:
            self.assertEqual(self.c.get("/" + name).status_code, 200, name)

    def test_private_files_are_not_served(self):
        for path in ("/server.py", "/data/pia.db", "/requirements.txt",
                     "/../server.py", "/%2e%2e/server.py", "/api/nope"):
            self.assertIn(self.c.get(path).status_code, (400, 403, 404), path)

    def test_health_reports_offline_engine(self):
        data = self.c.get("/api/health").get_json()["data"]
        self.assertTrue(data["ok"])
        self.assertFalse(data["ollama"])  # 端口 1 必然拒绝，覆盖「未装 Ollama」


class DatabaseTest(unittest.TestCase):
    def setUp(self):
        server.init_db()
        self.c = server.app.test_client()
        # 每个用例从空库开始
        with server.db_conn() as conn:
            for table in ("item_links", "chats", "reports", "items"):
                conn.execute(f'DELETE FROM "{table}"')
            conn.execute("DELETE FROM sqlite_sequence").fetchall()

    def insert_item(self, **kw):
        row = {"title": "物联网实训想法", "content": "把传感器接进 Flask",
               "category": "idea", "tags": ["物联网", "Flask"],
               "key_points": ["配置中文字体"], "is_todo": False,
               "todo_done": False, "summary": "接入传感器"}
        row.update(kw)
        r = post_db(self.c, db("items", "insert", payload=[row], returning=True))
        self.assertIsNone(r.get_json()["error"], r.get_json())
        return r.get_json()["data"][0]

    def test_insert_returning_decodes_json_and_bool(self):
        row = self.insert_item()
        self.assertIsInstance(row["id"], int)
        self.assertEqual(row["tags"], ["物联网", "Flask"])
        self.assertEqual(row["key_points"], ["配置中文字体"])
        self.assertIs(row["is_todo"], False)
        self.assertIs(row["todo_done"], False)
        self.assertTrue(row["created_at"].endswith("Z"))
        self.assertIn("updated_at", row)

    def test_batch_insert_returns_all_rows(self):
        r = post_db(self.c, db("items", "insert", payload=[
            {"title": "A", "content": "a"}, {"title": "B", "content": "b"}
        ], returning=True))
        self.assertEqual(len(r.get_json()["data"]), 2)

    def test_select_order_limit_and_eq(self):
        self.insert_item(title="甲")
        self.insert_item(title="乙", category="todo")
        r = post_db(self.c, db("items", "select", columns="*", filters=[],
                               order={"column": "created_at", "ascending": False}, limit=10))
        self.assertEqual(len(r.get_json()["data"]), 2)
        r = post_db(self.c, db("items", "select", columns="*",
                               filters=[{"kind": "eq", "column": "category", "value": "todo"}],
                               limit=10))
        self.assertEqual([x["title"] for x in r.get_json()["data"]], ["乙"])

    def test_contains_filter_on_json_array(self):
        self.insert_item(tags=["物联网", "Flask"])
        self.insert_item(title="别的", tags=["字体"])
        r = post_db(self.c, db("items", "select", columns="*",
                               filters=[{"kind": "contains", "column": "tags", "value": ["Flask"]}],
                               limit=10))
        self.assertEqual([x["title"] for x in r.get_json()["data"]], ["物联网实训想法"])

    def test_update_returning_and_updated_at(self):
        row = self.insert_item()
        r = post_db(self.c, db("items", "update", payload={"title": "改过了", "is_todo": True},
                               filters=[{"kind": "eq", "column": "id", "value": row["id"]}],
                               returning=True))
        out = r.get_json()["data"][0]
        self.assertEqual(out["title"], "改过了")
        self.assertIs(out["is_todo"], True)
        self.assertTrue(out["updated_at"])

    def test_delete_returning_and_or_cascade(self):
        row = self.insert_item()
        with server.db_conn() as conn:
            conn.execute("INSERT INTO item_links (source_id, target_id, reason, created_at) "
                         "VALUES (?,?,?,?)", (row["id"], 999, "相关", server.now_iso()))
            conn.execute("INSERT INTO item_links (source_id, target_id, reason, created_at) "
                         "VALUES (?,?,?,?)", (888, row["id"], "相关", server.now_iso()))
        r = post_db(self.c, db("items", "delete",
                               filters=[{"kind": "eq", "column": "id", "value": row["id"]}],
                               returning=True))
        self.assertEqual(len(r.get_json()["data"]), 1)   # 返回被删行，app.js 靠它判断成功
        r2 = post_db(self.c, db("item_links", "delete",
                                filters=[{"kind": "or",
                                          "expr": "source_id.eq.%d,target_id.eq.%d" % (row["id"], row["id"])}]))
        self.assertIsNone(r2.get_json()["error"])
        with server.db_conn() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM item_links").fetchone()[0], 0)

    def test_chats_and_reports_roundtrip(self):
        post_db(self.c, db("chats", "insert", payload={"question": "怎么入库？",
                                                       "answer": "用 requests", "refs": [3, 4]}))
        post_db(self.c, db("reports", "insert", payload={
            "period_label": "最近 7 天", "range_days": 7, "summary": "总结",
            "highlights": ["A"], "actions": ["B"], "item_count": 3}))
        chats = post_db(self.c, db("chats", "select", columns="*", filters=[], limit=5)).get_json()["data"]
        reports = post_db(self.c, db("reports", "select", columns="*", filters=[], limit=5)).get_json()["data"]
        self.assertEqual(chats[0]["refs"], [3, 4])
        self.assertEqual(reports[0]["highlights"], ["A"])
        self.assertEqual(reports[0]["item_count"], 3)


class SecurityTest(unittest.TestCase):
    def setUp(self):
        server.init_db()
        self.c = server.app.test_client()

    def test_unknown_table_or_column_rejected(self):
        r = post_db(self.c, db("sqlite_master", "select", columns="*", filters=[]))
        self.assertEqual(r.status_code, 400)
        self.assertEqual(r.get_json()["error"]["code"], "invalid_table")
        r = post_db(self.c, db("items", "select", columns="*", filters=[
            {"kind": "eq", "column": "id; DROP TABLE items", "value": 1}]))
        self.assertEqual(r.get_json()["error"]["code"], "invalid_column")

    def test_sql_injection_through_order_and_value_is_neutralised(self):
        r = post_db(self.c, db("items", "select", columns="*", filters=[],
                               order={"column": "id; DROP TABLE items", "ascending": True}))
        self.assertEqual(r.get_json()["error"]["code"], "invalid_column")
        # 值走参数化：即使含 SQL 片段也只当普通字符串
        r2 = post_db(self.c, db("items", "select", columns="*", filters=[
            {"kind": "eq", "column": "title", "value": "' OR 1=1 --"}], limit=5))
        self.assertEqual(r2.get_json()["data"], [])

    def test_update_delete_without_filter_rejected(self):
        for op in ("update", "delete"):
            payload = db("items", op, filters=[], returning=True)
            if op == "update":
                payload["payload"] = {"title": "x"}
            r = post_db(self.c, payload)
            self.assertEqual(r.get_json()["error"]["code"], "unsafe_query")

    def test_or_expression_rejects_unknown_columns(self):
        r = post_db(self.c, db("item_links", "select", columns="*", filters=[
            {"kind": "or", "expr": "1=1,source_id.eq.1"}]))
        self.assertEqual(r.get_json()["error"]["code"], "invalid_filter")

    def test_limit_is_clamped(self):
        self.assertLessEqual(server.safe_limit(999999), server.MAX_LIMIT)
        self.assertEqual(server.safe_limit(-5), 1)

    def test_cross_site_origin_rejected(self):
        r = post_db(self.c, db("items", "select", columns="*", filters=[]),
                    Origin="https://evil.example")
        self.assertEqual(r.status_code, 403)
        self.assertEqual(r.get_json()["error"]["code"], "origin_rejected")

    def test_origin_must_match_host_exactly(self):
        # test_client 的 Host 是 localhost，带端口的 127.0.0.1 Origin 应被精确匹配拒掉
        r = post_db(self.c, db("items", "select", columns="*", filters=[]),
                    Origin="http://127.0.0.1:8771")
        self.assertEqual(r.status_code, 403)
        with server.app.test_request_context("/api/db", method="POST",
                                             headers={"Origin": "http://localhost"}):
            self.assertIsNone(server.guard_origin())   # 完全一致 → 放行
        with server.app.test_request_context("/api/db", method="POST",
                                             headers={"Origin": "http://localhost:9999"}):
            self.assertIsNotNone(server.guard_origin())  # 端口不同 → 拒绝

    def test_no_origin_allowed_for_same_origin_forms(self):
        r = post_db(self.c, db("items", "select", columns="*", filters=[]))
        self.assertEqual(r.status_code, 200)

    def test_invalid_json_and_bad_messages(self):
        r = self.c.post("/api/db", data="not-json", content_type="application/json")
        self.assertEqual(r.get_json()["error"]["code"], "invalid_json")
        r = self.c.post("/api/llm/chat", json={"messages": []})
        self.assertEqual(r.get_json()["error"]["code"], "invalid_messages")

    def test_oversized_payload_rejected(self):
        big = "x" * (server.MAX_BODY_BYTES + 100)
        r = self.c.post("/api/llm/chat", json={
            "messages": [{"role": "user", "content": big}]})
        self.assertEqual(r.status_code, 413)

    def test_lan_flag_requires_explicit_truthy_value(self):
        old = os.environ.get("PIA_ALLOW_LAN")
        try:
            for value in ("0", "false", "no", "", "off"):
                os.environ["PIA_ALLOW_LAN"] = value
                self.assertFalse(server.lan_access_enabled(), value)
            for value in ("1", "true", "yes", " TRUE "):
                os.environ["PIA_ALLOW_LAN"] = value
                self.assertTrue(server.lan_access_enabled(), value)
            os.environ.pop("PIA_ALLOW_LAN", None)
            self.assertFalse(server.lan_access_enabled())
        finally:
            if old is None:
                os.environ.pop("PIA_ALLOW_LAN", None)
            else:
                os.environ["PIA_ALLOW_LAN"] = old

    def test_ollama_url_must_be_loopback(self):
        old = os.environ.get("PIA_OLLAMA")
        try:
            os.environ["PIA_OLLAMA"] = "http://169.254.169.254/latest/meta-data"
            with self.assertRaises(RuntimeError):
                server.ollama_base()
        finally:
            os.environ["PIA_OLLAMA"] = old or "http://127.0.0.1:1"


class LlmTest(unittest.TestCase):
    def setUp(self):
        self.c = server.app.test_client()

    def test_models_include_offline_fallback_as_default(self):
        models = self.c.get("/api/llm/models").get_json()["models"]
        self.assertEqual(models[0]["id"], "local-rules")
        self.assertTrue(models[0]["isDefault"])

    def test_ndjson_stream_shape(self):
        r = chat_json(self.c, p_classify("zh"))
        self.assertEqual(r.status_code, 200)
        self.assertIn("ndjson", r.content_type)
        text = stream_text(r)
        obj = json.loads(text)          # 拼接后必须是完整合法 JSON
        self.assertIn("category", obj)

    def test_all_six_json_tasks_return_parseable_json_in_both_languages(self):
        cases = [
            ("classify", p_classify, {"title", "category", "tags", "summary",
                                      "key_points", "is_todo", "due_date", "priority"}),
            ("import", p_import, {"analysis", "items"}),
            ("related", p_related, {"related"}),
            ("links", p_links, {"links"}),
            ("points", p_points, {"points"}),
            ("report", p_report, {"summary", "highlights", "actions"}),
        ]
        for lang in ("zh", "en"):
            for name, builder, keys in cases:
                with self.subTest(lang=lang, task=name):
                    obj = json.loads(stream_text(chat_json(self.c, builder(lang), lang=lang)))
                    self.assertTrue(keys.issubset(obj.keys()), (name, lang, obj.keys()))

    def test_import_produces_multiple_items_with_valid_enums(self):
        obj = json.loads(stream_text(chat_json(self.c, p_import("zh"))))
        self.assertGreater(len(obj["items"]), 1)
        for it in obj["items"]:
            self.assertIn(it["category"], ("idea", "material", "todo"))
            self.assertIsInstance(it["tags"], list)
            self.assertIsInstance(it["key_points"], list)
            self.assertTrue(it["due_date"] is None or
                            __import__("re").fullmatch(r"\d{4}-\d{2}-\d{2}", it["due_date"]))

    def test_classify_detects_todo_and_date(self):
        obj = json.loads(stream_text(chat_json(self.c, p_classify("zh"))))
        self.assertEqual(obj["category"], "todo")
        self.assertTrue(obj["is_todo"])
        self.assertRegex(obj["due_date"] or "", r"^\d{4}-\d{2}-\d{2}$")

    def test_related_references_only_real_ids(self):
        obj = json.loads(stream_text(chat_json(self.c, p_related("zh"))))
        for rel in obj["related"]:
            self.assertIn(rel["id"], (7, 8))

    def test_ask_cites_ids_and_stays_short(self):
        r = self.c.post("/api/llm/chat", json={
            "model": "local-rules", "json": False,
            "messages": [{"role": "system", "content": "基于资料库回答"},
                         {"role": "user", "content": p_ask("zh")}]})
        text = stream_text(r)
        self.assertIn("[ID:", text)
        self.assertLessEqual(len(text), 320)

    def test_plan_is_numbered_text_in_both_languages(self):
        for lang in ("zh", "en"):
            with self.subTest(lang=lang):
                r = self.c.post("/api/llm/chat", json={
                    "model": "local-rules", "json": False,
                    "messages": [{"role": "system", "content": "x" +
                                  ("\n\nRespond in English." if lang == "en" else "")},
                                 {"role": "user", "content": p_plan(lang)}]})
                self.assertRegex(stream_text(r), r"1\.\s")

    def test_unknown_model_falls_back_to_rules_without_error(self):
        r = chat_json(self.c, p_classify("zh"), model="ollama:not-installed")
        self.assertIn("category", json.loads(stream_text(r)))

    def test_ollama_cannot_point_outside_loopback(self):
        self.assertEqual(server.ollama_base(), "http://127.0.0.1:1")


class MigrationTest(unittest.TestCase):
    """阶段 2-A：版本化迁移的备份 / 回滚 / 幂等 / 旧数据 / 双路径等价。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pia-mig-")
        self.orig_db = os.environ.get("PIA_DB")
        os.environ["PIA_DB"] = str(Path(self.tmp) / "pia.db")
        self._orig_fail = os.environ.pop("PIA_MIGRATION_FAIL_AT", None)

    def tearDown(self):
        if self.orig_db is None:
            os.environ.pop("PIA_DB", None)
        else:
            os.environ["PIA_DB"] = self.orig_db
        if self._orig_fail is None:
            os.environ.pop("PIA_MIGRATION_FAIL_AT", None)
        else:
            os.environ["PIA_MIGRATION_FAIL_AT"] = self._orig_fail
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_fresh_db_reaches_latest_version_with_sources(self):
        server.ensure_schema()
        with server.db_conn() as conn:
            ver = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
            self.assertEqual(ver, server.SCHEMA_VERSION)
            self.assertIsNotNone(
                conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='sources'").fetchone())
            cols = [r[1] for r in conn.execute("PRAGMA table_info(items)").fetchall()]
            for col in ("source_id", "state", "confidence"):
                self.assertIn(col, cols)

    def test_legacy_rows_backfilled_as_confirmed_full_confidence(self):
        db_path = Path(self.tmp) / "old.db"
        build_v0_db(str(db_path), rows=3)
        # 用这个旧库作为当前库并升级
        os.environ["PIA_DB"] = str(db_path)
        server.ensure_schema()
        with server.db_conn() as conn:
            rows = conn.execute("SELECT source_id, state, confidence FROM items").fetchall()
            self.assertEqual(len(rows), 3)
            for r in rows:
                self.assertEqual(r[0], 1)          # 指向 legacy 来源
                self.assertEqual(r[1], "confirmed")
                self.assertEqual(r[2], 1.0)
            legacy = conn.execute("SELECT id, kind FROM sources WHERE id=1").fetchone()
            self.assertEqual(legacy[1], "legacy")

    def test_migration_is_idempotent(self):
        db_path = Path(self.tmp) / "old.db"
        build_v0_db(str(db_path), rows=1)
        os.environ["PIA_DB"] = str(db_path)
        server.ensure_schema()
        with server.db_conn() as conn:
            v1 = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
        # 再跑一次不应报错，且版本不变
        server.ensure_schema()
        with server.db_conn() as conn:
            v2 = conn.execute("SELECT MAX(version) FROM schema_migrations").fetchone()[0]
            cols = [r[1] for r in conn.execute("PRAGMA table_info(items)").fetchall()]
        self.assertEqual(v1, v2)
        self.assertIn("source_id", cols)

    def test_failed_migration_rolls_back_and_restores_backup(self):
        db_path = Path(self.tmp) / "old.db"
        build_v0_db(str(db_path), rows=2)
        os.environ["PIA_DB"] = str(db_path)
        os.environ["PIA_MIGRATION_FAIL_AT"] = "1"
        with self.assertRaises(RuntimeError):
            server.ensure_schema()
        # 已回滚：items 无新列、sources 不存在、旧数据行数不变
        with server.db_conn() as conn:
            cols = [r[1] for r in conn.execute("PRAGMA table_info(items)").fetchall()]
            sources = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='sources'").fetchone()
            cnt = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
        self.assertNotIn("source_id", cols)
        self.assertIsNone(sources)
        self.assertEqual(cnt, 2)
        # 备份文件已生成（库名 old.db → 备份为 old.bak.*.db）
        backups_dir = Path(self.tmp) / "backups"
        self.assertTrue(backups_dir.exists() and any(backups_dir.iterdir()),
                        "应当生成迁移前备份")

    def test_migration_and_restore_failure_keeps_original_exception(self):
        """恢复也失败时：原始迁移异常保留为 cause，恢复失败信息不丢失。"""
        db_path = Path(self.tmp) / "old.db"
        build_v0_db(str(db_path), rows=2)
        os.environ["PIA_DB"] = str(db_path)
        os.environ["PIA_MIGRATION_FAIL_AT"] = "1"
        with mock.patch.object(server, "restore_db",
                               side_effect=OSError("injected restore failure")):
            with self.assertRaises(RuntimeError) as ctx:
                server.ensure_schema()
        msg = str(ctx.exception)
        self.assertIn("迁移失败", msg)
        self.assertIn("injected restore failure", msg)
        cause = ctx.exception.__cause__
        self.assertIsNotNone(cause, "原始迁移异常必须保留为 __cause__")
        self.assertIn("injected migration failure", str(cause))
        with server.db_conn() as conn:
            self.assertEqual(conn.execute("SELECT COUNT(*) FROM items").fetchone()[0], 2)

    def test_fresh_and_migrated_schemas_are_identical(self):
        fresh = Path(self.tmp) / "fresh.db"
        old = Path(self.tmp) / "old.db"
        os.environ["PIA_DB"] = str(fresh)
        server.ensure_schema()
        build_v0_db(str(old), rows=2)
        os.environ["PIA_DB"] = str(old)
        server.ensure_schema()
        with server.db_conn() as conn:        # 当前 PIA_DB = old
            migrated_sig = schema_signature(conn)
        os.environ["PIA_DB"] = str(fresh)
        with server.db_conn() as conn:
            fresh_sig = schema_signature(conn)
        self.assertEqual(fresh_sig, migrated_sig,
                         "全新库与升级库的最终 schema（字段/索引/外键）必须完全一致")

    def test_migration_preserves_legacy_objects(self):
        """旧结构原有对象逐项保留 + 新增结构符合预期；不要求 v0 与 v1 整体相等。"""
        db_path = Path(self.tmp) / "old.db"
        build_v0_db(str(db_path), rows=2)
        os.environ["PIA_DB"] = str(db_path)
        with server.db_conn() as conn:
            before = schema_signature(conn)
        server.ensure_schema()
        with server.db_conn() as conn:
            after = schema_signature(conn)
        for table, (cols, indexes, fks) in before.items():
            self.assertIn(table, after, "升级后原有表 %s 丢失" % table)
            a_cols, a_indexes, a_fks = after[table]
            for col in cols:
                self.assertIn(col, a_cols,
                              "原有字段 %s.%s 的定义在升级后被改动" % (table, col[1]))
            for idx in indexes:
                self.assertIn(idx, a_indexes,
                              "原有索引 %s.%s 在升级后丢失或被改动" % (table, idx[0]))
            for fk in fks:
                self.assertIn(fk, a_fks, "原有外键 %s 在升级后丢失" % (table,))
        self.assertIn("sources", after)
        new_cols = {c[1] for c in after["items"][0]}
        self.assertTrue({"source_id", "state", "confidence"}.issubset(new_cols))
        self.assertTrue(
            any(fk[2] == "sources" and fk[6] == "RESTRICT"
                for fk in after["items"][2]),
            "items.source_id 应有指向 sources、ON DELETE RESTRICT 的外键")
        self.assertTrue(any(i[0] == "idx_sources_kind" for i in after["sources"][1]))

    def test_backup_retention_keeps_only_latest_n(self):
        os.environ["PIA_DB"] = str(Path(self.tmp) / "pia.db")
        bdir = Path(self.tmp) / "backups"
        bdir.mkdir()
        # 造 12 个假备份（不同 mtime），模拟历史堆积
        for i in range(12):
            f = bdir / ("pia.bak.20260101-%06d.db" % i)
            f.write_text("x")
            os.utime(f, (i, i))
        server._clean_old_backups(bdir, keep=10)
        remaining = sorted(bdir.glob("pia.bak.*.db"))
        self.assertEqual(len(remaining), 10, "只应保留最近 10 个备份")

    def test_restore_db_recovers_database_from_backup(self):
        # 真正独立的恢复测试：证明 restore_db() 能从「备份文件」恢复已损坏的库，
        # 而不是靠事务回滚（回滚会保留迁移后的 sources 表，这里必须不存在）。
        db_path = Path(self.tmp) / "restore.db"
        build_v0_db(str(db_path), rows=3)          # 1) 旧库（无 sources / 无新列）
        os.environ["PIA_DB"] = str(db_path)
        backup_path = server.backup_db()            # 2) 用 Backup API 备份
        self.assertIsNotNone(backup_path)
        self.assertTrue(backup_path.exists())
        server.ensure_schema()                      # 3) 成功迁移（结构改变）
        with server.db_conn() as conn:
            cols_after = {r[1] for r in conn.execute("PRAGMA table_info(items)").fetchall()}
            has_sources = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='sources'").fetchone()
        self.assertIn("source_id", cols_after)
        self.assertIsNotNone(has_sources)
        with open(db_path, "wb") as f:              # 4) 人为破坏当前数据库
            f.write(b"GARBAGE-NOT-A-VALID-SQLITE-FILE")
        server.restore_db(backup_path)              # 5) 从备份恢复
        with server.db_conn() as conn:              # 6) 验证结构 / 数据 / 完整性 / 外键
            cols = {r[1] for r in conn.execute("PRAGMA table_info(items)").fetchall()}
            sources = conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='sources'").fetchone()
            cnt = conn.execute("SELECT COUNT(*) FROM items").fetchone()[0]
            titles = {r[0] for r in conn.execute("SELECT title FROM items").fetchall()}
            integrity = conn.execute("PRAGMA integrity_check").fetchone()[0]
            fk = conn.execute("PRAGMA foreign_key_check").fetchall()
        self.assertNotIn("source_id", cols)         # 恢复到迁移前结构
        self.assertIsNone(sources)                  # sources 不存在 = 确为备份文件恢复
        self.assertEqual(cnt, 3)                    # 数据未丢失
        self.assertEqual(titles, {"旧条目0", "旧条目1", "旧条目2"})
        self.assertEqual(integrity, "ok")           # restore_db 内部已校验，这里再确认
        self.assertEqual(fk, [])

    def test_restore_failure_leaves_current_db_untouched(self):
        """恢复校验失败：拒绝恢复，原库字节/结构/数据完全不变。"""
        db_path = Path(self.tmp) / "current.db"
        build_v0_db(str(db_path), rows=3)
        os.environ["PIA_DB"] = str(db_path)
        before_bytes = db_path.read_bytes()

        # 构造 integrity_check 正常、但外键关系损坏的备份
        bad = Path(self.tmp) / "bad-backup.db"
        conn = sqlite3.connect(str(bad))
        try:
            conn.executescript(
                "CREATE TABLE sources (id INTEGER PRIMARY KEY);"
                "CREATE TABLE items (id INTEGER PRIMARY KEY, source_id INTEGER "
                "REFERENCES sources(id) ON DELETE RESTRICT);"
                "INSERT INTO items (id, source_id) VALUES (1, 999);")
            conn.commit()
            self.assertEqual(conn.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertTrue(conn.execute("PRAGMA foreign_key_check").fetchall(),
                            "构造的备份必须存在外键冲突")
        finally:
            conn.close()

        with self.assertRaises(RuntimeError):
            server.restore_db(bad)
        self.assertEqual(db_path.read_bytes(), before_bytes,
                         "恢复失败不得改动原库任何字节")
        with server.db_conn() as c:
            self.assertEqual(c.execute("SELECT COUNT(*) FROM items").fetchone()[0], 3)
            self.assertIsNone(c.execute(
                "SELECT name FROM sqlite_master WHERE type='table' "
                "AND name='sources'").fetchone())
        self.assertEqual(list(Path(self.tmp).glob("*.restore-tmp")), [])
        self.assertEqual(list(Path(self.tmp).glob("*.pre-restore")), [])

    def test_backup_failure_leaves_no_partial_file(self):
        """src.backup() 异常：正式备份不出现残缺文件，也不残留 .tmp。"""
        db_path = Path(self.tmp) / "pia.db"
        build_v0_db(str(db_path), rows=1)
        os.environ["PIA_DB"] = str(db_path)
        bdir = Path(self.tmp) / "backups"
        with patch_backup_failure():
            with self.assertRaises(OSError):
                server.backup_db()
        self.assertEqual(list(bdir.glob("*.db")), [], "失败不得产生正式备份文件")
        self.assertEqual(list(bdir.glob("*.tmp")), [], "失败不得残留临时文件")

    def test_failed_backups_do_not_consume_retention_slots(self):
        """连续备份失败不清理、也不挤掉已有的有效正式备份。"""
        db_path = Path(self.tmp) / "pia.db"
        build_v0_db(str(db_path), rows=1)
        os.environ["PIA_DB"] = str(db_path)
        bdir = Path(self.tmp) / "backups"
        for _ in range(10):
            self.assertIsNotNone(server.backup_db())
        valid_names = {f.name for f in bdir.glob("pia.bak.*.db")}
        self.assertEqual(len(valid_names), 10, "应有 10 份有效正式备份")

        for _ in range(12):
            with patch_backup_failure():
                with self.assertRaises(OSError):
                    server.backup_db()
        self.assertEqual({f.name for f in bdir.glob("pia.bak.*.db")}, valid_names,
                         "失败次数增加不得清理或挤掉任何有效备份")
        self.assertEqual(list(bdir.glob("*.tmp")), [], "失败不得残留临时文件")

    def test_rollback_failure_keeps_pre_restore_copy(self):
        """B1：替换后校验失败 + 自动回滚失败 → 保留回滚副本并报告状态与两个异常。"""
        main = Path(self.tmp) / "current.db"
        build_v0_db(str(main), rows=3)
        os.environ["PIA_DB"] = str(main)
        original_bytes = main.read_bytes()
        backup = Path(self.tmp) / "good-backup.db"
        backup.write_bytes(original_bytes)

        real_validate = server._validate_db_file
        real_replace = os.replace
        state = {"n": 0}

        def fail_post_restore(path):
            if Path(path) == main:
                raise RuntimeError("injected post-restore validation failure")
            return real_validate(path)

        def fail_rollback(a, b):
            state["n"] += 1
            if state["n"] == 1:            # tmp -> p，正常原子替换
                return real_replace(a, b)
            raise OSError("injected rollback failure")   # rollback -> p，注入失败

        with mock.patch.object(server, "_validate_db_file", side_effect=fail_post_restore), \
                mock.patch.object(server.os, "replace", side_effect=fail_rollback):
            with self.assertRaises(RuntimeError) as ctx:
                server.restore_db(backup)

        msg = str(ctx.exception)
        copies = list(Path(self.tmp).glob("*.pre-restore"))
        self.assertEqual(len(copies), 1, "回滚失败时必须保留唯一的恢复前副本")
        self.assertEqual(copies[0].read_bytes(), original_bytes,
                         "保留的副本必须是恢复前的原库内容")
        self.assertIn("可能处于不确定状态", msg)
        self.assertIn("请勿启动服务", msg)
        self.assertIn(str(copies[0].resolve()), msg, "异常消息必须给出副本完整路径")
        self.assertIn("injected rollback failure", msg, "回滚异常须以 repr 呈现")
        self.assertIn("injected post-restore validation failure", msg)
        self.assertIsNotNone(ctx.exception.__cause__,
                             "原始恢复异常必须保留为 __cause__")
        self.assertIn("injected post-restore validation failure",
                      str(ctx.exception.__cause__))

    def test_restore_failure_without_original_db_clears_main_path(self):
        """B2：原库不存在 + 替换后校验失败 → 无效库不得留在正式主库路径。"""
        main = Path(self.tmp) / "absent.db"
        self.assertFalse(main.exists())
        os.environ["PIA_DB"] = str(main)
        backup = Path(self.tmp) / "good-backup.db"
        build_v0_db(str(backup), rows=2)

        real_validate = server._validate_db_file

        def fail_post_restore(path):
            if Path(path) == main:
                raise RuntimeError("injected post-restore validation failure")
            return real_validate(path)

        with mock.patch.object(server, "_validate_db_file", side_effect=fail_post_restore):
            with self.assertRaises(RuntimeError) as ctx:
                server.restore_db(backup)

        self.assertFalse(main.exists(), "失败后主库路径不得留下未经验证的库")
        quarantined = list(Path(self.tmp).glob("*.failed-restore"))
        self.assertEqual(len(quarantined), 1, "未经验证的库应被隔离到隔离文件")
        msg = str(ctx.exception)
        self.assertIn("请勿启动服务", msg)
        self.assertIn(str(quarantined[0].resolve()), msg, "异常消息必须给出隔离文件路径")
        self.assertIn("主库路径当前不存在", msg)
        self.assertIn("injected post-restore validation failure", msg)
        self.assertEqual(list(Path(self.tmp).glob("*.pre-restore")), [])
        self.assertEqual(list(Path(self.tmp).glob("*.restore-tmp")), [])
        self.assertIsNotNone(ctx.exception.__cause__)


class ForeignKeyTest(unittest.TestCase):
    """阶段 2-A 安全增强：items.source_id 外键（REFERENCES sources(id) ON DELETE RESTRICT）。"""

    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="pia-fk-")
        self.orig_db = os.environ.get("PIA_DB")
        os.environ["PIA_DB"] = str(Path(self.tmp) / "fk.db")
        server.ensure_schema()  # 建基线 + 迁移（含 source_id 外键）

    def tearDown(self):
        if self.orig_db is None:
            os.environ.pop("PIA_DB", None)
        else:
            os.environ["PIA_DB"] = self.orig_db
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _insert_item(self, source_id, state="confirmed", confidence=1.0, title="t"):
        # server.connect() 已在每个连接开启 foreign_keys=ON
        with server.db_conn() as conn:
            conn.execute(
                "INSERT INTO items (title,content,category,source_id,state,confidence,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                (title, "c", "idea", source_id, state, confidence, server.now_iso(), server.now_iso()))

    def test_valid_source_id_accepted(self):
        # 1) 合法来源 ID 可以写入
        self._insert_item(1)
        with server.db_conn() as conn:
            cnt = conn.execute("SELECT COUNT(*) FROM items WHERE source_id=1").fetchone()[0]
        self.assertGreaterEqual(cnt, 1)

    def test_invalid_source_id_rejected(self):
        # 2) 不存在的来源 ID 被数据库拒绝
        with self.assertRaises(sqlite3.IntegrityError):
            self._insert_item(999)

    def test_null_source_id_allowed(self):
        # 3) NULL 仍然允许（兼容旧前端）
        with server.db_conn() as conn:
            conn.execute(
                "INSERT INTO items (title,content,category,source_id,state,confidence,created_at,updated_at) "
                "VALUES (?,?,?,?,?,?,?,?)",
                ("nullsrc", "c", "idea", None, "confirmed", 1.0, server.now_iso(), server.now_iso()))
            rid = conn.execute("SELECT last_insert_rowid()").fetchone()[0]
            val = conn.execute("SELECT source_id FROM items WHERE id=?", (rid,)).fetchone()[0]
        self.assertIsNone(val)

    def test_delete_referenced_source_restricted(self):
        # 4) 删除仍被 items 引用的来源会失败（ON DELETE RESTRICT）
        self._insert_item(1, title="refed")
        with server.db_conn() as conn:
            with self.assertRaises(sqlite3.IntegrityError):
                conn.execute("DELETE FROM sources WHERE id=1")

    def test_foreign_key_check_clean_after_migration(self):
        # 5) PRAGMA foreign_key_check 无异常
        with server.db_conn() as conn:
            violations = conn.execute("PRAGMA foreign_key_check").fetchall()
        self.assertEqual(violations, [])


class SourceAndStateTest(unittest.TestCase):
    """阶段 2-A：sources 表 + items 的 source_id/state/confidence 业务校验。"""

    def setUp(self):
        server.init_db()
        self.c = server.app.test_client()
        with server.db_conn() as conn:
            for t in ("item_links", "chats", "reports", "items", "sources"):
                conn.execute('DELETE FROM "%s"' % t)
            try:
                conn.execute("DELETE FROM sqlite_sequence")
            except sqlite3.Error:
                pass
            # 重新种入迁移期种子来源（id=1, legacy），保证引用 source_id=1 的测试可写入
            conn.execute(
                "INSERT OR IGNORE INTO sources (id, kind, title, ref, meta, created_at) "
                "VALUES (1, 'legacy', '迁移前手动录入', '', '{}', ?)", (server.now_iso(),))

    def test_items_insert_accepts_source_state_confidence(self):
        r = post_db(self.c, db("items", "insert", payload=[{
            "title": "t", "content": "c", "category": "idea",
            "source_id": 1, "state": "draft", "confidence": 0.5}], returning=True))
        row = r.get_json()["data"][0]
        self.assertEqual(row["state"], "draft")
        self.assertEqual(row["confidence"], 0.5)
        self.assertEqual(row["source_id"], 1)

    def test_items_insert_defaults_state_confirmed_confidence_one(self):
        r = post_db(self.c, db("items", "insert", payload=[{
            "title": "t", "content": "c", "category": "idea"}], returning=True))
        row = r.get_json()["data"][0]
        self.assertEqual(row["state"], "confirmed")
        self.assertEqual(row["confidence"], 1.0)
        self.assertIsNone(row.get("source_id"))

    def test_invalid_state_rejected(self):
        r = post_db(self.c, db("items", "insert", payload=[{
            "title": "t", "state": "bogus"}], returning=True))
        err = r.get_json()["error"]
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], "invalid_state")

    def test_invalid_confidence_rejected(self):
        r = post_db(self.c, db("items", "update", payload={"confidence": 2},
                               filters=[{"kind": "eq", "column": "id", "value": 1}],
                               returning=True))
        err = r.get_json()["error"]
        self.assertIsNotNone(err)
        self.assertEqual(err["code"], "invalid_confidence")

    def test_sources_crud_via_api(self):
        r = post_db(self.c, db("sources", "insert", payload=[{
            "kind": "file_import", "title": "notes.txt", "ref": "/x/notes.txt"}], returning=True))
        row = r.get_json()["data"][0]
        self.assertEqual(row["kind"], "file_import")
        self.assertEqual(row["meta"], {})           # JSON 默认 {}
        r2 = post_db(self.c, db("sources", "select", columns="*", filters=[], limit=10))
        self.assertGreaterEqual(len(r2.get_json()["data"]), 1)


if __name__ == "__main__":
    try:
        unittest.main(verbosity=2)
    finally:
        _TMP.cleanup()
