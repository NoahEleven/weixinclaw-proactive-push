# weixinclaw-proactive-push

WorkBuddy 微信 ClawBot 主动推送 skill：通过 WorkBuddy 已连接的 ClawBot 微信 bot 通道（weixinClawBot / ilink bot，**非微信客服号**）主动向老板微信推送**文本 / 图片 / 文件 / 视频**。

协议严格对齐腾讯官方插件 `@tencent-weixin/openclaw-weixin@2.4.6`（src/api + src/messaging + src/cdn）。

> 本 skill 源码即本仓库：clone 后放入 ~/.workbuddy/skills/weixinclaw-proactive-push/ 即可使用。

## 文件说明

| 文件 | 作用 |
|---|---|
| SKILL.md | 完整使用文档（通道原理、token 获取、推送、排错） |
| send.js | 推送主脚本：文本/图片/文件/视频，自动读取或捕获 context_token |
| init-host-persist.cjs | 可选：给 host 运行时 codebuddy.js 注入自动落盘 context_token 的逻辑 |

## 核心机制

ilink bot 协议强制每条主动推送携带有效 context_token（来自老板给 bot 发的入站消息）。本 skill 提供两条获取路径：

1. **host 自动落盘（主方案，零手动）**：init-host-persist.cjs --apply 注入后，老板正常发消息 → host 自动把 token 写盘 → 之后主动推送全自动。
2. **捕获兜底**：node send.js --capture-token 长轮询抢 token（用于 host 未注入 / token 缺失时）。

## 快速开始

```bash
# 0. 依赖：Node 18+（推荐 WorkBuddy managed node 22）
# 1. 确保 settings.json 已配置 weixinClawBot 通道（凭据自动读取，无需手填）

# 2. 推送文本
node send.js "你好，老板"

# 3. 推送图片 / 文件
node send.js --image ./pic.png
node send.js --file ./report.pdf
```

详见 SKILL.md。
