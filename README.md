# 墨页 · AI 辅助小说创作

本地优先的中文小说创作桌面工具。使用 Electron、React、TypeScript 和 SQLite，支持 macOS 与 Windows。个人作品无需登录，不配置 AI 也能完整写作。0.2.0 新增通过自建服务器进行多人实时协作。

## 开始使用

需要 Node.js 24 LTS 和 npm。

```sh
npm ci
npm run dev
```

开发模式会启动 Vite 和 Electron。修改主进程或 preload 后需重新启动开发命令。发布模式：

```sh
npm run build
npm start
```

进入书架后可创建作品、导入 TXT/Markdown，或打开「雾海来信」示例。示例只在点击后创建，可以随时删除。

## 创作流程

1. **作品概览**：填写简介、题材和全书写作要求。
2. **故事设定**：建立世界观、人物、地点、组织、物品、规则及自定义资料，填写定位、特征和详细内容。
3. **大纲规划**：编辑全书、分卷及章节大纲，调整分卷顺序；AI 拆分章节后先审阅列表，再创建章纲。
4. **正文创作**：编辑章节、调整所属分卷和章节顺序，设置字体、字号、行距、主题及专注模式。支持查找替换和撤销/重做。
5. **灵感助手**：生成设定、大纲、初稿，续写、改写/扩写/润色选段，手动生成章节摘要。生成结果在候选区编辑和审阅，点击采纳才进入作品。

个人作品停止编辑约一秒后自动保存。切换章节、作品及正常关闭窗口时等待保存完成；保存失败会保留窗口中的内容并显示重试入口。正常关闭会停止当前 AI 请求，并保存已经收到的内容。

`Ctrl/Cmd+S` 保存，`Ctrl/Cmd+Z` 撤销，`Ctrl/Cmd+Shift+Z` 重做，`Ctrl/Cmd+F` 查找（正文编辑器获得焦点时）。

## 多人实时协作

书架右上角「多人协作」进入协作空间，默认服务器为 `https://114.215.182.66`。管理员登录后创建账号和协作作品，并为成员分配编辑或只读权限。个人书架与协作书架独立，发布个人作品会创建共享副本，不改变原作。

- Yjs + CodeMirror 6 同步正文、设定、梗概、章纲、卷纲及摘要，显示在线成员、远程光标和选区。撤销仅撤销本人编辑。
- 修改先存入本机 SQLite 的协作缓存和待发送表；服务器 PostgreSQL 提交成功后才显示「已同步」。缓存按服务器、账号和作品隔离。数据库升级前自动备份。
- 已缓存文本支持离线编辑、退出重启、重连差量合并。章节/设定/分卷的新增、删除、归属、排序，以及 AI 采纳和导入需要联网。
- 权限撤销、条目删除、共享历史恢复后，旧的未同步内容保存到个人书架的恢复副本。共享版本恢复仅限管理员，恢复前保存当前版本。
- AI 连接、密钥和未采纳候选稿保留本机。采纳前由服务器在同一操作内校验原文、保存版本并修改；远程修改导致冲突时重新确认，选段使用稳定相对位置。
- 协作「备份」包含全书和共享历史，可恢复为独立个人作品；普通 TXT/Markdown 导出不含账户、密钥或协作会话。

部署、管理员交付、证书续期、数据库备份与回退见 [DEPLOYMENT.md](DEPLOYMENT.md)。测试范围和未实测平台见 [VALIDATION.md](VALIDATION.md)。首版没有网页编辑器、公开注册、评论聊天或共享 AI 密钥。

## 自行接入 AI

打开「AI 连接与偏好」，选择服务商，填写 API 基础地址、模型 ID 和 API Key，点击「保存并测试」。连接测试会发起一次短请求，按服务商规则计费。

| 预设 | 默认基础地址 | 协议 |
| --- | --- | --- |
| OpenAI | `https://api.openai.com/v1` | Chat Completions |
| Claude | `https://api.anthropic.com/v1` | Messages |
| DeepSeek | `https://api.deepseek.com/v1` | Chat Completions |
| GLM | `https://open.bigmodel.cn/api/paas/v4` | Chat Completions |
| Kimi | `https://api.moonshot.cn/v1` | Chat Completions |
| 自定义 | `http://127.0.0.1:11434/v1` | Chat Completions |

模型名由用户填写，以自己的账号实际可用模型为准。不同地区或产品线可修改地址；不要把完整的 `/chat/completions` 或 `/messages` 路径填入基础地址。修改服务商或地址时，必须重新输入密钥，防止已有密钥跟随到其他服务。

