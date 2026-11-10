![Sessions talk to each other](preview.svg)

Harness only offers one path: parent session → sub-agent. Peer sessions that need to
cooperate end up writing hand-off files such as `ALERT-*.md` and waiting for someone to
notice — slow, easy to miss, and it litters the workspace.

**This plugin wires the sessions into a network.** Every session gets a stable handle and
can message another, check the receipt, inspect progress without waking it, or open a new
peer session. Messages ride Harness's native channel (`source.kind: agent-message` +
`form: relay`): no extra process, no temporary files in your repository.

## What it does

| Capability | Tools |
|---|---|
| Discover sessions | `relay_list` (handle / title / status / cwd; archived and sub-agent sessions excluded) |
| Send, reply, broadcast | `relay_send` · `relay_reply` · `relay_broadcast` |
| Delivery receipts | `relay_receipt`: `pending` / `claimed` / `discarded` / `unknown` |
| Watch progress quietly | `relay_status` / `relay_read` — read-only, never wakes the peer |
| Spawn a peer | `relay_spawn` (with its own cwd; not a sub-agent) |
| Names and links | `relay_link` · `relay_unlink` · `relay_rename` |
| Three-phase guards | `relay_rule`: `before` blocks a tool call, `after` rejects a result, `input` restates a constraint |

## Design choices

- **You pick the delivery mode**: `queue` opens a new turn on the peer (good for work
  hand-off), `steer` joins its next step boundary (immediate, not interrupting), `inject`
  adds context without waking it.
- **Receipts are native**, not a bespoke state machine: the message is a Harness event and
  the delivery pipeline reports what happened to it.
- **Only addressable sessions are reachable**: archived, blank and sub-agent sessions are
  refused; you cannot message yourself.
- **Zero runtime dependencies**: host services come from `ctx.get`, so installing pulls
  nothing else in.
