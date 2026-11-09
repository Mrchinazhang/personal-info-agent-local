# 架构盘点 · personal-info-agent-local（阶段 2 起点）

> 本文档是 **阶段 2：项目架构统一与核心功能完善** 的正式起点与决策记录。
> 它先把当前代码“摸清家底”——模块职责、数据接口契约、与五个目标的差距。
> **2-A（数据模型扩展 + 迁移框架）已落地**；2-B / 2-C / 2-D 仍按路线推进。
> 盘点对象：仓库 `E:\Github Desktop\personal-info-agent-local`（即 GitHub 上的 `Mrchinazhang/personal-info-agent-local`）。

---

## 一、架构总览

一句话：**纯本地、零费用的个人知识库**。浏览器原生 JS 前端 + Flask 后端 + SQLite，AI 能力由“本机 Ollama 或纯 Python 规则引擎”兜底。无构建步骤、无框架、无 CDN、无第三方 Key。

最关键的架构决策是 `local-cloud.js`：**它复刻了云端 WorkBuddy Cloud SDK 的调用形状**，把前端的 `cloud.auth.* / cloud.database.from(...).* / cloud.llm.*` 全部转到同源 `/api`。因此前端业务逻辑（`app.js`）对“云端版还是本地版”无感知。

| 层 | 技术 | 职责 |
|---|---|---|
| 前端 | 原生 JS（IIFE）、零依赖 | 六大视图、状态管理、i18n、调用 `local-cloud.js` |
| 兼容层 | `local-cloud.js` | 把云端 SDK 调用翻译为同源 `/api` 请求 |
| 后端 | Python 3.10+ / Flask / 标准库 | 静态页 + `/api/*` + SQLite + 规则引擎 |
| 模型 | Ollama（可选）/ 纯 Python 规则引擎 | 分类、抽取、关联、问答、总结 |
| 存储 | SQLite（`data/pia.db`，四张表） | 个人数据唯一落盘处 |

---

## 二、模块地图

### 后端 `server.py`（约 1142 行，单文件）
| 区块 | 行号 | 职责 |
|---|---|---|
| 配置层 | 25–89 | 常量、`ollama_base()`（强制回环）、`db_path()`（可注入临时库） |
| **数据模型** | 96–262 | `TABLES`（4 表字段类型）、`SCHEMA`、`JSON_ARRAY_COLUMNS`、`encode_value/decode_row`、`has_json1` |
| DB 访问 | 187–211 | `connect()`、`db_conn()`（事务+自动关）、`init_db()` |
| 错误处理/守卫 | 265–317 | `ApiError`、`read_json`、`guard_origin`（Origin 精确匹配） |
| 静态页 | 338–363 | 白名单静态文件、`/api/health` |
| **通用数据路由 `/api/db`** | 366–587 | `build_where/build_order/safe_limit` 白名单 + 参数化 SQL；`select/insert/update/delete` |
| 模型目录 | 590–668 | Ollama 探测缓存（30s TTL + 后台刷新）、`llm_models` |
| **纯 Python 规则引擎** | 671–975 | `classify_block`、`rule_output`（9 个分支）、`chunk_text`、`rules_stream`、`ollama_stream` |
| LLM 端点 | 1042–1083 | `/api/llm/chat`（NDJSON 流式） |
| 入口 | 1088–1141 | `lan_access_enabled()`、CLI 参数、`main()` |

> 注意：后端目前是“API + 规则引擎 + 配置”混在一个文件，没有独立的领域/模型层。

### 前端
| 文件 | 行数 | 职责 |
|---|---|---|
| `index.html` | 110 | 骨架：`auth-view` + `app-view`；侧边栏 6 视图；modal/toast。脚本顺序固定：`i18n-dict → i18n → config → local-cloud → app` |
| `app.js` | 1720 | **单 IIFE、单 state 对象**：6 个视图渲染器 + `bindView` 事件绑定 + 数据加载 + 条目 CRUD + 导入 + 问答 + 总结 + 导出 |
| `local-cloud.js` | 279 | 复刻 `WorkBuddyCloud`：`auth`（7 方法）、`database.Query`（Supabase 链式→`/api/db`）、`llm`（models.list + chat 流式） |
| `i18n.js` | 181 | `t()` 翻译、静态区翻译、`setRefresh` 钩子（语言切换重绘） |
| `i18n-dict.js` | — | 约 319 条英文字典，中文原文作 key |
| `config.js` | 21 | `PUBLIC_CONFIG`（占位、无密钥、`apiBase:/api`） |

