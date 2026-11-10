# 变更日志

## 0.1.1

首个公开发布的版本。功能与开发期的 0.4.1 一致，以下是发布所做的改造：

- **改名为 `dsh-session-relay`**：`dsh-session-hub` 这个名字在 npm 上已被他人占用。
  包名、bundle 行、浏览器半边的模块 id、**工具名前缀（`hub_*` → `relay_*`，共 15 个）**
  一并改。
- **旧状态自动迁移**：仍会读取一次 `~/.dsh/session-hub/state.json`，之后写入
  `~/.dsh/session-relay/`；其中规则里的 `hub_*` 工具名会自动改写成 `relay_*`，
  升级后护栏不会静默失效。
- **历史消息仍可识别**：`SOURCE_LABELS` 保留 `dsh-session-hub` / `session-hub`，
  旧会话里的中继卡片照常渲染。
- **去掉 `private: true`**，补 `publishConfig`、`repository`、`homepage`、`bugs`、`keywords`。
- **新增 `engines.dsh`（`>=0.2.1-rc.5 <0.3.0`）**：0.2.2 起宿主按它判定插件是否可安装。
- **补 `LICENSE`（MIT）**。
- **插件页展示**：新增 `docs/DETAIL.md` / `DETAIL.zh.md` 与 `docs/preview.svg` /
  `preview.zh.svg`，插件页渲染的是这份策划过的图文说明，而不是把 README 直接铺上去。
- **新增安装脚本** `install.ps1` / `install.sh`：装完自检「能否从 profile 根解析」和
  「有没有登记成 bundle」，支持 `DSH_PROFILE` / `DSH_VERSION` / `DSH_FROM_REGISTRY`。
- **新增发布前门槛**（脚本，非手工）：
  - `tools/build-release.cjs`：审计 + 打 zip；
  - `verification/plugin-smoke.test.mjs`：真实 `apply()` 一次；
  - `verification/verify-release.mjs`：对产物（tarball / 本地 pack）逐项复查；
  - `verification/install-paths.test.mjs`：用真实脚本装进临时 profile 并断言结果；
  - `tools/release-guard.mjs`：只有版本号变动时拒绝发布。
