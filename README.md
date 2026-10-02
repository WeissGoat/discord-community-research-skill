# discord-community-research-skill

让 AI 助手（Codex、Claude Code 等）在你**已加入的 Discord 服务器**里做深度调研：搜索、通读论坛和帖子、下载附件，最后给出每条结论都带 Discord 链接的证据报告。

只依赖 Node.js 内置模块，克隆后即可使用，不需要 `npm install`。

> [!WARNING]
> 本技能需要你的 Discord 用户令牌。Discord 不允许用普通用户账号做自动化，账号有被限制的风险。使用前请先阅读[免责声明与使用边界](#免责声明与使用边界)。

## 快速开始

**1. 准备环境**：Node.js 20 或更新版本（通过代理访问 Discord 需要 22.21+ 或 24+）。

**2. 安装**：克隆到助手扫描技能的目录，**目录名必须是 `discord-community-research`**，与 `SKILL.md` 里的 `name` 一致。

| 助手 | 用户级（所有项目可用） | 项目级 |
| --- | --- | --- |
| Codex | `~/.agents/skills/` | `<项目>/.agents/skills/` |
| Claude Code | `~/.claude/skills/` | `<项目>/.claude/skills/` |

```bash
git clone https://github.com/WeissGoat/discord-community-research-skill.git ~/.agents/skills/discord-community-research
```

- 更新：在该目录里运行 `git pull`。
- 多个项目共用一份：克隆到任意位置，再用符号链接接入各个项目的技能目录，链接名同样用 `discord-community-research`。
- 不要直接下载 ZIP 使用：解压出来的目录名带分支后缀，需要先改名。
- Windows 上 `~` 就是 `C:\Users\<你的用户名>`，在 PowerShell 里写作 `$HOME`。

**3. 配置令牌**：在运行命令的目录里新建 `.env`：

```
DISCORD_TOKEN=你的用户令牌
```

也可以直接设置同名环境变量。令牌只会从这两处读取；不要把它写进命令行、脚本或任何会被提交的文件，并确认 `.env` 已被 `.gitignore` 忽略。然后检查一下：

```bash
node <技能目录>/scripts/doctor.mjs
```

`<技能目录>` 是上一步克隆出来的 `discord-community-research` 目录。命令要在你的工作目录里运行，不要 `cd` 进技能目录：`.env` 和输出目录 `discord_research/` 都是相对运行命令时所在的目录。

**4. 直接对助手说**：

- 「深度调研一下 Redis Cluster，看看我加入的 Discord 社区里有哪些讨论和实际用法」
- 「把这个论坛近三个月的帖子读完，按 reaction 排序，下载其中的图片附件」

本技能只在你明确要求对已加入的 Discord 社区做「深度搜索 / 深度调研」时才会触发，普通问题不会误启动它。

## 能做什么

- **两阶段搜索**：先在所有服务器里广泛召回，再只在有命中的服务器里做精确验证，节省请求。
- **完整的搜索过滤**：作者、是否带图或文件、附件扩展名、链接域名、置顶、时间范围等 Discord 官方过滤条件，都可以写进调研计划；写错的键名或取值会在发出第一个请求前报错。
- **通读而不只是搜索**：列出论坛帖和子区（含已归档的），读完整个频道或帖子，并标记每个频道是 complete、truncated 还是 failed。
- **附件与图片元数据**：下载附件（链接过期会重新读取消息来刷新），并读取图片内嵌的元数据（PNG 文本块、JPEG / WebP 的 EXIF 和 XMP）。
- **可追溯的结论**：证据分为 E0 提及、E1 讨论、E2 技术细节、E3 有成果展示、E4 反复使用五级，并统计覆盖率；调研可断点续跑，每条关键结论都要求附上 Discord 跳转链接。

## 命令

都支持 `--help`，写错参数会直接报错，结果以 JSON 输出。

| 命令 | 作用 |
| --- | --- |
| `doctor.mjs` | 检查令牌、网络和输出位置 |
| `run-research.mjs` | 一条命令跑完整个调研计划：盘点服务器、召回、验证、补全上下文、证据分级、生成报告 |
| `run-search-plan.mjs` | 单趟执行计划里的全部查询，不分召回和验证两个阶段 |
| `inventory-guilds.mjs` | 列出已加入的服务器及其频道 |
| `threads.mjs` | 列出论坛帖和子区（含已归档的），带首帖内容 |
| `history.mjs` | 读完整个频道、子区或论坛帖，记录 reaction 数 |
| `show.mjs` | 按跳转链接打开某条消息及其上下文 |
| `enrich-hits.mjs` | 给搜索命中补上下文、回复链和 reaction 数 |
| `media.mjs` | 列出并下载附件，生成清单 |
| `image-metadata.mjs` | 读取图片内嵌的元数据，并识别常见工具写入的生成参数 |
| `build-evidence-index.mjs` | 重新生成某次调研的证据分级 |
| `build-report.mjs` | 重新生成某次调研的报告 |

## 几条原则

- **只读**：只发 GET 请求，不发言、不改任何数据。搜索和读取默认串行，并遵守 Discord 返回的限流等待时间。
- **失败不等于没有**：失败、限流、被截断的查询都不算完成。报告里的 Coverage 为 yes、scoped 或 no，只有完整覆盖才能下「没找到」的结论。
- **证据等级只描述 Discord 上的证据强度**，不代表质量、正确性或安全性。
- **输出是私密数据**：结果写进 `discord_research/`，命令新建的输出目录会自带 `.gitignore`。

## 已知限制

- 藏在像素里的隐写元数据不会被解码；读不到元数据的图片会标为 unknown，不代表它没有生成参数。
- `history.mjs` 中途失败后需要重新运行，不支持断点续跑。
- 只在 Node.js 22 上测试过。

详细的流程和规则见 [SKILL.md](SKILL.md)（英文，写给助手读的）；参考文档在 [references/](references/)：查询规划、证据分级、媒体采集。

## 限定触发范围

`SKILL.md` 里的 `description` 和 `Scope` 决定助手什么时候用它。想把触发范围限定在某类话题或某几个社区，改这两处即可；除了读取图片元数据的 `image-metadata.mjs`，其余脚本与话题无关。

## 免责声明与使用边界

- **账号风险**：Discord 不允许用普通用户账号做自动化（俗称 self-bot），被发现可能导致账号被限制或封禁。本项目只发只读请求并遵守限流，但这不能消除风险。**后果由你自己承担**，在意账号安全就不要用重要的账号。
- **只访问你本来就能看到的内容**：遵守各服务器的规则，不要用它批量抓取、转发或公开他人的消息和图片。
- **令牌等同于账号密码**：谁拿到它，谁就能登录你的账号。本仓库不含任何令牌；也请不要把它贴进聊天记录、日志、截图或 issue。
- **调研结果是私密数据**：`discord_research/` 里有他人的消息，已被 `.gitignore` 忽略，不要提交到任何公开仓库。
- 本项目与 Discord 没有关联，也未获其认可。

## 开发与测试

```bash
node --test
```

在技能目录里运行即可。测试全部使用模拟数据，不访问 Discord，也不需要令牌。目录名不是 `discord-community-research` 时，`tests/skill-test.mjs` 会报错，因为技能名必须与目录名一致。

技能目录必须**自包含**：脚本只 import Node.js 内置模块和目录内的文件，文档只用相对路径。这样整个目录复制到别的项目或平台就能用（不需要带上 `.git`），`tests/skill-test.mjs` 会检查这一点。

```
.
├── SKILL.md              触发条件、工作流和规则
├── agents/openai.yaml    Codex 界面里的显示信息
├── references/           查询规划、证据分级、媒体采集
├── scripts/              命令行工具，lib/ 是共用代码
└── tests/
```

## 致谢

Discord 接口的一些用法（例如论坛帖的搜索接口）参考了开源项目 [Discrub](https://github.com/prathercc/discrub)。本项目的代码是独立实现的，不依赖它。

## 许可证

[MIT](LICENSE)
