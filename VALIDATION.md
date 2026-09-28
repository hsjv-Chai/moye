# 验证记录

日期：2026-09-28。验证主机：macOS / Apple Silicon。应用版本：0.1.0，Electron 40.10.6。

## 已通过

- TypeScript 类型检查、Vite 生产构建、Electron 主进程与 preload 构建。
- 20 项自动测试：SQLite 文件持久化、多作品隔离、写盘失败的内存和磁盘回滚、恢复前快照、备份 ID 重映射和版本保留、非法备份校验、密钥加密/会话降级/地址变更清除、候选稿隔离、章节拆分与排序导出、上下文选择、长篇中文文本保存。
- 协议测试覆盖 OpenAI / DeepSeek / GLM / Kimi / 自定义兼容协议配置与 Claude Messages，实际通过本机 HTTP 模拟服务验证碎片化 UTF-8 SSE、请求参数、鉴权错误、取消、超时、提前断流、上下文超限。
- 真实 Electron 端到端流程：创建作品 → 设定 → 分卷大纲 → 配置连接并测试 → 初稿生成与预览 → 修改原文后的冲突确认 → 选段润色 → 章节摘要 → 正文变化后摘要过期 → 模拟磁盘失败并重试 → 原生对话框通道导入/导出 → AI 拆分章纲 → 备份 → 版本恢复 → 恢复副本 → 重启持久化。
- 额外验证：摘要候选生成后、采纳前正文发生变化，采纳后的摘要仍正确标为过期。
- 打包后的 macOS arm64 应用实际启动；内置 SQLite WASM 正常加载；输入后立即关闭窗口，重启验证待保存正文完整；深色模式、1060×720 最小窗口无横向页面溢出。
- macOS arm64 与 x64 的 DMG/ZIP、Windows x64 的 NSIS EXE 均成功生成。
- Prettier 格式检查。

## 尚未验证 / 首版限制

- 没有用户真实 API Key，未向五家服务商发起真实付费调用。模拟接口通过不等于所有厂商模型均已实测。
- Windows 安装程序已在 macOS 交叉构建，未在 Windows 系统实际安装或启动。macOS Intel 包也未在 Intel 设备实测。
- GitHub Actions 双平台工作流已配置，尚未推送和运行。
- 安装包未签名，macOS 未公证，图标使用 Electron 默认图标。
- 版本是全书快照，历史较多时资料库增大；首版未实现增量压缩。未做长期大规模连载资料库性能基准。
- 上下文预算使用字符估算，并非各模型精确 tokenizer。

## 产物

- `release/墨页-0.1.0-arm64.dmg`：macOS Apple Silicon。
- `release/墨页-0.1.0.dmg`：macOS Intel。
- `release/墨页 Setup 0.1.0.exe`：Windows x64。
- `test-results/workspace.png`、`library.png`、`packaged-dark-compact.png`：真实桌面界面截图。

复现：`npm test`、`npm run build`、`npm run test:e2e`。打包后可运行 `node scripts/packaged-smoke.mjs <应用可执行文件绝对路径>` 验证安装包；省略路径默认使用 macOS arm64 产物。
