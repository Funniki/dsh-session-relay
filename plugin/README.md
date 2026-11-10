# dsh-session-relay

DeepSeek Harness（0.2.x）的**跨会话通信中继**：让同一进程里不同的会话（不是父子关系的子代理）互相发现、发消息、查回执、看进度、开平级新会话。

![会话之间直接对话](docs/preview.zh.svg)

解决的痛点：worker 会话想通知「主控」、主控想盯多个 worker 的进度时，Harness 只提供「父会话 → 子代理」这一条路，于是只能写 `ALERT-*.md` 交接文件等对方巡检。

## 与现有方案的关系

| 能力 | 本插件 |
|---|---|
| 发消息 | `relay_send` / `relay_reply` / `relay_broadcast`，投递模式 `auto`（对方在跑→`steer` 插到下一个 step 边界；空闲→`queue` 开新轮）/ `queue` / `steer` / `inject` |
| 消息格式 | 用 Harness **原生**的 `source.kind: 'agent-message'` + `form: 'relay'` + `senderSessionId`，天然通过 V4 准入（避开了 `kind: 'plugin'` 导致的「整条会话停写」事故，见 discussion #9971） |
| 寻址 | 稳定 handle（如 `amber-otter`）、自定昵称、完整 session id 三种都认 |
| 关系 | 连接记录（谁给谁起的名、何时）落盘，跨重启保留 |
| 回执 | `relay_receipt`：pending / claimed / discarded / unknown |
| 进度 | `relay_status`：turn/step、最后用户/助手文本、最近工具、排队数，**不唤醒对方** |
| 读取 | `relay_read`：读对方事件尾部，不唤醒 |
| 生命周期 | `relay_spawn`（平级新会话，可指定 cwd）/ `relay_rename` / `relay_archive`（P2） |
| 护栏 | `relay_rule`：给自己声明三阶段规则——`before` 拦截待执行的工具调用、`after` 打回结果要求纠正、`input` 在新步骤开头重申约束；按会话独立、跨重启保留 |

## 状态文件

`~/.dsh/session-relay/state.json`（可用 `DSH_HOME` 覆盖父目录；从 0.4.x 升级时自动读取一次
`~/.dsh/session-hub/state.json`，不会丢连接记录）：

```json
{
  "version": 1,
  "handles": { "session-…": "amber-otter" },
  "links": [{ "id": "…", "owner": "session-A", "peer": "session-B", "name": "主控", "note": "", "at": 1762000000000 }],
  "deliveries": [{ "messageId": "…", "from": "session-A", "to": "session-B", "at": 1762000000000, "mode": "queue", "receipt": "accepted" }]
}
```

最多保留 200 条投递记录。

## 配置（cordis row config）

| 字段 | 默认 | 说明 |
|---|---|---|
| `autoLink` | `true` | 首次发消息时自动建立连接 |
| `messageForm` | `relay` | 预留：消息呈现形态 |
| `defaultMode` | `queue` | 未显式指定 mode 时的投递方式：`queue`=每条回传都开新回合（会显示「收到任务消息」卡片，不打断对方当前回合）；`auto`=对方在跑就 `steer`（插到下个 step 边界，立即可见但不新开回合）；`steer` / `inject` 同理 |

## 安全边界

- 只能寻址**人在侧栏看得见**的会话：归档、空白占位、子代理一律拒绝；
- 不能给自己发消息；
- 单条消息正文上限 30,000 字符；广播上限 20 个目标；
- `relay_read` / `relay_status` 只读，不唤醒对方。

## 工具一览

| 工具 | 用途 |
|---|---|
| `relay_list` | 列出可寻址会话（handle / 标题 / 状态 / cwd / 是否已连接） |
| `relay_whoami` | 自己的 session id 与 handle |
| `relay_link` / `relay_unlink` | 起昵称 / 断开 |
| `relay_send` / `relay_reply` / `relay_broadcast` | 发消息 / 回信 / 批量 |
| `relay_receipt` | 查送达回执 |
| `relay_status` | 不打扰地看进度 |
| `relay_read` | 读事件尾部 |
| `relay_rule` | 三阶段护栏：`add` / `list` / `remove` |

## 安装

**一条命令**（npm 渠道）：

```bash
dsh plugin --profile desktop add dsh-session-relay@0.1.1
```

> 版本号要显式写出来。刚发布不久时，`pnpm` 的 `minimumReleaseAge` 供应链策略会挡住新版本，
> 裸写包名可能解析到旧版本。安装脚本已经处理了这个，手动装时记得带上版本。

**或者用 zip**：下载 Release 里的 `dsh-session-relay-0.1.1.zip`，解压到固定目录后：

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1     # Windows
sh ./install.sh                                            # macOS / Linux
```

脚本会自动判断这是本地目录还是已发布的包，装完检查「能不能从 profile 根解析」「有没有登记成 bundle」。
`DSH_PROFILE=web` 可指定别的 profile，`DSH_VERSION` 可钉版本。

装完重启 DSH（或到插件页关掉再开一次 bundle）。插件没有第三方依赖，不需要 `pnpm install`。


## 护栏：`relay_rule`

规则只作用于**声明它的会话自己**，不会去管别的会话；三个阶段：

| phase | 触发点 | 效果 |
|---|---|---|
| `before` | 工具执行前 | `action: "block"` 直接拒绝该次调用（`warn` 只记命中） |
| `after` | 工具执行后 | 结果被丢弃，并把 `text` 作为纠正反馈交还给模型，要求重做 |
| `input` | 每次进入新步骤 | 把 `text` 作为一条上下文消息重申（`once: "turn"` 每回合一次 / `"session"` 每会话一次） |

匹配条件：`tool`（工具名或 `*`）+ 可选 `match`（序列化后的调用参数子串）+ 可选 `resultMatch`（after 专用，结果子串）。

## 从旧版本升级

本插件原名为 `dsh-session-hub`。发布时改名，包名、bundle 行、模块 id、**工具名（`hub_*` → `relay_*`）**
全部换成 `relay`；状态目录从 `~/.dsh/session-hub/` 自动读取一次并迁移到 `~/.dsh/session-relay/`，
已有规则里的旧工具名会自动改写，所以升级后不需要重新配置。
旧会话里的中继卡片仍能识别（`SOURCE_LABELS` 保留旧值）。

升级时**先卸载旧包再装新包**：`dsh plugin --profile desktop remove dsh-session-hub`。
两个包同时存在会重复注册工具。

## 当前版本

当前版本：**0.1.1**
