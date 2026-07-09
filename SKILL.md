---
name: weixinclaw-proactive-push
description: 通过 WorkBuddy 已连接的 ClawBot 微信 bot 通道（weixinClawBot / ilink bot，非微信客服号）主动向老板微信推送文本/图片/文件/视频。当用户要求"通过 ClawBot 主动推送/给老板发微信/微信主动推送测试/微信独立消息/发图片给老板/发文件给老板"时使用。协议严格对齐腾讯官方插件 @tencent-weixin/openclaw-weixin@2.4.6（src/api + src/messaging + src/cdn）。
---

> 📦 **本 skill 源码仓库**：https://github.com/NoahEleven/weixinclaw-proactive-push （公开，欢迎 clone / 提 Issue）
>
> 🔒 **隐私红线（务必遵守）**：本 skill 运行时**只读本机凭据、不写出任何密钥、日志不打印 token 明文**。
> 分享 / 备份 / 提交时，**严禁**携带以下文件（含 bot 完整凭证 / 老板微信 id）：
> - `~/.workbuddy/settings.json`（含完整 `botToken`、`userId`）
> - `~/.workbuddy/claw-state/weixin/`（cursor 游标内含 bot 凭证镜像 `get_updates_buf`）
> 本仓库**只含 `SKILL.md` + `send.js`**，接收方用自己的 `settings.json` 即可，无需你提供任何密钥。

# 微信(ClawBot)主动推送（weixinClawBot / ilink bot）

## 背景
WorkBuddy 迁移自 OpenClaw。微信主动推送能力其实**一直活着**，藏在
`~/.workbuddy/settings.json` 的 `claw/users/<uid>/channels/weixinClawBot` 里——
它是 ClawBot 的微信 bot 通道（ilink bot，polling 模式），对接 `https://ilinkai.weixin.qq.com`。

> ⚠️ **这不是微信客服号**：微信客服号走公众平台客服消息 API（48 小时会话限制），
> 而本通道是 WorkBuddy / ClawBot 内置的 bot 通道，走 ilink bot API，可随时主动推送，不受客服号限制。

协议实现**严格对齐腾讯官方插件 `@tencent-weixin/openclaw-weixin@2.4.6`**
（npm 包，含 `src/api/api.ts`、`src/api/types.ts`、`src/messaging/*`、`src/cdn/*`）。
关键常量、请求头、item 结构、AES 加密、错误码检查均与官方保持一致。

> ⚠️ `openclaw-weixin-cli` 不需要装（那是 OpenClaw 的通道安装器，对 WorkBuddy 无用）。

## 何时用
- "通过 ClawBot 主动推一条消息给老板"（context_token 自动从 cursor 游标读取，详见下方机制专节）
- "微信主动推送测试""给老板发条微信 bot 消息"
- "发张图/发个文件/发段视频给老板"（context_token 自动读取，详见机制专节）
- 定时任务把结果主动推到老板微信（ClawBot bot 消息，非对话气泡）

## 怎么跑
脚本自动读 `settings.json` 取凭据与收件人，向老板微信发消息：

```bash
NODE="C:/Users/<USER>/.workbuddy/binaries/node/versions/22.22.2/node.exe"   # 将 <USER> 换成你的 Windows 用户名
SKILL="C:/Users/<USER>/.workbuddy/skills/weixinclaw-proactive-push"         # 或进入本 skill 目录后改用相对路径

# 文本（context_token 自动从 cursor 游标读取，详见下方机制专节）
"$NODE" "$SKILL" "🦐 你的消息内容"

# 从文件读长文本
"$NODE" "$SKILL" --text-file 内容.txt

# 图片 + 可选说明（context_token 自动读取）
"$NODE" "$SKILL" --image 截图.png --caption "看这张图"

# 文件 + 文件名 + 可选说明（context_token 自动读取）
"$NODE" "$SKILL" --file 报告.pdf --name "周报.pdf" --caption "请查阅"

# 视频（context_token 自动读取）
"$NODE" "$SKILL" --video clip.mp4

# 显式指定 token（极端兜底：手动传入一个已知有效的 context_token）
"$NODE" "$SKILL" "回复内容" --context <context_token>
```

- 不传参数 → 发送默认测试文案（文本）。
- 跑的时候若因沙箱拦截网络，加 `dangerouslyDisableSandbox: true`（或在弹窗点允许）。
- 成功标志：终端打印 `[weixinclaw] OK`，老板微信里会收到一条 **ClawBot bot 消息**（不是对话气泡）。