### 测试
| 文件 | 项 | 关注点 |
|---|---|---|
| `tests/test_server.py` | 33 | 后端：CRUD / 安全 / 规则引擎（临时库、Ollama 指向 127.0.0.1:1 真实覆盖“未装”路径） |
| `tests/local.test.js` | 22 | 前端：脚本顺序、去 CDN、`app.js` 与云端版字节级一致、`local-cloud.js` 请求形状（vm 沙箱 + 假 fetch） |

---

## 三、前后端数据接口契约（统一情况）

核心契约是 **`POST /api/db` 的 JSON 信封**，前端从不直接写 SQL，只描述意图：

```jsonc
请求体：{ "table", "op":"select|insert|update|delete",
          "columns", "filters":[{kind:"eq|contains|or", ...}],
          "order":{column,ascending}, "limit", "payload", "returning" }
响应体：{ "data", "error":null }   // Supabase 风格，HTTP 200 + error 对象表业务错误
```

**四张表（字段已统一为“JSON 数组 / 布尔 / 文本”三类）：**

| 表 | 关键字段 | 前端读写 |
|---|---|---|
| `items` | title, content, category(idea/material/todo), tags(JSON), summary, key_points(JSON), is_todo, todo_done, due_date, priority, created/updated_at | 全 CRUD |
| `item_links` | source_id, target_id, reason | insert / delete |
| `chats` | question, answer, refs(JSON) | insert / select |
| `reports` | period_label, range_days, summary, highlights(JSON), actions(JSON), item_count | insert / select |

其它端点：`GET /api/health`、`GET /api/llm/models`、`POST /api/llm/chat`（NDJSON 流式，前端转 OpenAI 风格 chunk）。

**已经统一得很好的地方：**
- 单一路由 + 表/列白名单 + 全程参数化 → 前端与数据库解耦，新增表“零后端改动”。
- `encode_value/decode_row` 集中处理 JSON/布尔 ↔ 数据库，前端拿到的永远是干净对象。
- `{data,error}` 信封全栈一致，`unwrap()` 一处处理。
- 导出 `exportAllData` 已存在（四表 → JSON Blob 下载）。

---

## 四、对照阶段 2 五个目标的差距分析

### 目标 1 · 梳理架构与模块职责 —— **基本清晰，但有两处“巨石”**
- ✅ `local-cloud.js` 抽象到位，前后端通过 `/api/db` 契约解耦。
- ⚠️ `app.js` 是 1720 行单 IIFE：所有视图、状态、CRUD、导入、问答、总结、导出挤在一起；`server.py` 是 1142 行单文件：API + 规则引擎 + 配置混写。
- ⚠️ 没有“个人信息条目”的领域层——`items` 的语义（分类/关联/来源）散落在渲染与规则引擎里。

### 目标 2 · 统一前端/后端/数据库接口 —— **主体已统一，少量不一致**
- ✅ 所有持久化都走 `/api/db`。
- ⚠️ **搜索不在接口层**：`visibleItems()`（资料库）与 `pickContext()`（问答召回）是在前端对已加载的 `items`（上限 300 条）做内存过滤，没有走 `/api/db`，数据量大时不成立、也不统一。
- ⚠️ **写操作不对称**：`chats`/`reports` 在 UI 里只能 insert/select，没有 update/delete；`item_links` 只能 insert/delete，没有 update。删除条目时靠 `app.js` 主动调一次 `delete ... or(...)` 级联，没在后端做外键/触发器。

### 目标 3 · 完善新增/修改/删除/搜索/导出 —— **CRUD 有、搜索与导出偏弱**
- ✅ 条目新增、编辑（弹窗 `openDetail`）、删除（含关联级联）、导出 JSON 均已实现。
- ⚠️ **搜索弱**：仅前端子串匹配，无后端全文检索、无分页/游标、无高亮。
- ⚠️ **重复导入无去重**：同一段内容多次“导入选中”会生成重复条目；没有基于内容哈希的 dedup/merge。
- ⚠️ **无单条按 ID 的健壮读取**：依赖前端 `state.items` 内存数组，`itemById()` 找不到即从内存丢弃。
- ⚠️ **无撤销 / 草稿态**：所有保存即落库，改正即覆盖；没有“未确认/已确认”区分。

