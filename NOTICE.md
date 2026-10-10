# Notices

wxmedia is released under the MIT License (see [LICENSE](LICENSE)). Parts of it
derive from the works below. Those parts stay under their original licenses.

## m1heng/claude-plugin-weixin

- Source: https://github.com/m1heng/claude-plugin-weixin
- License: MIT, as stated in that project's README and `package.json`
- Copyright (c) m1heng

Derived files: `server.ts` (access gate, pairing, allowlist, long-poll loop and
the outline of the `reply` tool), `login-qr.ts`, `login-poll.ts`,
`skills/access/SKILL.md`, `skills/configure/SKILL.md`, and the MCP server entry
in `.claude-plugin/plugin.json`.

Changes made here: sending and receiving images, videos and files; relaying
tool approvals and multiple-choice questions to WeChat; polling only in sessions
started as a channel, with hand-over between sessions; state kept under
`~/.claude/channels/wxmedia/`; shutdown when the session closes.

The MIT License:

> Permission is hereby granted, free of charge, to any person obtaining a copy
> of this software and associated documentation files (the "Software"), to deal
> in the Software without restriction, including without limitation the rights
> to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
> copies of the Software, and to permit persons to whom the Software is
> furnished to do so, subject to the following conditions:
>
> The above copyright notice and this permission notice shall be included in all
> copies or substantial portions of the Software.
>
> THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
> IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
> FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
> AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
> LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
> OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
> SOFTWARE.

## Telegram channel plugin for Claude Code

- Source: https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram
- License: Apache License 2.0, a copy is in [LICENSE-APACHE](LICENSE-APACHE)
- Copyright 2026 Anthropic, PBC

The weixin plugin above follows the structure of this plugin, so parts of
`server.ts` and `skills/access/SKILL.md` trace back to it: the access-control
model, the pairing flow, the shape of the MCP server and its instructions. The
handling of permission relay requests in `server.ts` is also modelled on it.
These parts were modified for WeChat as described above and remain under the
Apache License 2.0.

## @tencent-weixin/openclaw-weixin

- Source: https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin
- License: MIT
- Copyright (C) 2026 Tencent

Used as the reference for the iLink Bot protocol: endpoints, request fields, CDN
upload and the AES-128-ECB encryption of media. `ilink.ts` and `media.ts` were
written for this plugin against that reference; no source files were copied.