## 凭据从哪来（settings.json）
```
claw/users/<uid>/channels/weixinClawBot = {
  "enabled": true,
  "channelId": "<你的 bot channelId，从你的 settings.json 读取>",
  "botToken":  "<完整 botToken 串，含 accountId: 前缀；脚本自动从你的 settings.json 读取，无需手填>",  // 完整 token = Bearer 凭据
  "baseUrl":   "https://ilinkai.weixin.qq.com",                                // apiBaseUrl
  "accountId": "<你的 bot accountId，从你的 settings.json 读取>",
  "userId":    "<老板的 im.wechat id = to_user_id；脚本自动从你的 settings.json 读取>",                       // 老板的 im.wechat id = to_user_id
  "connectionMode": "polling"
}
```

> 🔒 以上字段均为接收方**自己**的 `settings.json` 内容，无需分享者提供。脚本只读取、不写出。

## 🔴 关键机制：context_token（2026-07-09 定稿）

### 文本 / 媒体都强制要求 context_token
- 实测：`ilink/bot/sendmessage` 的 `msg.context_token` 传空串 ⇒ `ret:-2` 拒收；省略该字段同样 `-2`。
- 文本 / 图片 / 文件 / 视频**均适用**，没有"空 token 可推"的类型。
- 唯一正确来源是 cursor 游标里的 `get_updates_buf`（见下），不要传空。

### context_token 的唯一来源：cursor 游标里的 `get_updates_buf`（≈1 天有效）

> ❌ 不采用「空 context_token」：它仅在你刚给 ClawBot 发过消息后的极短窗口内才被服务端放行，
> 通用性差、不可预期，**已明确弃用**。一律走下方 cursor 方案。

- host 实时把 ilink 接收会话游标写进
  `~/.workbuddy/claw-state/weixin/<accountId>_im.bot.cursor.json` 的 `get_updates_buf` 字段。
- 该字段值是 **base64 编码的 protobuf**；我们**把整段 base64 串原样**当作 `context_token` 用
  （不是解码出来的 botToken 串，也不是里面的 accountId 段）。
- **有效期 ≈ 1 天**，随内嵌的 accountId（形如 `<accountId>`）滚动而变 →
  过期后 host 自动刷新，重读文件即得新 buf。
- 实测：buf 当 `context_token` + `botToken` 当 Bearer ⇒ `{}` 成功，且**不依赖** codebuddy.js 注入、
  不读 context-token.json、无需轮询、无需你发消息。
- 编码细节：`get_updates_buf` 解码后为约 78 字节 protobuf，含 `botId`(varint) + 账号标识 +
  botToken 明文段（`accountId@im.bot:secret`）。

> 🔒 `get_updates_buf` 内嵌了 bot 凭证副本，**绝不要**把它粘贴到聊天、Issue、或随仓库提交。

### send.js 的取值优先级
```
ctx = --context 显式传入
    ＞ 读最新 <accountId>_im.bot.cursor.json 的 get_updates_buf （默认走这条，≈1 天有效）
```
（`get_updates_buf` 为空或很久没刷新时，让老板在微信给 ClawBot 发一条消息触发 host 刷新游标即可；
极端情况再走 `--context <token>` 显式兜底，不要依赖空 token。）

### 无需 host 注入 / 无需 context-token.json
- `codebuddy.js` 里的 `PERSIST_TOKEN_V2` 注入（写 context-token.json）**已于 2026-07-09 还原剥离**，
  对主动推送无影响。
- 推送只依赖：① settings.json 的 `botToken`（Bearer）+ `userId`（to_user_id）；
  ② cursor 文件的 `get_updates_buf`（当 context_token）。两者都是 host 原生维护，不靠任何 hack。

## 🔴 关键坑（必看，否则必失败）
1. **Bearer token 必须用完整 `botToken` 串**（含 `accountId:` 前缀），即
   `<完整 botToken 串（含 accountId: 前缀），从你的 settings.json 读取>`。
   只取冒号后的短串会返回 `errcode:-14 session timeout`，推送失败。
2. **协议常量对齐官方 `@tencent-weixin/openclaw-weixin@2.4.6`**（不要再用旧值）：
   - `channel_version = "2.4.6"`（早期实现误用 `cbc-1.0.0`，现已对齐官方）
   - `iLink-App-ClientVersion = 132102`（= `buildClientVersion("2.4.6")`）
   - `iLink-App-Id = "bot"`，`bot_agent = "OpenClaw"`
