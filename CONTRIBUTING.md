# 参与贡献

谢谢你愿意帮这个离线小工具变得更好。它是**零构建、零 CDN、零云端依赖**的项目，改动时请守住这几条底线。

## 本地跑起来

```bash
git clone https://github.com/Mrchinazhang/personal-info-agent-local.git
cd personal-info-agent-local
python -m pip install -r requirements.txt
python server.py
```

打开 <http://127.0.0.1:8771/>。需要 Python 3.10+；Node 只在跑前端契约测试时才需要。

## 从运行版同步代码

维护者本机另有一个「运行版」目录（真正跑服务、存放 `data/pia.db`）。改完那边之后，
双击本目录的 `sync.bat` 或运行 `python sync.py` 即可按白名单同步 15 个代码文件并自动
提交推送；`python sync.py --dry-run` 可先预览。脚本**不会**覆盖本仓库的 `README.md`
和 `.github/` 等专属文件，也不会把个人数据库带进来。详见 README「维护者：从运行版一键同步」。

## 提交前自查

```bash
# 后端 32 项 + 同步脚本 13 项
python -m unittest discover -s tests -p "test_*.py" -v

# 前端契约 22 项
node tests/local.test.js

# JS 语法
node --check app.js && node --check local-cloud.js && node --check i18n.js && node --check i18n-dict.js
```

`push` 后 GitHub Actions 会在 Python 3.10 / 3.11 / 3.12 / 3.13 上跑后端单测，另跑前端契约、凭证扫描与「个人数据未入库」检查。

## 几条硬性约定

- **绝不提交 `data/` 下的任何内容**：`data/pia.db`、`-wal`、`-shm` 是用户真实笔记，`__pycache__` / `*.pyc` / `*.log` 同理。CI 会拦截。
- **不要引入云端 SDK、CDN、外链字体、统计脚本或任何第三方 API Key**。这一版的全部意义就是断网也能用、不产生任何费用。
- **`app.js` / `i18n.js` / `i18n-dict.js` / `styles.css` 与 [云端开源版](https://github.com/Mrchinazhang/personal-info-agent) 保持字节级一致**：修了云端版的 bug 直接复制过来，不要在这里单独改。`tests/local.test.js` 会在检测到同级云端版目录时自动比对；CI 里没有该目录时会跳过这一项。
- 改过任何 JS/CSS，就把 `index.html` 里所有 `?v=YYYYMMDDx` 缓存版本号一起递增，否则浏览器继续用旧文件。
- 新增的界面文案要走 `tr('中文原文')`，并在 `i18n-dict.js` 补英文；用户笔记内容一律不经过翻译。
- `config.js` 里只有本机占位值（`resourceId: 'local'` 等），**不要往里填任何真实密钥或云资源 ID**。
- 后端改动保持现有安全边界：只监听 `127.0.0.1`、请求体上限、表名/列名白名单、SQL 参数化、静态文件白名单、Ollama 地址强制 loopback。

## PR 约定

一个 PR 只解决一件事，说明改动机与验证方式；涉及规则引擎的行为变化，请同时在 `tests/test_server.py` 里补一条确定性用例（测试不发真实网络请求）。
