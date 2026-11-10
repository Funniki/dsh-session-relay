# dsh-session-relay — 验证记录

验证环境：Windows，DSH 0.2.1-rc.x，profile `desktop`，工作区 `default-workspace`。
验证方式：装进当前 DSH 实例后，用真实会话互相收发消息、读取事件、加规则触发。

版本：**0.1.1**（15 工具）

---

## 0. 自动化门槛（每次发版前必跑）

下面这些是脚本，不是手工记录 —— 手工验证过的坑下次仍会重现，脚本不会忘：

| 命令 | 查什么 |
|---|---|
| `node tools/build-release.cjs --check` | 包名/版本/许可证、`engines.dsh` 可满足、`files` 齐全、客户端 id == 包名、宿主半边只 import `node:`、patch 行名 == 包名、文档版本不漂移 |
| `node verification/plugin-smoke.test.mjs` | 真的 `apply()` 一次：注册 15 个工具、订阅 3 个事件、状态目录跟随 `DSH_HOME` |
| `node verification/verify-release.mjs --local` | 对 `pnpm pack` 出来的产物重查：id、`node:`、图标、locale、无 `node_modules` |
| `node tools/build-release.cjs` | 打出 `dist/dsh-session-relay-<版本>.zip` |
| `node verification/install-paths.test.mjs` | 用真实脚本装进临时 profile：版本对、id 对、登记成 bundle（两种脚本各一遍） |
| 发布后 `--version <版本> --tag latest --install` | 从 registry 下载 tarball 再查一遍，并真装一次 |
| `node tools/release-guard.mjs` | 相对上个 tag 只有版本号变动时，拒绝发布 |

---

## 1. 消息投递与回执

| 验证项 | 做法 | 结果 |
|---|---|---|
| 发消息给空闲会话 | `relay_send target=sunny-lynx mode=queue` | `accepted`；对方新开 turn，读到内容；`relay_receipt` 返回 **claimed** |
| 消息落盘格式 | 读对方事件 seq 831 | `source: { kind: "agent-message", form: "relay", senderSessionId: "session-…" }` ✅ v4 合法 |
| 双向回信 | 对方 `relay_reply` 给我 | 我这边收到 peer 消息（steer 插入当前回合）；事件可在我的会话日志中检索到 |
| 投递模式默认值 | 改配置 `defaultMode: queue` 后发消息 | 对方 `turn 6` 被开启，开头为「收到任务消息」触发（turn-trigger） |
| 广播错误路径 | `relay_broadcast` 传不存在的 session id | 返回 `ok:false` + 原因，不影响其他目标 |

## 2. 发现与读取（只读，不唤醒）

| 验证项 | 结果 |
|---|---|
| `relay_list` | 列出可寻址会话（handle / title / status / cwd / workspace / linked） |
| `relay_status` | 返回 turn/step、最后用户/助手文本、最近工具名、pending、title |
| `relay_read` | 返回事件尾部（seq/type/time/preview），带 title |
| 归档过滤 | 归档会话从 `relay_list` 消失（`archivedSessionIds` 兼容 Map/Set/Array） |

## 3. 生命周期

| 验证项 | 结果 |
|---|---|
| `relay_spawn` | 创建平级会话 → `attached: true`、`workspaceTitle: default-workspace`、自动按 name 改标题；派首个任务成功，对方回「OK」 |
| `relay_rename` | 改标题成功，返回 `seq` |
| `relay_archive` | 归档成功，之后列表不再出现 |
| `relay_attach` | 把「未分组」会话挂回其工作目录所属工作区（实测 `hub-测试2` → `default-workspace`） |
| 重名保护 | 同昵称 spawn 被拒绝；昵称解析取最新链接 |

## 4. 寻址

| 验证项 | 结果 |
|---|---|
| 昵称 / handle / sessionId | 三种均可寻址 |
| 唯一标题 | `relay_status target="文件清理助手"` 命中正确会话并返回 title |
| 不存在的标题 | 明确报错，不乱匹配 |
| 多会话同名 | 代码路径：报错并列出候选（未在真实重复标题上触发过） |

## 5. 三阶段护栏（relay_rule）

| 阶段 | 实测 | 结果 |
|---|---|---|
| `before` | 规则禁止 `relay_whoami` | 调用被拒：`Blocked by standing rule …` ✅ |
| `after` | 规则匹配结果里的 `"handle"` | 结果被丢弃，返回纠正反馈，要求重做 ✅ |
| `input` | 约束每回合重申 | 下一步开头出现 `[standing rule <id> declared in this conversation] …` ✅ |
| 清理 | `action=remove` | 规则删除，`state.json` 中 `rules: []` ✅ |

## 6. 状态文件

`~/.dsh/session-relay/state.json`（0.4.x 的 `~/.dsh/session-hub/state.json` 会被读取一次用于迁移）：

```json
{ "version": 1, "handles": {}, "links": [], "deliveries": [], "rules": [] }
```

原子写（临时文件 + rename）；投递记录上限 200 条；规则上限 50 条/会话。

---

## 已知边界

- 只能寻址侧栏可见会话（归档 / 空白 / 子代理一律拒绝）；
- 「收到任务消息」卡片只在消息**开启新回合**时出现（`queue`）；`steer` 是回合中插入，不显示该卡片；
- 客户端半身需要刷新页面才生效（client bundle 按进程缓存）；
- 同一昵称曾指向旧会话的坑已修（取最新链接 + spawn 拒绝重名）。