3. **媒体推送必须带有效 `context_token`**（见上节），否则 `ret:-2` 拒收。

## 发送契约（对齐官方 ilink bot 协议）
- 端点：`POST {baseUrl}/ilink/bot/sendmessage`
- 请求头（完整，缺一不可）：
  - `Authorization: Bearer <完整botToken>`
  - `AuthorizationType: ilink_bot_token`
  - `X-WECHAT-UIN: <随机4字节uint32的base64>`
  - `iLink-App-Id: bot`
  - `iLink-App-ClientVersion: 132102`
  - `Content-Type: application/json`
- Body（文本）：
```json
{
  "msg": {
    "from_user_id": "",
    "to_user_id": "<boss的im.wechat id>",
    "client_id": "<16位随机hex>",
    "message_type": 2,
    "message_state": 2,
    "item_list": [{ "type": 1, "text_item": { "text": "消息内容" } }],
    "context_token": "<从 cursor 读取的 get_updates_buf>"
  },
  "base_info": { "channel_version": "2.4.6", "bot_agent": "OpenClaw" }
}
```
- `item_list` 类型：`1=文本` / `2=图片` / `4=文件` / `5=视频`（text 超 4000 字自动分片）。
- 成功判定：`sendmessage` 返回 `{}`（host 视 `ret` 缺失为成功）；`ret` 非零（如 `-2`）即失败。
- 会话存活自检：`POST {baseUrl}/ilink/bot/getupdates` 返回无 `errcode` 即健康。

## 富媒体流程（图片/文件/视频）
0. **context_token 自动从 cursor 游标读取**（详见上方机制专节），无需手动准备。没有会 `ret:-2`。
1. 生成 16 字节随机 AES 密钥 `aesKey`，`aesKeyHex = aesKey.toString('hex')`。
2. `POST /ilink/bot/getuploadurl`，body：`filekey, media_type(1=IMAGE/2=VIDEO/3=FILE), to_user_id, rawsize, rawfilemd5, filesize(密文长), aeskey(aesKeyHex), no_need_thumb`。
3. 取响应 `upload_full_url`（或旧版 `upload_param` 拼 `https://novac2c.cdn.weixin.qq.com/c2c/upload?encrypted_query_param=...&filekey=...`）。
4. `POST` 密文（AES-128-ECB(PKCS7) 加密后的文件）到该 URL，`Content-Type: application/octet-stream`。
5. 取响应头 `x-encrypted-param` 作为下载令牌 `encrypt_query_param`。
6. 构造 item：`media = { encrypt_query_param, aes_key: base64(aesKeyHex), encrypt_type: 1 }`，
   图片加 `mid_size`，文件加 `file_name`+`len`，视频加 `video_size`。
7. `POST /ilink/bot/sendmessage`，`msg.context_token` = 有效 token。

## 排错
| 现象 | 原因 | 解决 |
|------|------|------|
| `errcode:-14 session timeout` | 用了短 token | 改用完整 `botToken` 串 |
| `FAILED: API ret=-2` | 缺有效 `context_token`（文本/媒体都适用） | 默认读 cursor 的 `get_updates_buf` 当 ctx（≈1天有效）；若该 buf 为空/过期，让老板在微信给 ClawBot 发一条消息触发 host 刷新游标，或显式 `--context <token>` 兜底 |
| 网络超时 / fetch 失败 | 默认沙箱拦截出网 | 加 `dangerouslyDisableSandbox: true` 或点允许 |
| 通道找不到 | settings.json 路径/字段变了 | 按上文"凭据从哪来"手动核对路径 |
| 走错通道 | 误用 MCP 的 weixin/wecom | 确认用 `weixinClawBot`（ClawBot），不是 MCP connector |
| 富媒体上传失败 | `getuploadurl` 未返回 url / CDN 缺 `x-encrypted-param` | 检查 botToken 完整、网络可达 CDN |
| 文本类文件（.txt/.md）中文乱码 | 源文件 UTF-8 无 BOM，微信/Windows 按 GBK 解码 | send.js 已自动为文本类文件补 UTF-8 BOM，无需手动处理 |
| `文件不存在: ...` | 传入的媒体路径错误 | 检查 `--image/--file/--video` 指向的文件路径 |
| `缺少 botToken` / `缺少 userId` | settings.json 的 weixinClawBot 配置不完整 | 按"凭据从哪来"补全字段 |
