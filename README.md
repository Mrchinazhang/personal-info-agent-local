# 个人信息管家 · 本地离线版

**仓库**：https://github.com/Mrchinazhang/personal-info-agent-local
[![CI](https://github.com/Mrchinazhang/personal-info-agent-local/actions/workflows/ci.yml/badge.svg)](https://github.com/Mrchinazhang/personal-info-agent-local/actions/workflows/ci.yml)

> **¥0 / 0 token / 0 云端调用。** 界面、业务逻辑、中英双语全部保留，
> 但数据只存在你这台电脑，AI 只用本机算力，永远不会消耗 WorkBuddy 额度或产生账单。

> ### 当前使用建议（2026-11-06 起）
> **日常记录、整理、问答一律用这一版**，双击 `start.bat` → <http://127.0.0.1:8771/>。
> 线上双语版保留给国际友人试用：目前 AI 已恢复为「限额模式」，每浏览器 10 次/天、
> 累计 100 次，平台回 `quota_` 自动熔断，但**每次 AI 调用仍扣创建者积分**。
> 平台 SDK 不暴露余额 / 总额度 / 账期，具体数字只能到 WorkBuddy 控制台查；
> 那道护栏是**按浏览器的客户端软闸**，挡不住有人直接写脚本调接口，也不是平台级硬限。
> 想让线上全局零消耗：把线上 `config.js` 的 `aiEnabled` 改成 `false` 后重新发布。
> 两个版本互不冲突，也不会互相覆盖数据。

本仓库是 [`personal-info-agent`](https://github.com/Mrchinazhang/personal-info-agent) 云端开源版的**独立开源仓库**，
不是云端版的 git 分支，也不是对它的修改。两者可以同时存在、互不干扰，数据也互不迁移。

---

## 一、为什么会有这一版

云端版跑在 WorkBuddy Cloud 上，认证、数据库行级权限、大模型流式调用都绑定平台：
访客每点一次「智能整理」，消耗的是**创建者的额度**；而 `publishableKey` 在服务端做
exact Origin 匹配，所以「只把静态文件搬到 GitHub Pages / Cloudflare Pages」是行不通的——
登录会直接失败。SDK 也不暴露 usage / quota / billing，具体用量只能去控制台看。

想彻底不花 token 和钱，就必须**连后端一起换掉**。这一版就是这么做的：

| | 云端开源版 | 本地离线版（本项目） |
|---|---|---|
| 部署 | WorkBuddy Sites（需 `?sharecode=`） | 本机 `127.0.0.1:8771`，双击即用 |
| 账号 | 手机号 / 邮箱验证码 / 微信 / WorkBuddy | **无账号**，打开即进入 |
| 数据库 | 云端 PostgreSQL + RLS | 本机 SQLite（`data/pia.db`） |
| 模型 | 平台中转的云端大模型 | 本机 Ollama，或内置本地规则引擎 |
| 网络 | 必须联网 | **完全离线可用**（除了你自己访问 localhost） |
| 费用 | 访客调用消耗创建者额度 | **永久 ¥0** |
| 第三方 Key | 不需要 | **不需要，也不要放** |
| 中英双语 | ✅ | ✅（同一套 `i18n.js` / `i18n-dict.js`） |
| 业务逻辑 | `app.js` | **字节级相同的同一份 `app.js`** |

关键做法：新增 `local-cloud.js`，原样复刻云端 SDK 的调用形状
（`cloud.auth.*` / `cloud.database.from(...).*` / `cloud.llm.*`），
把请求全部转到同源 `/api`。因此 **`app.js` 一行都没改**，
以后云端版修了 bug，直接把 `app.js` 复制过来即可。

---

## 二、启动

### 0. 先拿代码
```bash
git clone https://github.com/Mrchinazhang/personal-info-agent-local.git
cd personal-info-agent-local
```
（已经在本机跑起来的可以跳过这步。）

### Windows（最省事）
双击 **`start.bat`**。它会自动检查 Python、按需安装唯一依赖 Flask，然后打开浏览器。

### macOS / Linux
```bash
sh start.sh
```

### 手动（任何平台）
```bash
python -m pip install -r requirements.txt
python server.py
```
然后打开 **http://127.0.0.1:8771/**

要求：**Python 3.10+**。除 Flask 外全部是标准库，没有 `package.json`、没有构建步骤、
没有 Node 依赖（Node 只在跑前端契约测试时才需要）。

启动后终端会显示实际状态：

```
  模型： 本地规则引擎（未检测到 Ollama）
  费用： ¥0 / 0 token / 无任何云端调用
```

> 端口被占用？`python server.py --port 9000`。
> 想换数据库位置？设环境变量 `PIA_DB=D:\xxx\my.db`。

---

## 三、关于「AI」：请务必看这一段

**这一版不会假装有一个大模型。**

| 模式 | 条件 | 效果 |
|---|---|---|
| 本地规则引擎 | 默认，零依赖 | 确定性的关键词 / 抽取式算法：自动分类、抽标题、切要点、猜日期和优先级、拆解长文、按关键词关联、基于资料库做带引用的问答、生成待办推进计划和阶段总结。**所有按钮都能点、都返回合法结果、绝不报错。** |
| Ollama 真模型 | 自己装了 [Ollama](https://ollama.com) 并拉了模型 | 模型下拉框自动多出本地模型，选它即为真·大模型输出，依然全免费、全离线 |

规则引擎是**保底**，不是伪装成 GPT。它的分类靠关键词、关联靠中文字二元组重叠、
摘要靠抽取原句，语义理解能力有限。想要真正的智能，装 Ollama：

```bash
ollama pull qwen2.5:3b     # 或 llama3.2 / gemma3 / deepseek-r1 等任意本机模型
```

刷新页面，右上模型下拉框就会出现 `qwen2.5:3b (Ollama)`，选中即可。
Ollama 没启动、模型名不对、中途断流，都会**自动回退到规则引擎**，
页面不会白屏或无限转圈。

> 模型地址强制只能是本机回环（`PIA_OLLAMA`，默认 `http://127.0.0.1:11434`）。
> 浏览器永远不直连模型服务，也就没有跨域、没有密钥泄露。

### 为什么不能用 ChatGPT / GPT 账号登录
平台的公开认证 Provider 只有 `email` / `phone` / `wechat` / `workbuddy`，
Google OAuth 已 retired，OpenAI / ChatGPT / TikTok / GitHub 从未提供；
模型目录里也没有 GPT 系列。本地版干脆**取消了登录**——
数据只在这台电脑上，本来就没有第二个人能访问，再要求验证码既没意义又要花钱。

如果点了「退出」看到登录页：输入**任意非空验证码**即可重新进入
（不发短信、不发邮件、零费用）。第三方登录按钮会明确返回「本地离线版不支持」，
**不会伪造成功、不会跳转到假页面**。

---

## 四、功能（与云端版完全一致）

- **快速记录**：输入一段话，自动分类为 想法 / 资料 / 待办，抽标题、标签、摘要、重点、截止日期、优先级
- **内容导入**：粘贴文本、上传文件、网页 URL 抓取、书签小工具；AI 拆解成最多 12 条独立知识条目
- **资料库**：关键词检索、分类 / 标签筛选、编辑、删除、重点提取、条目关联图谱
- **智能问答**：基于资料库召回内容作答，答案带 `[ID:n]` 引用，可点击跳转到原条目
- **待办**：勾选完成、AI 生成推进计划
- **阶段总结**：按 7 / 30 / 90 天生成复盘与行动建议，历史报告留存
- **中英双语**：零依赖 `i18n.js`，中文原文作字典 key；英文界面悬停可见中文对照；
  切换语言**不会改动任何已保存的用户数据**，也不会清空未保存的草稿
- **亮 / 暗双主题**

---

## 五、数据与隐私

- 唯一的数据文件：`data/pia.db`（SQLite，四张表：`items` / `item_links` / `chats` / `reports`）
- 首次启动自动建库建索引，启用 WAL
- 语言偏好只存在浏览器 `localStorage`
- **没有任何遥测、埋点、外链资源、CDN、第三方 API Key**
- 备份：停掉服务，复制 `data/pia.db`（连同 `-wal` / `-shm`）即可；恢复时覆盖回去
- 清空重来：删掉 `data/pia.db`，重启服务
- **切换成本地版不会自动搬走线上已有的记录**：两版账号体系、数据库完全不同，云端 RLS 下的笔记不会同步过来，也不会被删除。云端版仍可正常登录查看旧数据；需要迁移时，在线上版里手动复制出内容，再从本版的「导入 / 快速记录」录入

---

## 六、安全边界

服务端是给**一个人、一台电脑**用的，但依然按网络服务标准做了加固：

- 默认只监听 `127.0.0.1`，不对局域网开放；想开局域网必须显式设 `PIA_ALLOW_LAN=1`
- `/api` 校验 `Origin` 与本机 Host **精确一致**，恶意网页跨站调接口会被 403
- 请求体 4 MiB 上限；提示词 20 万字符上限；`limit` 钳制到 1000；单次插入最多 200 行
- 表名、列名、排序字段全部白名单，SQL **一律参数化**；`update` / `delete` 必须带过滤条件，拒绝全表操作
- 只放行白名单静态文件，`server.py` / `data/pia.db` 等不会被目录穿越读到
- 模型地址强制 loopback，避免被当成 SSRF 跳板
- 响应带 `X-Content-Type-Options: nosniff`、`Referrer-Policy: no-referrer`

> 注意：这是本机工具，不是多用户服务。若你主动用 `PIA_ALLOW_LAN=1` 开放到局域网，
> 等于把资料库开放给同网段的人，请自行承担风险。

---

## 七、测试

零第三方测试框架，两套共 54 项：

```bash
# 后端：数据库 CRUD / 安全 / 规则引擎（32 项，临时库，不碰真实数据）
python -m unittest discover -s tests -p "test_*.py" -v

# 前端：脚本顺序、去 CDN、app.js 字节级一致、兼容层请求形状（22 项）
node tests/local.test.js
```

后端测试把 Ollama 指向 `127.0.0.1:1`，**真实覆盖「没装 Ollama」这条路径**，
不发任何外网请求。`tests/local.test.js` 在 vm 沙箱里用假 `fetch` 验证
`auth` / `database` / `llm` 三大模块发给 `/api` 的请求形状。

---

## 八、目录结构

```
personal-info-agent-local/
├── index.html          页面骨架（已去掉云端 SDK CDN，缓存版本 20261106e）
├── app.js              业务逻辑 —— 与云端开源版字节级一致，零改动
├── i18n.js             零依赖双语层
├── i18n-dict.js        325 条英文字典
├── styles.css          主题与组件样式
├── config.js           本机公开配置（无密钥，apiBase = /api）
├── local-cloud.js      云端 SDK 的本地替身（核心新增）
├── server.py           Flask + SQLite + Ollama + 本地规则引擎（核心新增）
├── requirements.txt    唯一依赖：Flask
├── start.bat           Windows 双击启动
├── start.sh            macOS / Linux 启动
├── tests/
│   ├── test_server.py  后端 32 项
│   └── local.test.js   前端契约 22 项
├── .github/
│   ├── workflows/ci.yml  Python 3.10–3.13 单测 + 前端契约 + 凭证扫描
│   └── FUNDING.yml       爱发电赞助入口
├── CONTRIBUTING.md     贡献约定
├── SECURITY.md         安全边界与已知限制
├── LICENSE             MIT
└── README.md
```

> `data/pia.db` 首次启动时自动生成，已被 `.gitignore` 排除，**不会出现在仓库里**。

---

## 九、常见问题

**Q：为什么打开就直接用，没有登录页？**
单机数据没有第二个访问者，登录不提供额外保护。若你点了退出，登录页会回来，任意非空验证码可再进。

**Q：能同时用云端版和本地版吗？**
能，是两个独立目录、两套独立数据。数据不自动同步，需要的话从云端版导出后手动粘贴进本地版。

**Q：能用 ChatGPT / Google / GitHub 账号登录吗？**
不能，也不做假按钮、不收集任何第三方 API Key。国际用户直接用云端版的邮箱验证码即可（Gmail / Outlook 都行）。本地版无需任何账号。

**Q：规则引擎结果有点笨怎么办？**
装 Ollama 并 `ollama pull qwen2.5:3b`，刷新页面后在模型下拉框切换。全程仍然离线免费。

**Q：端口 8771 被占了？**
`python server.py --port 9000`，或直接改环境变量 `PIA_PORT`。

**Q：会把我的笔记传出去吗？**
不会。全部请求都是同源 `/api`，静态资源白名单，没有 CDN / 外链 / 遥测。可以用 DevTools 的 Network 面板自己核对。

---

## English (short)

A fully offline, zero-cost edition of Personal Info Butler.
Everything runs on your machine: Flask serves the page, SQLite stores the notes,
and AI features use either a local Ollama model or a built-in pure-Python rule engine.
**No cloud account, no API key, no token quota, no telemetry, no external requests.**

```bash
pip install -r requirements.txt
python server.py          # http://127.0.0.1:8771/
```

The UI is bilingual (中文 / English) with Chinese hover hints; switching language never
touches saved notes. `app.js` is byte-identical to the cloud open-source edition —
`local-cloud.js` simply emulates the cloud SDK over same-origin `/api`.

Sign-in with ChatGPT / Google / GitHub is not available (the platform never offered those
identity providers, and no GPT models exist in its catalogue). This offline edition needs
no sign-in at all. For real AI quality, install Ollama and pick a local model in the dropdown.

MIT licensed. Run `python -m unittest discover -s tests -v` and `node tests/local.test.js`.

Repository & issues: https://github.com/Mrchinazhang/personal-info-agent-local