### 目标 4 · 长期记忆 / 短期记忆 / 信息来源 / 冲突处理 —— **当前完全缺失（阶段 2 重点）**
- ❌ **无长短期记忆区分**：全部是 `items` 一张表，category 只有 idea/material/todo，没有“草稿/已确认/归档”状态，也没有“会话期工作记忆 vs 持久记忆”的概念。
- ❌ **无信息来源追踪**：条目没有“来自粘贴/网页/文件/AI 整理/导入批次”的来源字段；`chats.refs` 只记“引用了哪些条目”，`item_links` 只记“条目间关联”，都没有“这条 item 本身从哪来、哪个导入任务产生的”。
- ❌ **无冲突处理**：AI 重新分类、或两次导入触及同一逻辑条目时，没有任何检测或合并机制；没有去重。
- ❌ **无来源可信度（provenance/confidence）**：规则引擎或模型产出的字段（标题/分类/标签）与用户手动修改的字段无法区分，也没有“用户改过 → 提升置信度”的反馈闭环。

### 目标 5 · 为 ChatGPT / DeepSeek / WorkBuddy / MCP 做准备 —— **已有接缝，未做适配**
- ✅ 已有模型抽象：`callLLM()` + 后端 `ollama_stream`/`rules_stream`，模型 id 是字符串（`ollama:name` / `local-rules`），这是天然接入点。
- ⚠️ 没有 **可插拔 Provider 接口**：加 ChatGPT/DeepSeek/WorkBuddy 需要在 `llm_chat` 里硬分支，不是“实现一个适配器类”。
- ⚠️ 没有 **MCP 暴露**：本地 `/api` 是 HTTP，但不是 MCP server；外部 Agent/工具无法以 MCP 协议调用。
- ⚠️ 没有 **结构化工具调用 / function calling**：规则引擎是 9 个 `if` 分支硬匹配 JSON 形状；真实大模型更适合用 JSON-Schema/工具调度统一。

---

## 五、关键约束与风险（务必先知道）

1. **`app.js` 双版本维护策略（已决策 = B）**
   > **决策 B 已确认（2026-11-09）**：本地版 `app.js` 自阶段 2 起**独立演进**，取消与云端版的字节级一致要求。详见下方「双版本维护策略」专章。
   - 取消：`local.test.js` 不再比对 `app.js` 与云端版字节（原第 81–91 行已删除）。
   - 改为验证：**核心数据接口兼容 / 共同业务行为一致 / 两版本各自测试通过 / 本地独有功能不影响云端运行**（已落地为 `local.test.js` 的接口契约 + 行为测试）。
   - `local-cloud.js` 继续只承担本地部署适配职责，不承担业务功能；共同业务逻辑逐步抽取为可复用模块。

2. **单文件巨石**：`app.js`/`server.py` 都很大，加功能前建议先拆，否则改动相互耦合、难以测试。

3. **搜索/分页缺失**：现架构在“个人数据量小”时成立；阶段 2 一旦强调“记忆系统”，数据量会增长，必须补后端检索。

4. **i18n 以中文为 key**：新增任意界面文案都要在 `i18n-dict.js` 补英文条目，否则英文模式会原样显示中文。

---

## 五-B、双版本维护策略（决策 B 的落地规则）

> 本地版（`personal-info-agent-local`）与云端版（`personal-info-agent`）从此**并行演进**。
> 不再要求 `localApp.js === cloudApp.js`，但必须有边界、有选择性同步。

| 项目 | 维护规则 |
|---|---|
| 云端 `app.js` | 作为**上游参考版本** |
| 本地 `app.js` | **独立演进**，允许为个人信息管理 / 记忆系统 / 企业应用需求重构 |
| `local-cloud.js` | 保留**本地部署适配**职责，不承担所有业务功能（避免兼容层无序堆积） |
| 共同业务逻辑 | 尽可能抽取为**可复用模块**（后端 `/api/db` 已天然解耦，前端逐步抽离） |
| 云端 Bug 修复 | **评估后选择性同步**到本地版 |
| 本地独有功能 | **不反向污染**云端版本 |

**取代字节级比对的四项验证（已写入 `tests/local.test.js`）：**
1. 核心数据接口兼容（`/api/db` 信封形状不变）；
2. 共同业务行为一致（如 sources 表经同一契约读写、items 来源字段经同一接口回传）；
3. 两个版本**各自的功能测试通过**（后端 `test_server.py` + 前端 `local.test.js`）；
4. 本地独有功能**不影响云端运行**（无 CDN / 无外链 / 无密钥契约不变）。

---

## 六、阶段 2 建议实施路线（先夯实数据，再接模型）

