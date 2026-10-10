# wxmedia

给[Claude Code](https://claude.com/claude-code)用的微信channel插件。在终端里的Claude Code会话和微信之间收发消息，文字、图片、视频、文件都支持，还能把Claude提的选择题转到微信上回答。

A WeChat (微信) channel plugin for Claude Code. It sends and receives text, images, videos and files, and can put Claude's multiple-choice questions on WeChat. The documentation is in Chinese.

本插件在[m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin)（只能收发文字）的基础上改写，走微信iLink Bot API，在本机长轮询，不需要公网地址。这是个人项目，与腾讯、Anthropic无关。

## 功能

- **发**：`reply`工具带`files`参数（绝对路径）。png、jpg、gif按图片发，mp4、mov按视频发，其余类型（pdf、docx、xlsx、zip、tiff、heic等）按文件发。`as_file: true`可以把图片、视频也按文件发，保留原始字节和文件名。单个文件上限100MB，这是插件自己定的，不是微信的限制。
- **收**：微信发来的图片、文件、视频会下载解密到`~/.claude/channels/wxmedia/inbox/`，路径放在消息标签的`image_path`或`attachment_path`属性里，Claude可以直接读。inbox不会自动清理。
- **主动发**：白名单里只有一个用户时，`reply`可以不带`user_id`和`context_token`，在任何会话里把东西发到自己的微信。
- **终端提示转到微信**：Claude提的选择题、工具审批可以在微信上回答，见下文。
- **多个会话互不抢消息**：只有带channel参数启动的会话才收消息，同时开几个时由最新的那个收。
- **访问控制**：配对码加白名单，和原插件相同。

## 环境要求

- Claude Code，要支持channel（研究预览功能）。上游插件要求v2.1.80以上，本插件只在2.1.293到2.1.296上测试过。
- [Bun](https://bun.sh)。测试用的是1.4.2。
- 只在macOS上测试过。插件靠`ps`读取Claude Code的启动参数，其他系统上没有验证。

## 安装

```bash
claude plugin marketplace add richardu8/claude-plugin-wxmedia
claude plugin install wxmedia@richardu8-plugins
```

第一次启动时插件会运行`bun install`取依赖，需要联网。

## 登录

在Claude Code里运行：

```
/wxmedia:configure login
```

终端会显示二维码，用微信扫码并在手机上确认。登录凭证存在`~/.claude/channels/wxmedia/credentials.json`，扫码的微信号自动进白名单。

用过m1heng的weixin插件的机器不用重新扫码：第一次启动时，wxmedia会把`~/.claude/channels/weixin/`里的登录凭证和白名单复制过来。

## 启动

```bash
claude --dangerously-load-development-channels plugin:wxmedia@richardu8-plugins
```

channel还在研究预览阶段，非官方插件要用`--dangerously-load-development-channels`这个参数加载，启动时Claude Code会要求确认一次。

`plugin:`后面的`wxmedia@richardu8-plugins`要和`claude plugin list`里显示的名字完全一致。对不上时Claude Code不会把微信消息交给会话；插件遇到这种情况不收消息，并在会话开头提示怎么改。

只有这样启动的会话才收微信消息。别的会话里插件也在，但不轮询，只提供`reply`工具。同时开了多个这样的会话时，只有最新启动的那个收消息，它退出后由剩下的接手。

命令太长，可以在`~/.zshrc`里加个别名：

```bash
alias wx='claude --dangerously-load-development-channels plugin:wxmedia@richardu8-plugins'
```

## 让别的微信号也能用

默认只有扫码登录的微信号能给Claude发消息。别人发消息时会收到一个配对码，你在Claude Code里运行`/wxmedia:access pair <配对码>`批准后，对方才进白名单。`/wxmedia:access`不带参数时显示当前白名单和待批准的配对。

## 终端里的提示转到微信

带channel参数启动的会话里，两类终端提示可以在微信上回答，终端上也照常能答，先答的生效：

- **选择题**（Claude用AskUserQuestion提的问题）：微信收到【Claude提问】和编号选项，回复序号，多选回“1,3”，也可以直接回复文字。一次有几道题时逐题发。最长等约24小时，过后微信上不再接收答案，要回终端作答。
- **工具审批**（“是否允许运行这条命令”）：微信收到【需要审批】，回复“y”允许、“n”拒绝。超过10分钟才回复时要带编号，如“y abcde”。只有终端真的弹出确认框时才有东西可转，这取决于会话的权限模式：手动确认模式（启动时加`--permission-mode manual`）下，改文件、运行非只读命令都会弹；auto模式下由分类器自动放行，一般不弹；`--dangerously-skip-permissions`下完全不弹。`date`、`ls`这类只读命令在哪种模式下都不弹。

什么时候转，由`access.json`的`relay`决定，用`/wxmedia:access set relay <值>`修改：

- `auto`（默认）：只有会话最近一条输入来自微信时才转，也就是任务是从微信布置的。
- `always`：都转。别的会话里的选择题也会转，只要有一个带channel参数的会话开着收回复。
- `never`：不转。

有选择题在等答案期间，你在微信上发的文字都会被当成这道题的答案，不会作为新消息交给Claude。`auto`下这道题本来就属于微信上的对话；`always`下别的会话的选择题也会这样截走消息。

转不了的：计划模式的批准、启动时的开发channel确认、目录信任和MCP同意框，这些只能在终端里操作。

实现上，工具审批用Claude Code的channel权限转发；选择题用`hooks/ask.ts`这个PermissionRequest钩子。待答的提示记在状态目录的`pending/`，回复经`answers/`交给发出提示的进程，所以多个会话同时开着也能对上。

## 从weixin插件换过来

**不要和weixin插件同时启用。** weixin插件在每个会话里都轮询同一个bot，会和wxmedia抢消息。换用前先停用它：

```bash
claude plugin disable weixin@m1heng-plugins
```

停用后，退出所有Claude Code会话，再清一次它留下的后台进程。weixin插件的服务进程在会话退出后不会自己结束，会一直在后台收消息，收到的消息就丢了；wxmedia启动时的提醒只看设置，发现不了它。

```bash
for p in $(pgrep -f "bun server.ts"); do
  lsof -a -p "$p" -d cwd -Fn | grep -q "m1heng-plugins/weixin" && kill "$p" && echo "已结束旧进程$p"
done
```

## 收不到消息时

按顺序查：

1. 会话是不是带着`--dangerously-load-development-channels plugin:wxmedia@richardu8-plugins`启动的。改过别名之后，已经打开的终端要运行`source ~/.zshrc`或重开才生效。
2. `plugin:`后面的名字和`claude plugin list`里的是否一致。
3. 有没有同时启用weixin插件，或者它留下的后台进程，见上一节。
4. 是否同时开了几个带channel参数的会话。只有最新启动的那个收消息。
5. 登录是否过期。过期时让Claude发一条消息，它会提示重新运行`/wxmedia:configure login`。

## 安全说明

- **谁能发消息**：只有白名单里的微信号发来的消息会交给Claude，其余的在下载附件之前就被丢弃。
- **谁能改白名单**：只有你在终端里运行`/wxmedia:access`才能改。微信消息里要求批准配对、修改白名单的话，Claude会拒绝。
- **转到微信的提示**：白名单里的微信号可以在微信上批准工具调用、回答选择题。白名单里有别人时，建议把`relay`设为`never`。
- **不会外发的文件**：`reply`拒绝发送`~/.claude/channels/`下的文件（收件夹除外），避免登录凭证被发出去。
- **登录凭证**：`~/.claude/channels/wxmedia/`下的文件只有本用户可读。凭证等同于这个bot的登录状态，不要提交到仓库或发给别人。
- **微信消息是不可信输入**：和其他channel一样，发来的文字、文件可能带有诱导Claude执行操作的内容。

## 状态文件和环境变量

状态都在`~/.claude/channels/wxmedia/`（设了`CLAUDE_CONFIG_DIR`时在它下面的`channels/wxmedia/`）：

| 文件 | 内容 |
|---|---|
| `credentials.json` | 登录凭证 |
| `access.json` | 白名单、配对、`relay`等设置 |
| `context_tokens.json` | 每个用户最近一条消息的`context_token` |
| `sync_buf.txt` | 长轮询的游标 |
| `inbox/` | 收到的图片、视频、文件 |
| `pollers/`、`pending/`、`answers/` | 多会话接管和提示转发用的临时记录 |

| 环境变量 | 作用 |
|---|---|
| `WXMEDIA_POLL` | `always`强制轮询，`never`强制不轮询。默认按启动参数判断 |
| `WXMEDIA_ASK_WAIT_MS` | 选择题在微信上最长等多久，毫秒。默认24小时 |

## 开发与测试

```bash
git clone https://github.com/richardu8/claude-plugin-wxmedia
cd claude-plugin-wxmedia
bun install
```

- `bun test/e2e.ts`：用本机的假iLink服务和假CDN把收、发、配对、多会话接管、审批转发、选择题钩子都跑一遍，不碰真实微信账号。
- `bun test/live.ts <文件>...`：用本机的登录凭证把文件加密上传到真实CDN，不发消息。加`--send`会把文件发到自己的微信。

## 验证情况

截至2026-10-10，在真实微信账号和真实Claude Code会话里实测过的：

- 发文字、图片、视频、PDF、Word，手机上都能正常打开。
- 收文字、照片、视频、Word文件，文件名和大小保留完整。
- 选择题转到微信，微信作答和终端作答都通。
- 工具审批转到微信，在微信上回复后终端放行。

没有在真实会话里测过的：

- 群聊。
- macOS以外的系统。

## 协议要点（2026-10-08实测）

- `base_info.channel_version`低于2.1.1时，`getuploadurl`只返回旧的`upload_param`；不低于2.1.1时返回`upload_full_url`。本插件按2.4.9的协议收发，优先用`upload_full_url`。
- 按图片或视频类型上传时，CDN会检查内容，内容不是对应类型就返回500（比如bmp、svg当图片传）。这时插件自动改按文件发。
- 上传成功后响应头`x-encrypted-param`里的引用只能填进`sendmessage`，不能直接拿去CDN下载。
- 发消息要回传对方最近一条消息的`context_token`。插件把每个用户最新的一个存在`context_tokens.json`里，重启后还能回复。
- iLink Bot API没有公开文档，接口随时可能变。

## 更新记录

- 0.2.1（2026-10-10）：启动命令里的市场名和实际安装的不一致时，不再收消息，并在会话开头提示怎么改。以前这种情况下消息会被收走后丢掉。
- 0.2.0（2026-10-10）：终端里的选择题和工具审批可以转到微信；多个会话互不抢消息。
- 0.1.0（2026-10-08）：在weixin插件的基础上加入图片、视频、文件的收发。

## 致谢

- [m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin)（MIT）：登录脚本、访问控制、长轮询的骨架来自这个插件。
- Anthropic官方的[Telegram channel插件](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)（Apache-2.0）：上游插件沿用了它的结构，权限转发的写法也参照它。
- 腾讯的[@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（MIT）：iLink Bot协议的细节（上传、加密）参照它实现。

各部分的来源和许可见[NOTICE.md](NOTICE.md)。

## 许可证

[MIT](LICENSE)。来自Telegram插件的部分仍按[Apache-2.0](LICENSE-APACHE)授权。
