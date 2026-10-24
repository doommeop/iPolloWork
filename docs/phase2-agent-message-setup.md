# 受限版 Phase 2（agent-message）安裝與使用指南

在**另一台電腦**上安裝並跑起含「跨 session agent 訊息」功能的 iPolloWork server。
依序照做，約 20–40 分鐘（視 pnpm install 速度）。

---

## 第 0 步：確認要裝的來源

本指南對應 `doommeop/iPolloWork` 的 `phase2-agent-message` 分支。

---

## 第 1 步：裝前置工具（順序照表格，只裝一次）

| # | 工具 | 安裝方式 | 備註 |
|---|------|---------|------|
| 1 | **git** | `winget install Git.Git` 或 [git-scm.com](https://git-scm.com) | 最先裝，後面都要用 |
| 2 | **Node.js LTS** | `winget install OpenJS.NodeJS.LTS` 或 [nodejs.org](https://nodejs.org) | 選 LTS |
| 3 | **pnpm** | `npm install -g pnpm` | 封鎖 repo 的 package manager |
| 4 | **bun** | `npm install -g bun` | 跑 dev server 與測試 |
| 5 | **Visual Studio Build Tools**（Windows 必裝）| [visualstudio.microsoft.com/visual-cpp-build-tools](https://visualstudio.microsoft.com/visual-cpp-build-tools/) | 勾「**使用 C++ 的開發**」workload。`better-sqlite3` 等 native 模組要靠它編譯；**漏裝會讓 `pnpm install` 失敗** |
| 6 | GitHub 帳號 | 網頁登入 [github.com](https://github.com) | 要能 clone `doommeop/iPolloWork`（fork 公開或你本人）|

> macOS / Linux 沒有 VS Build Tools 一步；改用系統預設編譯器（Xcode CLT / build-essential）即可。

---

## 第 2 步：拿原始碼

```bash
# 1. 克隆你的 fork（或上手的 iPolloWork repo）
git clone https://github.com/doommeop/iPolloWork.git
cd iPolloWork

# 2. 切到 Phase 2 分支
git checkout phase2-agent-message
```

---

## 第 3 步：同步上游最新 main（強烈建議）

你的分支基於某時間點的 main；上游 `Devin-AXIS/iPolloWork` 可能已經前進。

```bash
# 只有還沒設 upstream 才需要第一行
git remote add upstream https://github.com/Devin-AXIS/iPolloWork.git
git fetch upstream
git rebase upstream/main
```

- 若 rebase 出衝突：解開衝突 → `git add <檔案>` → `git rebase --continue`。
- 解完重跑第 5 步的測試確認沒被新改動影響。

---

## 第 4 步：裝依賴

```bash
pnpm install
```

- 首次會編譯 native 模組（better-sqlite3 等），較慢，正常。
- 若報 `gyp ERR! find VS` → 回第 1 步補裝 VS Build Tools（重開終端機再試）。
- 若報 `ERR_PNPM_CATALOG_ENTRY_NOT_FOUND`（react catalog）→ 檢查 pnpm 版本：`pnpm -v` 應 ≥ 9；可試 `pnpm install --no-frozen-lockfile`。

---

## 第 5 步：驗證（兩項都綠才繼續）

```bash
cd apps/server

# 1. 單元 + e2e 測試（應 31 pass）
bun test src/agent-message.test.ts src/agent-message.e2e.test.ts

# 2. 型別檢查（無輸出 = 通過）
bunx tsc -p tsconfig.json --noEmit
```

---

## 第 6 步：啟動 dev server

```bash
cd apps/server
bun run dev
```

> `dev` script 是 `cross-env IPOLLOWORK_DEV_MODE=1 bun src/cli.ts`。
> 若 `cross-env` 找不到，改用：
> ```
> # Windows PowerShell
> $env:IPOLLOWORK_DEV_MODE=1; bun src/cli.ts
> # macOS / Linux
> IPOLLOWORK_DEV_MODE=1 bun src/cli.ts
> ```

成功後 server 監聽本地 port（log 會印出來）。

---

## 第 7 步：使用 Phase 2（agent-message）

### API（需 client token；header `Authorization: Bearer <client-token>`）

```bash
# 1. 登記 agent（每個要參與互傳的 session 都要登記）
curl -X POST http://127.0.0.1:<port>/workspace/<wsId>/agents \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"agentKey":"coordinator","sessionId":"ses_...","role":"coordinator"}'

curl -X POST http://127.0.0.1:<port>/workspace/<wsId>/agents \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"agentKey":"writer","sessionId":"ses_...","role":"worker"}'

# 2. 互傳訊息
curl -X POST http://127.0.0.1:<port>/workspace/<wsId>/agent-message \
  -H "Authorization: Bearer <token>" -H "Content-Type: application/json" \
  -d '{"fromAgent":"coordinator","toAgent":"writer","body":"請撰寫文案"}'

# 3. 查 trace
curl http://127.0.0.1:<port>/workspace/<wsId>/agent-message-trace \
  -H "Authorization: Bearer <token>"
```

### 引擎工具（agent 在對話中直接呼叫）
- `ipollowork_send_agent_message({ targetAgent, body, traceId? })`
- OpenCode agent 經 `ipollowork_session_call` 轉發；Codex/DeepSeek 經 MCP bridge（`/engine-tools/mcp`）。
- 前置：呼叫方的 session 必須已登記在該 workspace 的 agent registry。

### 護欄（預設值，`DEFAULT_AGENT_MESSAGE_CONFIG`）
| 護欄 | 預設 | 行為 |
|------|------|------|
| 每對 depth | 3 | 超過 → `depth_exceeded` |
| workspace budget | 60 | 超過 → `budget_exceeded` + `frozen:true` |
| 拓撲 | coordinator 主導 | worker→worker 須 pair 已被 coordinator 啟用、限 2 輪 |
| 同引擎 | true | 跨引擎 → `engine_mismatch` |
| 訊息長度 | ~500 tokens | 超過截斷 + `[truncated]` |

---

## 備忘

- **Persistence**：agent 登記與 trace 寫入 `<runtime-db 目錄>/agent-message.sqlite`
  （預設與 server runtime DB 同目錄；環境變數 `IPOLLOWORK_RUNTIME_DB` 可改位置）。
  重啟 server 後 agent 與 trace 還在；depth/budget 計數器會重置（設計上接受）。
- **要貢獻回上游**：`Devin-AXIS/iPolloWork` 開 New pull request，base 選 `upstream:main`、compare 選 `doommeop:phase2-agent-message`。
- **日常更新上游**：`git fetch upstream && git rebase upstream/main` 後重跑第 5 步。