> 遵循你的要求：**先不接多个大模型，先把数据管理与记忆做扎实**，后续模型/ MCP 只是“换 Provider 适配器”。

### 2-A · 数据模型扩展（已完成设计，已落地 ✅）

**目标**：引入信息来源（provenance）与可信度/状态字段，为记忆与冲突处理打地基；同时建立**带版本号 + 备份 + 回滚**的迁移框架，旧 `pia.db` 首次启动自动升级且绝不破坏数据。

**数据关系（先定准，避免 2-C 打补丁）：**
```
sources (1) ──< items (N)         # 主来源：每个 item 经 items.source_id 指向一个来源
item_provenance（2-C 预留，多对多）# 同一事实的多个候选值 + 来源 + 是否被采纳，冲突天然共存
```
- `sources` 字段：`id, kind(user_input|ai_extract|file_import|legacy), title, ref, meta(JSON), created_at`。
- `items` 新增列：`source_id`(**INTEGER REFERENCES sources(id) ON DELETE RESTRICT**，可空，兼容旧前端), `state`(TEXT: draft|confirmed|archived, 默认 confirmed), `confidence`(REAL 0–1, 默认 1.0)。
- **`item_provenance` 不在 2-A 建表**，仅在 2-C 实现冲突共存时引入——地基已留好（不覆盖、不丢弃候选值）。

**迁移框架（核心安全机制）：**
- `schema_migrations` 表记录已执行版本；`SCHEMA_VERSION=1`，`MIGRATIONS` 列表驱动演化。
- `SCHEMA` 只保留**基线四表**；所有演化（sources 表、items 新列）只写在迁移里 → **全新库与老库升级后 schema 完全一致**（有测试断言等价）。
- 启动 `ensure_schema()`：迁移前必 `backup_db()`。唯一 `.tmp` + SQLite Online Backup API 写一致快照 → 关闭备份连接 → 临时文件分别跑 `PRAGMA integrity_check` 与 `PRAGMA foreign_key_check`（integrity 通过不代表外键关系正确，两项必须分别执行）→ 全部通过才 `os.replace()` 原子发布为 `data/backups/pia.bak.<时间戳>.db` → 最后才清理旧备份（只保留最近 10 份**成功生成且通过校验**的正式备份）。任一步失败只清理本次临时文件，不触碰已有正式备份、也不触发清理。
- 迁移失败则 `restore_db()`：复制成唯一临时恢复文件 → 双校验 → 原库另存为回滚副本 → `os.replace()` 原子替换 → 重新打开再校验一次。替换前失败绝不动主库；替换后复查失败自动回滚；检测到 `-wal`/`-shm` 残留直接拒绝恢复（说明仍有连接未关，强删会丢未 checkpoint 的数据）。迁移异常与恢复异常均可追踪（恢复失败作为 cause 链的附加信息）。迁移后同样跑完整性校验。
- 手动运维：`python server.py --backup` / `--restore <路径>` / `--migrate-check`。
- 旧数据迁移：种子 `sources(id=1, kind='legacy')`，并把所有旧 `items` 回填 `source_id=1, state=confirmed, confidence=1.0`（旧数据均属用户手动录入，视为已确认、全可信）。

**写时约束**：`/api/db` 对 items 的 `state`/`confidence` 做轻量校验（枚举 + 0–1 区间）；`source_id`/`state`/`confidence` 写缺省为 `NULL`/`confirmed`/`1.0`。**来源在写时的强制选择留到 2-B/2-C**（那时前端才有来源选择 UI），2-A 只建机制与列。

**2-A 已改文件**：`server.py`（数据模型 + 迁移框架 + 校验 + CLI）、`tests/test_server.py`（迁移/来源测试）、`tests/local.test.js`（删字节级比对，改接口契约 + 行为测试）、本文件。**2-A 未修改前端运行时代码**（`app.js` / `index.html` / `styles.css` / `i18n.js` / `i18n-dict.js` / `config.js` / `local-cloud.js` 均未改动），仅修改了前端契约测试 `tests/local.test.js`。

**2-A 数据库安全增强（封版前补充 ✅）**：应终审要求，在推送前补强两点——① `items.source_id` 增加 `REFERENCES sources(id) ON DELETE RESTRICT` 外键（无效来源被 DB 拒绝、NULL 仍允许、删除被引用来源受限）；② 备份由 `shutil.copy2` 文件拼接改为 `sqlite3` Online Backup API（一致快照，不绑定 DELETE 日志模式），恢复新增 `integrity_check` + `foreign_key_check`。新增 `ForeignKeyTest`（5 项）与 `test_restore_db_recovers_database_from_backup`（备份→迁移→人为损坏→恢复→结构与数据核验），并修正 `SourceAndStateTest` 删除后重新种入 legacy 来源 `id=1`。

