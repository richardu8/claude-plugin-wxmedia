---
name: configure
description: Set up the WeChat channel — scan QR code to login, check channel status. Use when the user asks to configure WeChat, login, or check channel status.
user-invocable: true
allowed-tools:
  - Read
  - Write
  - Bash(ls *)
  - Bash(mkdir *)
  - Bash(bun *)
---

# /wxmedia:configure — WeChat Channel Setup

Manages WeChat iLink Bot login and credential storage. Credentials live in
`~/.claude/channels/wxmedia/credentials.json`.

Arguments passed: `$ARGUMENTS`

---

## Dispatch on arguments

### No args — status and guidance

Read both state files and give the user a complete picture:

1. **Credentials** — check `~/.claude/channels/wxmedia/credentials.json` for
   `token` and `baseUrl`. Show set/not-set; if set, show token first 6 chars
   masked.

2. **Access** — read `~/.claude/channels/wxmedia/access.json` (missing file
   = defaults: `dmPolicy: "pairing"`, empty allowlist). Show:
   - DM policy and what it means
   - Allowed senders: count and list
   - Pending pairings: count with codes and sender IDs

3. **What next** — concrete next step based on state:
   - No credentials → *"Run `/wxmedia:configure login` to scan QR code and connect."*
   - Credentials set, nobody allowed → *"Send a message to the bot on WeChat. It replies with a code; approve with `/wxmedia:access pair <code>`."*
   - Credentials set, someone allowed → *"Ready. Message the bot on WeChat to reach the assistant."*

   When ready, also remind the user that inbound messages only arrive in a
   session started as a channel:

   ```
   claude --dangerously-load-development-channels plugin:wxmedia@richardu8-plugins
   ```

### `login` — QR code login

This is a TWO-STEP process. The scripts are in the plugin root, two levels
above this skill: `${CLAUDE_SKILL_DIR}/../..`. Run them with `--cwd` set to
that directory, called `<plugin-root>` below.

**Step 1: Fetch and display QR code**

```bash
bun --cwd "<plugin-root>" login-qr.ts
```

This script:
- Fetches a QR code from `https://ilinkai.weixin.qq.com/`
- Renders it in the terminal
- Shows the direct link (user can open in WeChat)
- Outputs JSON as the last line: `{"qrcode":"...","url":"..."}`

**Wait for the user** after showing the QR code. Tell them:
*"用微信扫描二维码，或在微信中打开上面的链接。扫码完成后告诉我。"*

Extract the `qrcode` value from the last line of output — you'll need it
for step 2.

**Step 2: Poll for scan result**

After the user says they've scanned (or just proceed after showing the QR):

```bash
bun --cwd "<plugin-root>" login-poll.ts <qrcode>
```

This script polls the WeChat API for scan status. It outputs one line:
- `scaned` — user scanned, waiting for confirmation on phone
- `expired` — QR expired (exit code 1). Offer to re-run step 1.
- `timeout` — timed out (exit code 1). Offer to re-run step 1.
- `{"token":"...","baseUrl":"...","accountId":"...","userId":"..."}` — success!
  Credentials saved and scanner added to allowlist. (exit code 0)

On success, tell the user:
- *"✅ 微信连接成功！"*
- Credentials saved, user added to allowlist
- *"重启 Claude Code 会话以启用微信频道"*

On `scaned`, tell the user *"已扫码，请在微信上点击确认..."* and note
the poll script is still running.

### `clear` — remove credentials

Delete `~/.claude/channels/wxmedia/credentials.json`.

### `baseurl <url>` — set custom API base URL

For testing or alternative iLink endpoints. Read existing credentials.json,
update `baseUrl`, write back.

---

## Implementation notes

- The channels dir might not exist if the server hasn't run yet. Missing file
  = not configured, not an error.
- On its first start the server copies `credentials.json` and `access.json`
  from `~/.claude/channels/weixin/` (the m1heng weixin plugin) when its own
  are missing. After that the two plugins keep separate state, so a login done
  here does not update the weixin plugin and vice versa.
- The server reads credentials.json once at boot. Credential changes need a
  session restart. Say so after saving.
- `access.json` is re-read on every inbound message — policy changes via
  `/wxmedia:access` take effect immediately, no restart.
- Default API base URL is `https://ilinkai.weixin.qq.com/`.
- The QR code URL is a WeChat mini-program link. It works when scanned with
  WeChat's QR scanner OR when opened in WeChat's built-in browser.
- Files received from WeChat are saved under
  `~/.claude/channels/wxmedia/inbox/` and are not cleaned up automatically.
