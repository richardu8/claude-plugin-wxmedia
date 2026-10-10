# wxmedia：把Claude Code接到你的微信上

人不在电脑前，也能用微信给电脑上的Claude Code派活、收结果。文字、图片、视频、文件，两边都能发。

A WeChat (微信) channel plugin for Claude Code: text, images, videos and files in both directions, and Claude's questions answered from WeChat. The documentation is in Chinese.

## 它能帮你做什么

- **在微信上给Claude派活**：出门在外，发一句“把昨天那份报告转成PDF”，电脑上的Claude就开始干，做完在微信上告诉你。
- **让Claude把文件发到手机**：做好的PDF、Word、图片、视频，直接发到你的微信。
- **把手机上的东西交给Claude**：拍张照片、转一个文件给它，它能直接打开看。
- **在微信上回答Claude的提问**：Claude需要你做选择或点头时，问题会发到微信，回个数字或“y”就行。

## 开始之前

你需要准备三样：

1. 一台装好[Claude Code](https://claude.com/claude-code)的Mac。目前只在Mac上测试过。
2. [Bun](https://bun.sh)，插件靠它运行。没装的话，在终端里运行下面这行，装完重开终端：

   ```bash
   curl -fsSL https://bun.sh/install | bash
   ```

3. 一个微信号。

> 下面的命令，除了特别注明的，都是在“终端”里输入，不是在Claude的对话框里。

## 四步装好

### 第1步：安装插件

两条都要运行，按顺序来。第一条告诉Claude Code去哪里找这个插件，第二条才是真正安装。

```bash
claude plugin marketplace add richardu8/claude-plugin-wxmedia
claude plugin install wxmedia@richardu8-plugins
```

### 第2步：给启动命令起个短名字

要让Claude收微信，启动时得带一长串参数。运行下面两行，以后输入`wx`就行：

```bash
echo "alias wx='claude --dangerously-load-development-channels plugin:wxmedia@richardu8-plugins'" >> ~/.zshrc
source ~/.zshrc
```

### 第3步：扫码登录

1. 在终端输入`wx`启动Claude。它会问是否加载开发中的channel，选确认。这时可能提示wxmedia没连上，那是因为还没登录，不用管。
2. 在Claude的对话框里输入：

   ```
   /wxmedia:configure login
   ```

3. 终端里会出现一个二维码。用微信扫一扫，在手机上点确认，看到“微信连接成功”就好了。
4. 输入`/exit`退出，再输入`wx`重新启动一次。登录之后要重开才生效。

### 第4步：试一下

在微信里给它发一句“你好”。过几秒Claude在微信上回你，就说明通了。

## 平时怎么用

每次想让Claude收微信，就用`wx`启动它。直接输入`claude`启动的不收微信消息。

- **派活**：在微信里直接打字。
- **发东西给Claude**：照片、视频、文档直接发过去。
- **让Claude发东西给你**：跟它说“把这个文件发到我微信”。图片和视频会直接显示在聊天里，其他类型按文件发，单个不超过100MB。
- **人在电脑前**：照常在终端里打字，两边它都听。

## 在微信上回答Claude的提问

任务是你从微信布置的时候，Claude要问你的问题会同时出现在电脑和微信上，哪边先答都算数：

- **选择题**：微信收到【Claude提问】和带编号的选项。回数字就行，多选回“1,3”，也可以直接打字回答。
- **要你点头的操作**：微信收到【需要审批】。回“y”同意，回“n”拒绝。

想让所有提问都发到微信，或者一个都不发，见下面的“更多设置”。

## 常见问题

**两条安装命令是二选一吗？**
不是，两条都要运行，先第一条再第二条。

**微信上发了消息，Claude没反应？**
按顺序检查：

1. Claude是不是用`wx`启动的。直接输入`claude`启动的不收微信。
2. 启动命令里`plugin:`后面的名字，是否和`claude plugin list`里显示的一致。不一致时Claude会在一开始就提醒你。
3. 是不是同时开了好几个用`wx`启动的Claude。只有最后启动的那个收消息。
4. 是不是还开着别的微信插件，见“从weixin插件换过来”。
5. 登录是不是过期了。让Claude给你发条微信试试，过期的话它会提示重新扫码。

**别人能给我的Claude发消息吗？**
默认不能，只有扫码登录的那个微信号可以。别人发消息时会收到一个配对码，你在Claude里输入`/wxmedia:access pair 配对码`批准之后，对方才能用。

**换一台电脑要重新装吗？**
要。每台电脑各装一次、各登录一次。两台电脑不要同时开着收微信，否则会抢消息。

**怎么更新？**

```bash
claude plugin marketplace update richardu8-plugins
claude plugin update wxmedia@richardu8-plugins
```

运行完重新启动Claude。

**不想用了怎么卸载？**
运行`claude plugin uninstall wxmedia@richardu8-plugins`。登录信息和收到的文件在`~/.claude/channels/wxmedia/`，不要了可以一并删掉。

## 进一步了解

下面的内容平时用不到，需要时点开看。

<details>
<summary>更多设置</summary>

**提问什么时候发到微信**

在Claude里输入`/wxmedia:access set relay 值`，值有三种：

- `auto`（默认）：只有任务是从微信布置的才发，也就是这个会话最近一条输入来自微信。
- `always`：都发。别的会话里的选择题也会发，只要有一个用`wx`启动的Claude开着收回复。
- `never`：不发。

有选择题在等答案的时候，你在微信上发的文字都会被当成这道题的答案，不会当作新任务。设成`always`后，别的会话的选择题也会这样截走消息。选择题最长等约24小时，过后要回电脑上回答。审批超过10分钟才回复时要带上编号，如“y abcde”。

发不到微信的提示：计划模式的批准、启动时的channel确认、文件夹信任和MCP同意框，这些只能在电脑上操作。

审批提示只有电脑上真的弹出确认框时才会有。手动确认模式（启动时加`--permission-mode manual`）下，改文件、运行非只读命令都会弹；auto模式下一般不弹；加了`--dangerously-skip-permissions`完全不弹。

**谁能发消息**

- `/wxmedia:access`：查看现在允许谁、有谁在等批准。
- `/wxmedia:access pair 配对码`：批准一个人。

**其他**

- 把图片、视频按文件发（保留原始画质和文件名）：让Claude发的时候说“按文件发”。
- 收到的图片、视频、文件存在`~/.claude/channels/wxmedia/inbox/`，不会自动清理。
- 只允许了一个微信号时，在任何Claude会话里都可以让它“发到我微信”，不用先收到消息。

| 环境变量 | 作用 |
|---|---|
| `WXMEDIA_POLL` | `always`强制收消息，`never`强制不收。默认按启动命令判断 |
| `WXMEDIA_ASK_WAIT_MS` | 选择题在微信上最长等多久，毫秒。默认24小时 |

</details>

<details>
<summary>从weixin插件换过来</summary>

如果你用过[m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin)，换过来不用重新扫码：wxmedia第一次启动时会把它的登录信息和允许名单复制过来。

但两个插件不能同时开着，它们会抢同一个微信号的消息。先停用旧的：

```bash
claude plugin disable weixin@m1heng-plugins
```

然后退出所有Claude，再清一次它留下的后台进程。旧插件的后台进程在Claude退出后不会自己结束，会一直在后面收消息，收到的就丢了。

```bash
for p in $(pgrep -f "bun server.ts"); do
  lsof -a -p "$p" -d cwd -Fn | grep -q "m1heng-plugins/weixin" && kill "$p" && echo "已结束旧进程$p"
done
```

没有任何输出是正常的，说明没有遗留进程。

</details>

<details>
<summary>安全说明</summary>

- **谁能发消息**：只有你允许的微信号发来的消息会交给Claude，其余的在下载附件之前就被丢弃。
- **谁能改允许名单**：只有你在电脑上输入`/wxmedia:access`才能改。微信消息里要求批准配对、修改名单的话，Claude会拒绝。
- **发到微信的提问**：你允许的微信号可以在微信上批准操作、回答选择题。名单里有别人时，建议把`relay`设为`never`。
- **不会外发的文件**：Claude不会把`~/.claude/channels/`下的文件发出去（收到的附件除外），避免登录信息被发走。
- **登录信息**：存在`~/.claude/channels/wxmedia/`，只有你自己的账户能读。它等同于微信机器人的登录状态，不要发给别人，也不要放进公开的地方。
- **微信消息不一定可信**：和其他聊天渠道一样，发来的文字、文件里可能藏着诱导Claude做事的内容。
- 这是个人项目，与腾讯、Anthropic无关。它用的微信iLink Bot接口没有公开文档，随时可能变。

</details>

<details>
<summary>哪些实测过，哪些没有</summary>

截至2026-10-10，在真实微信号和真实Claude Code会话里实测过的：

- 发文字、图片、视频、PDF、Word，手机上都能正常打开。
- 收文字、照片、视频、Word文件，文件名和大小保留完整。
- 选择题发到微信，在微信上答和在电脑上答都通。
- 审批发到微信，在微信上回复后电脑上放行。

没有实测过的：

- 群聊。
- Mac以外的系统。插件靠`ps`读取Claude Code的启动参数，其他系统上没有验证。

测试环境：Claude Code 2.1.293到2.1.296，Bun 1.4.2。上游插件要求Claude Code不低于2.1.80。

</details>

<details>
<summary>给想改代码的人</summary>

```bash
git clone https://github.com/richardu8/claude-plugin-wxmedia
cd claude-plugin-wxmedia
bun install
```

- `bun test/e2e.ts`：用本机的假iLink服务和假CDN把收、发、配对、多会话接管、审批、选择题都跑一遍，不碰真实微信号。
- `bun test/live.ts <文件>...`：用本机的登录信息把文件加密上传到真实CDN，不发消息。加`--send`会把文件发到自己的微信。

实现上的几件事：

- 只有带channel参数启动的会话才收消息。同时开了几个时，最新启动的那个收，它退出后由剩下的接手。
- 审批用Claude Code的channel权限转发；选择题用`hooks/ask.ts`这个PermissionRequest钩子。待答的提示记在状态目录的`pending/`，回复经`answers/`交给发出提示的进程，所以多个会话同时开着也能对上。
- 状态都在`~/.claude/channels/wxmedia/`（设了`CLAUDE_CONFIG_DIR`时在它下面）：`credentials.json`是登录信息，`access.json`是允许名单和设置，`context_tokens.json`是每个用户最近一条消息的`context_token`，`sync_buf.txt`是长轮询的游标，`inbox/`是收到的文件。

协议要点（2026-10-08实测）：

- `base_info.channel_version`低于2.1.1时，`getuploadurl`只返回旧的`upload_param`；不低于2.1.1时返回`upload_full_url`。本插件按2.4.9的协议收发，优先用`upload_full_url`。
- 按图片或视频类型上传时，CDN会检查内容，内容不是对应类型就返回500（比如bmp、svg当图片传）。这时插件自动改按文件发。
- 上传成功后响应头`x-encrypted-param`里的引用只能填进`sendmessage`，不能直接拿去CDN下载。
- 发消息要回传对方最近一条消息的`context_token`。插件把每个用户最新的一个存下来，重启后还能回复。

</details>

## 更新记录

- 0.2.1（2026-10-10）：启动命令里的名字和实际安装的不一致时，不再收消息，并在会话开头提示怎么改。以前这种情况下消息会被收走后丢掉。
- 0.2.0（2026-10-10）：Claude的选择题和审批可以发到微信回答；多个会话互不抢消息。
- 0.1.0（2026-10-08）：在weixin插件的基础上加入图片、视频、文件的收发。

## 致谢

- [m1heng/claude-plugin-weixin](https://github.com/m1heng/claude-plugin-weixin)（MIT）：登录脚本、访问控制、长轮询的骨架来自这个插件。
- Anthropic官方的[Telegram channel插件](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/telegram)（Apache-2.0）：上游插件沿用了它的结构，权限转发的写法也参照它。
- 腾讯的[@tencent-weixin/openclaw-weixin](https://www.npmjs.com/package/@tencent-weixin/openclaw-weixin)（MIT）：iLink Bot协议的细节（上传、加密）参照它实现。

各部分的来源和许可见[NOTICE.md](NOTICE.md)。

## 许可证

[MIT](LICENSE)。来自Telegram插件的部分仍按[Apache-2.0](LICENSE-APACHE)授权。
