# dsh-session-relay — guide

The plugin page shows the landing page only; the details live here.

## How it compares

| Capability | This plugin |
|---|---|
| Sending | `relay_send` / `relay_reply` / `relay_broadcast`. Delivery mode `auto` (steer a running peer at its next step boundary, queue for an idle one), `queue`, `steer`, `inject` |
| Message shape | The harness-native `source.kind: 'agent-message'` with `form: 'relay'` and `senderSessionId`, so it passes V4 admission (avoids the whole-session write stall caused by `kind: 'plugin'`, discussion #9971) |
| Addressing | Stable handle (like `amber-otter`), a custom nickname, or a full session id |
| Relations | Link records (who named whom, when) persist across restarts |
| Receipts | `relay_receipt`: pending / claimed / discarded / unknown |
| Progress | `relay_status`: turn/step, last user and assistant text, recent tools, inbox depth — without waking the peer |
| Reading | `relay_read`: the tail of a peer's event log, without waking it |
| Lifecycle | `relay_spawn` (a fresh peer conversation, optional cwd) / `relay_rename` / `relay_archive` (P2) |
| Guards | `relay_rule`: three-phase rules for your own session — `before` blocks a pending call, `after` rejects a result and asks for a correction, `input` restates a constraint at the start of each step. Per-session and persisted |

## State file

`~/.dsh/session-relay/state.json` (`DSH_HOME` overrides the parent directory; on upgrade from 0.4.x
`~/.dsh/session-hub/state.json` is read once, so no link records are lost):

```json
{
  "version": 1,
  "handles": { "session-…": "amber-otter" },
  "links": [{ "id": "…", "owner": "session-A", "peer": "session-B", "name": "lead", "note": "", "at": 1762000000000 }],
  "deliveries": [{ "messageId": "…", "from": "session-A", "to": "session-B", "at": 1762000000000, "mode": "queue", "receipt": "accepted" }]
}
```

At most 200 delivery records are kept.

## Row config

| Field | Default | Meaning |
|---|---|---|
| `autoLink` | `true` | Create a link on the first message to a peer |
| `messageForm` | `relay` | Reserved: how relay messages are presented |
| `defaultMode` | `queue` | Delivery used when a call omits `mode`: `queue` starts a new turn for each delivery (shows a "task message received" card without interrupting the peer's current turn); `auto` steers a running peer at its next step boundary; `steer` / `inject` behave as named |

## Boundaries

- Only sessions a human can see in the sidebar are addressable; archived, blank placeholder and subagent sessions are refused;
- A session cannot message itself;
- 30,000 characters per message body, 20 targets per broadcast;
- `relay_read` / `relay_status` are read-only and never wake the peer.

## Tools

| Tool | Purpose |
|---|---|
| `relay_list` | Addressable sessions (handle / title / state / cwd / linked) |
| `relay_whoami` | Your own session id and handle |
| `relay_link` / `relay_unlink` | Name a peer / drop the name |
| `relay_send` / `relay_reply` / `relay_broadcast` | Send / reply / fan out |
| `relay_receipt` | Delivery receipt |
| `relay_status` | Progress without disturbing |
| `relay_read` | Tail of a peer's events |
| `relay_rule` | Three-phase guards: `add` / `list` / `remove` |

## Install

```bash
dsh plugin --profile desktop add dsh-session-relay@0.1.1
```

> Spell the version out. For a fresh release, pnpm's `minimumReleaseAge` supply-chain policy holds the
> new version back and a bare package name can resolve to an older one. The installer handles this;
> a manual install has to pin it.

**Or from the zip**: download `dsh-session-relay-0.1.1.zip` from the release, unpack it, then:

```powershell
powershell -ExecutionPolicy Bypass -File .\install.ps1     # Windows
sh ./install.sh                                            # macOS / Linux
```

The script works out whether this is a local directory or a published package, installs it, then
checks that it resolves from the profile root and that it is registered as a bundle.
`DSH_PROFILE=web` picks another profile, `DSH_VERSION` pins the version.

Restart DSH afterwards (or toggle the bundle off and on in the plugin page). There are no third-party
dependencies, so no `pnpm install` is needed.

## Guards: `relay_rule`

Rules apply to the session that declared them and no other. Three phases:

| phase | Fires | Effect |
|---|---|---|
| `before` | Before a tool runs | `action: "block"` refuses that call (`warn` only records the hit) |
| `after` | After a tool runs | The result is discarded and `text` is handed back as correction feedback |
| `input` | At the start of each step | `text` is restated as a context message (`once: "turn"` once per turn / `"session"` once per session) |

Matching: `tool` (a tool name or `*`) plus optional `match` (substring of the serialized arguments) and
optional `resultMatch` (result substring, `after` only).

## Upgrading from an older release

This plugin used to be called `dsh-session-hub`. The package name, bundle row, module id and
**tool names (`hub_*` → `relay_*`)** all changed to `relay`; the state directory is read once from
`~/.dsh/session-hub/` and migrated to `~/.dsh/session-relay/`, and tool names already stored in rules
are rewritten, so nothing needs reconfiguring. Relay cards in old conversations still render
(`SOURCE_LABELS` keeps the old values).

Remove the old package before installing the new one:
`dsh plugin --profile desktop remove dsh-session-hub`. Both installed at once register the tools twice.

## Current version

Current version: **0.1.1**