可为设定、大纲和正文分别指定默认连接。温度默认不发送；输出参数支持 `max_tokens`、`max_completion_tokens` 和不发送，Claude 则始终使用其必需的 `max_tokens`。这使不接受某些参数的模型也可接入。仅支持文本流式输出，未实现工具调用、图片输入和专有推理参数。

生成前可勾选设定、全书大纲和前章摘要，预览实际发送内容。简介、全书要求和当前目标内容始终发送；章节任务还包含所在卷和章纲。默认选取最近三个有摘要的前章。上下文 token 使用偏保守的字符估算，并非服务商精确分词；超过预算时不发送、不静默截断，需手动减少内容或调整预算。远程接口要求 HTTPS，本机接口允许 HTTP。

生成结果先独立保存。取消、断流或达到输出限制时保留已有文本，不自动重试。选段生成期间若原文改变，需重新选区并确认；整段替换也会提示冲突。追加会将候选文本追加到原目标末尾。摘要根据正文指纹标识是否过期。

## 数据、版本与备份

- SQLite 文件为 Electron `userData` 目录内的 `moye.sqlite`。实际路径由操作系统管理：打包版通常 macOS 为 `~/Library/Application Support/墨页/`，Windows 为 `%APPDATA%/墨页/`（开发模式可能使用 `moye-novel`）。
- SQLite 使用 sql.js/WASM，无需在用户电脑编译原生模块；修改以事务执行，通过临时文件、fsync 和重命名原子落盘。写入失败会恢复内存数据库，避免出现内存已存而磁盘未存的状态。
- 个人作品以整部作品 JSON 保存；协作作品通过 Yjs 增量同步，禁止调用整本覆盖保存接口。作品、设定、分卷及章节各自拥有稳定 ID。大量历史版本会增加数据库大小和保存成本；首版未实现增量版本压缩。
- 「保存版本」及 AI 采纳、删除条目、查找替换、导入前，保存整部作品快照。恢复版本会恢复全书，恢复前再次保存当前作品。
- 「备份作品与历史」导出 `.moye.json`，含设定、大纲、正文和版本。恢复创建新作品并重映射资料 ID，不覆盖原作。
- API Key 由 Electron safeStorage 使用操作系统能力加密，渲染界面不会读取已保存明文；系统无法加密时只在内存保存，退出后需重新填写。更换电脑可能需要重新输入密钥。
- 作品导出与备份不含连接和密钥；候选稿只在本地资料库保存，不包含在作品备份中。
- 导入支持 UTF-8、GB18030 的 TXT 和 Markdown，提供标题编辑、勾选和合并为单章；单次文件限制 50 MB。导出按分卷和章节顺序生成 TXT/Markdown。
- 未配置远程同步、账号或后台 AI 任务。只有用户触发生成或测试连接才访问模型服务。

## 构建安装包

```sh
npm run dist:mac   # macOS arm64 / x64，DMG 和 ZIP
npm run dist:win   # Windows x64，NSIS 安装程序
```

产物在 `release/`。首版无应用签名和公证，使用 Electron 默认图标。Windows 跨平台打包关闭可执行文件资源编辑；后续正式发行可配置图标、证书并启用资源编辑。

`.github/workflows/build.yml` 在 macOS 和 Windows 上分别执行测试、构建、桌面冒烟测试和打包，并上传产物。工作流已配置不意味着已在远程平台执行。当前环境实际验证记录见 `VALIDATION.md`。

## 验证与开发

```sh
npm test             # 数据库、备份、密钥、导入导出、上下文、协议测试
npm run build        # TypeScript + 前端 + 主进程/preload
npm run test:e2e      # 启动真实 Electron 与本机模拟 AI，覆盖主要用户流程
npm run format:check
```

端到端测试使用独立临时资料库，替换的系统文件对话框仅在测试进程生效，不读取个人作品或真实 API 密钥。截图输出到 `test-results/`；`MOYE_KEEP_TEST_DATA=1` 可保留测试数据库。`MOYE_DATA_DIR` 可指定隔离数据目录。

结构：`src/` 是界面，`shared/` 是实体校验和类型化接口，`electron/` 是数据库、密钥、文件操作和 AI 协议。渲染进程开启 sandbox、context isolation，关闭 Node 集成；preload 只暴露固定方法，主进程校验 IPC 来源和输入，拒绝新窗口和页面导航。

接口参考：[Claude Messages](https://platform.claude.com/docs/en/api/overview)、[DeepSeek](https://api-docs.deepseek.com/)、[智谱开发文档](https://docs.bigmodel.cn/)、[Kimi 开放平台](https://platform.moonshot.cn/)、[Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage)。真实服务兼容性仍需使用实际密钥验证。