**2-A 安全修复（第 6 个 commit，代码级复核后补充）**：针对复核发现的 2 个阻断缺陷，补强备份与恢复的原子性——① `backup_db()` 改为「临时文件 → 双校验 → 原子发布」，异常不留残缺正式备份、不占保留名额；② `restore_db()` 改为「先验临时恢复文件 → 回滚副本 → 原子替换 → 替换后复查」，校验失败原库零改动、无半恢复状态；③ `schema_signature()` 覆盖字段属性、索引唯一性/字段顺序/索引 SQL、外键目标与删除行为，并新增「旧结构原有对象逐项保留」断言（不要求 v0 与 v1 整体相等）；④ `ensure_schema()` 恢复失败时保留原始迁移异常。新增 5 项故障安全测试，后端测试全绿。

### 2-A 边界说明
- 不在 2-A 碰 `app.js` / `local-cloud.js` 业务职责，符合「不做无必要大规模重构」。
- `item_links.source_type(auto|manual)` **移至 2-B**（保持 2-A 精简）。
- 来源选择 UX、草稿态确认流、冲突解决 UI 全部属 2-B / 2-C。

### 2-B · CRUD / 搜索 / 导出补全
- 后端检索：`/api/db` 增加 `kind:"search"` 过滤（SQLite `LIKE` 或 FTS5），把 `visibleItems`/`pickContext` 上移到接口层。
- 分页：`limit` 已有，补 `offset`/游标，导出超过 1000 条时改为分批或流式。
- `chats`/`reports`/`item_links` 在 UI 暴露 update/delete。
- 导入去重：对 `content` 取哈希，命中则跳过或合并（冲突进入 2-C）。

### 2-C · 记忆 + 冲突（阶段 2 核心）
- **长短期记忆**：`state=draft` 的条目进入“待确认”视图，用户确认后转 `confirmed`（长期）；会话期未落库草稿算短期。
- **来源可信度**：AI 产出字段标 `confidence<1`，用户编辑后 `confidence=1` 且 `state=confirmed`；记录“用户改过什么”用于未来改进分类。
- **冲突处理**：重复导入检测 → 同一 `source_id` 下保留多版本 → 标记 `conflict` → 提供“合并/保留其一”的解决 UI。

### 2-D · Provider 接缝（最后做，且最轻）
- 定义 `ModelProvider.chat(messages, opts) -> async iterable`，实现 `LocalRulesProvider` / `OllamaProvider`，并为 ChatGPT/DeepSeek/WorkBuddy 留 `HttpProvider` 骨架（不含密钥，配置走本地 `config.js`）。
- 把本地 `/api` 包一层 **MCP server（stdio）**，让外部 Agent 能以 MCP 协议调用记忆系统，而不必重写底层。

---

## 七、阶段 2 决策记录

**决策 1（已确认 = B，2026-11-09）：取消 `app.js` 字节级一致约束，本地版独立演进。**
- 不再要求 `localApp.js === cloudApp.js`；改以「核心数据接口兼容 + 共同业务行为一致 + 两版本各自测试通过 + 本地功能不影响云端运行」四项验证替代字节级比对。
- 云端版作上游参考，选择性同步；本地独有功能不反向污染云端；`local-cloud.js` 只做部署适配。

**决策 2（已确认）：接受在旧 `pia.db` 上加列并引入 `sources` 表。**
- SQLite `ALTER TABLE ADD COLUMN` 安全；且 2-A 已配套**版本化迁移 + 迁移前自动备份 + 失败回滚 + 完整性校验**，旧数据零丢失（旧 items 回填为 `legacy` 来源 / `confirmed` / `confidence=1.0`）。

**实施顺序（不变）**：2-A 数据模型扩展 → 2-B CRUD/搜索/分页/导入去重 → 2-C 记忆/来源/可信度/冲突 → 2-D Provider 与 MCP 接入。

**安全要求（每阶段强制执行）**：迁移支持备份与回滚、不得破坏现有用户数据、AI 自动提取信息未经确认不得覆盖用户手动维护信息、每阶段有迁移测试 + 回归测试 + 安全检查、每阶段独立提交 Git（禁止一次性大规模改写）。
