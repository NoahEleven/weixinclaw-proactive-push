#!/usr/bin/env node
/**
 * weixinclaw-proactive-push/send.js
 *
 * 通过 WorkBuddy 已连接的 ClawBot 微信 bot 通道（weixinClawBot / ilink bot，非微信客服号）
 * 主动向老板微信推送消息：文本 / 图片 / 文件 / 视频。
 *
 * 协议严格对齐腾讯官方插件 @tencent-weixin/openclaw-weixin@2.4.6（src/cdn + src/messaging + src/api）。
 *
 * 【隐私说明】
 *   - 本脚本只读本机两处文件，不向任何文件写出凭据：
 *       ~/.workbuddy/settings.json                  （botToken / userId）
 *       ~/.workbuddy/claw-state/weixin/<accountId>_im.bot.cursor.json （get_updates_buf 当 context_token）
 *   - 日志只打印 token 长度（ctx_len），【绝不】打印 token 明文 / botToken / userId。
 *   - 所有凭据均从本机配置文件现读，不依赖任何硬编码或外部传入的密钥。
 *   - ⚠️ claw-state/weixin/ 的 cursor 文件内嵌 bot 凭证镜像，切勿将其纳入分享 / 备份 / 提交。
 *
 * 【context_token 来源（2026-07-09 定稿）】
 *   - 唯一正确来源：claw-state/weixin 下最新的 <accountId>_im.bot.cursor.json 的
 *     get_updates_buf（base64 protobuf，≈1 天有效，整段原样当 context_token 用）。
 *   - ❌ 不采用「空 context_token」：它仅在你刚发过消息后的极短窗口才被放行，不够通用，已弃用。
 *   - 全程不依赖 codebuddy.js 注入、不读 context-token.json。
 *
 * 用法:
 *   node send.js "文本消息"                                  # 主动推文本（自动用 cursor buf 当 ctx）
 *   node send.js --text-file 内容.txt
 *   node send.js --image 截图.png --caption "看这张图"
 *   node send.js --file 报告.pdf --name "周报.pdf" --caption "请查阅"
 *   node send.js --video clip.mp4
 *   node send.js "回复" --context <token>                    # 手动指定 context_token 覆盖
 *   node send.js --verbose ...                              # 打印每步服务端响应
 *
 * 依赖: 仅 Node 内置 fetch / crypto / fs（Node 18+，推荐 managed node 22）。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const SETTINGS_PATH = path.join(os.homedir(), '.workbuddy', 'settings.json');
const CLAW_STATE_DIR = path.join(os.homedir(), '.workbuddy', 'claw-state', 'weixin');
const CDN_BASE_URL = 'https://novac2c.cdn.weixin.qq.com/c2c';

// ── 官方对齐常量（来自 @tencent-weixin/openclaw-weixin@2.4.6）────────────
const ILINK_APP_ID = 'bot';                       // package.json ilink_appid
const PLUGIN_VERSION = '2.4.6';
function buildClientVersion(v) {
  const p = String(v).split('.').map((x) => parseInt(x, 10));
  const major = p[0] || 0, minor = p[1] || 0, patch = p[2] || 0;
  return ((major & 0xff) << 16) | ((minor & 0xff) << 8) | (patch & 0xff);
}
const CLIENT_VERSION = String(buildClientVersion(PLUGIN_VERSION));
const CHANNEL_VERSION = PLUGIN_VERSION;
const BOT_AGENT = 'OpenClaw';
const TEXT_CHUNK = 4000;

const DEFAULT_TEXT =
  '🦐 ClawBot 微信主动推送测试：如果你在微信里单独收到这条 bot 消息（不是和我的对话气泡），说明主动推送已打通。';

let VERBOSE = false;
// ⚠️ 仅打印调试信息，绝不打印任何 token 明文（只包含长度等非敏感字段）
function dbg(...a) { if (VERBOSE) console.error('[dbg]', ...a); }

// ── 参数解析 ─────────────────────────────────────────────
function parseArgs(argv) {
  const a = { text: null, textFile: null, image: null, file: null, video: null,
               caption: null, name: null, context: '', verbose: false };
  for (let i = 2; i < argv.length; i++) {
    const t = argv[i];
    if (t === '--text-file') a.textFile = argv[++i];
    else if (t === '--image') a.image = argv[++i];
    else if (t === '--file') a.file = argv[++i];
    else if (t === '--video') a.video = argv[++i];
    else if (t === '--caption') a.caption = argv[++i];
    else if (t === '--name') a.name = argv[++i];
    else if (t === '--context' || t === '--ctx') a.context = argv[++i] || '';
    else if (t === '--verbose' || t === '-v') a.verbose = true;
    else if (t.startsWith('--')) { /* 忽略未知选项 */ }
    else if (a.text === null) a.text = t;
  }
  return a;
}

// ── 工具 ─────────────────────────────────────────────────
function randomWechatUin() {
  return Buffer.from(String(crypto.randomBytes(4).readUInt32BE(0)), 'utf-8').toString('base64');
}
function uuid16() { return crypto.randomUUID().replace(/-/g, '').slice(0, 16); }
function aesEcbEncrypt(data, key) {
  const c = crypto.createCipheriv('aes-128-ecb', key, null);
  return Buffer.concat([c.update(data), c.final()]);
}
function md5Hex(buf) { return crypto.createHash('md5').update(buf).digest('hex'); }
function buildHeaders(token) {
  return {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'X-WECHAT-UIN': randomWechatUin(),
    'iLink-App-Id': ILINK_APP_ID,
    'iLink-App-ClientVersion': CLIENT_VERSION,
    Authorization: `Bearer ${token}`,
  };
}
function buildBaseInfo() { return { channel_version: CHANNEL_VERSION, bot_agent: BOT_AGENT }; }
function chunkText(s, size) {
  if (s.length <= size) return [s];
  const out = [];
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size));
  return out;
}

// ── 定位通道 ─────────────────────────────────────────────
function findWeixinClawBot(cfg) {
  const users = cfg && cfg.claw && cfg.claw.users;
  if (users) {
    for (const uid of Object.keys(users)) {
      const channels = users[uid].channels || {};
      for (const cid of Object.keys(channels)) {
        const ch = channels[cid];
        const isTarget = cid === 'weixinClawBot' ||
          (ch && ch.baseUrl && ch.baseUrl.includes('ilinkai.weixin.qq.com'));
        if (isTarget) return { name: cid, ...ch };
      }
    }
  }
  throw new Error('weixinClawBot channel not found in settings.json');
}

// ── 读取 context_token ──────────────────────────────────
// 默认来源：claw-state/weixin 下最新的 <accountId>_im.bot.cursor.json
// 的 get_updates_buf（ilink 接收长轮询游标，原始 base64 串，本身就是合法 context_token）。
// ⚠️ 该文件内含 bot 凭证镜像，本函数只读取、绝不写出，日志只打印长度。
function loadContextToken() {
  try {
    if (!fs.existsSync(CLAW_STATE_DIR)) { dbg('loadContextToken: 目录不存在'); return ''; }
    const files = fs.readdirSync(CLAW_STATE_DIR).filter((f) => f.endsWith('_im.bot.cursor.json'));
    if (!files.length) { dbg('loadContextToken: 无 cursor 文件'); return ''; }
    const target = files
      .map((f) => ({ f, m: fs.statSync(path.join(CLAW_STATE_DIR, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m)[0].f;
    const j = JSON.parse(fs.readFileSync(path.join(CLAW_STATE_DIR, target), 'utf-8'));
    const buf = j.get_updates_buf || '';
    dbg('loadContextToken: 来源', target, 'buf长度', buf.length);
    return buf;
  } catch (e) {
    dbg('loadContextToken 失败:', e.message);
    return '';
  }
}

// ── 底层 POST ────────────────────────────────────────────
async function ilinkPost(channel, endpoint, body, timeout = 15000) {
  const base = channel.baseUrl || 'https://ilinkai.weixin.qq.com';
  const url = new URL(endpoint, base.endsWith('/') ? base : base + '/').toString();
  body.base_info = buildBaseInfo();
  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(channel.botToken),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeout),
  });
  const raw = await res.text();
  dbg(`POST ${endpoint} -> ${res.status}`, VERBOSE ? raw : '');
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${raw}`);
  let json = {};
  try { json = JSON.parse(raw); } catch { /* 空响应 = 成功 */ }
  if (json && json.ret && json.ret !== 0) throw new Error(`API ret=${json.ret} errmsg=${json.errmsg}`);
  if (json && json.errcode && json.errcode !== 0) throw new Error(`API errcode=${json.errcode} errmsg=${json.errmsg}`);
  return json;
}

// ── 发送文本（自动分片）──────────────────────────────────
async function sendText(channel, to, text, ctx) {
  const chunks = chunkText(text, TEXT_CHUNK);
  for (const c of chunks) {
    await ilinkPost(channel, 'ilink/bot/sendmessage', {
      msg: {
        from_user_id: '', to_user_id: to, client_id: uuid16(),
        message_type: 2, message_state: 2,
        item_list: [{ type: 1, text_item: { text: c } }],
        context_token: ctx,
      },
    });
  }
  return chunks.length;
}

// ── 媒体上传（CDN + AES-128-ECB）────────────────────────
async function uploadMedia(channel, filePath, to, mediaType) {
  if (!fs.existsSync(filePath)) throw new Error(`文件不存在: ${filePath}`);
  const aesKey = crypto.randomBytes(16);
  const aesKeyHex = aesKey.toString('hex');
  let raw = fs.readFileSync(filePath);
  // 文本类文件补 UTF-8 BOM，避免 Windows/微信查看器按 GBK 解码导致中文乱码
  if (mediaType === 3) {
    const ext = path.extname(filePath).toLowerCase();
    if (['.txt', '.md', '.csv', '.log', '.json', '.xml', '.yml', '.yaml', '.text'].includes(ext)) {
      if (raw.length < 3 || raw[0] !== 0xEF || raw[1] !== 0xBB || raw[2] !== 0xBF) {
        raw = Buffer.concat([Buffer.from([0xEF, 0xBB, 0xBF]), raw]);
        dbg('preset UTF-8 BOM for text file');
      }
    }
  }
  const rawSize = raw.length;
  const rawMd5 = md5Hex(raw);
  const cipher = aesEcbEncrypt(raw, aesKey);
  const cipherSize = cipher.length;
  const filekey = aesKeyHex;

  const resp = await ilinkPost(channel, 'ilink/bot/getuploadurl', {
    filekey, media_type: mediaType, to_user_id: to,
    rawsize: rawSize, rawfilemd5: rawMd5, filesize: cipherSize,
    no_need_thumb: true, aeskey: aesKeyHex,
  }, 20000);
  dbg('getuploadurl resp keys=', Object.keys(resp));

  const uploadFullUrl = (resp.upload_full_url || '').trim();
  const uploadParam = resp.upload_param;
  let cdnUrl;
  if (uploadFullUrl) cdnUrl = uploadFullUrl;
  else if (uploadParam) cdnUrl = `${CDN_BASE_URL}/upload?encrypted_query_param=${encodeURIComponent(uploadParam)}&filekey=${encodeURIComponent(filekey)}`;
  else throw new Error('getuploadurl 未返回 upload_full_url / upload_param');

  const cdnRes = await fetch(cdnUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/octet-stream' },
    body: new Uint8Array(cipher),
    signal: AbortSignal.timeout(120000),
  });
  dbg('CDN upload ->', cdnRes.status);
  if (cdnRes.status >= 400 && cdnRes.status < 500) {
    const msg = cdnRes.headers.get('x-error-message') || (await cdnRes.text().catch(() => ''));
    throw new Error(`CDN 上传客户端错误 ${cdnRes.status}: ${msg}`);
  }
  if (!cdnRes.ok) {
    const msg = cdnRes.headers.get('x-error-message') || `status ${cdnRes.status}`;
    throw new Error(`CDN 上传失败 ${cdnRes.status}: ${msg}`);
  }
  const downloadParam = cdnRes.headers.get('x-encrypted-param');
  if (!downloadParam) throw new Error('CDN 响应缺少 x-encrypted-param');

  return {
    encrypt_query_param: downloadParam,
    aes_key_b64: Buffer.from(aesKeyHex).toString('base64'),
    cipher_size: cipherSize,
    raw_size: rawSize,
  };
}

async function sendImage(channel, to, filePath, caption, ctx) {
  const m = await uploadMedia(channel, filePath, to, 1);
  const items = [];
  if (caption) items.push({ type: 1, text_item: { text: caption } });
  items.push({ type: 2, image_item: { media: { encrypt_query_param: m.encrypt_query_param, aes_key: m.aes_key_b64, encrypt_type: 1 }, mid_size: m.cipher_size } });
  await sendMediaItems(channel, to, items, ctx, 'sendImage');
}
async function sendFile(channel, to, filePath, fileName, caption, ctx) {
  const m = await uploadMedia(channel, filePath, to, 3);
  const items = [];
  if (caption) items.push({ type: 1, text_item: { text: caption } });
  items.push({ type: 4, file_item: { media: { encrypt_query_param: m.encrypt_query_param, aes_key: m.aes_key_b64, encrypt_type: 1 }, file_name: fileName, len: String(m.raw_size) } });
  await sendMediaItems(channel, to, items, ctx, 'sendFile');
}
async function sendVideo(channel, to, filePath, caption, ctx) {
  const m = await uploadMedia(channel, filePath, to, 2);
  const items = [];
  if (caption) items.push({ type: 1, text_item: { text: caption } });
  items.push({ type: 5, video_item: { media: { encrypt_query_param: m.encrypt_query_param, aes_key: m.aes_key_b64, encrypt_type: 1 }, video_size: m.cipher_size } });
  await sendMediaItems(channel, to, items, ctx, 'sendVideo');
}
async function sendMediaItems(channel, to, items, ctx, label) {
  let last = '';
  for (const item of items) {
    last = uuid16();
    await ilinkPost(channel, 'ilink/bot/sendmessage', {
      msg: { from_user_id: '', to_user_id: to, client_id: last, message_type: 2, message_state: 2, item_list: [item], context_token: ctx },
    });
  }
  dbg(label, 'sent', items.length, 'items');
}

// ── main ─────────────────────────────────────────────────
(async () => {
  const a = parseArgs(process.argv);
  VERBOSE = a.verbose;
  if (!fs.existsSync(SETTINGS_PATH)) throw new Error(`settings.json not found at ${SETTINGS_PATH}`);
  const cfg = JSON.parse(fs.readFileSync(SETTINGS_PATH, 'utf-8'));
  const channel = findWeixinClawBot(cfg);
  if (!channel.botToken) throw new Error('settings.json 中 weixinClawBot 缺少 botToken');
  if (!channel.userId) throw new Error('settings.json 中 weixinClawBot 缺少 userId（老板的 im.wechat id）');
  const to = channel.userId;

  // ctx 优先级：--context 显式 ＞ 读 cursor get_updates_buf（不采用空 token，不够通用）
  let ctxSrc = a.context ? 'override' : '';
  let ctx = a.context || '';
  if (!ctx) { ctx = loadContextToken(); if (ctx) ctxSrc = 'cursor_buf'; }
  if (!ctx) {
    console.error('[weixinclaw] ⚠️ 未取得 context_token：claw-state/weixin 下无有效 cursor buf。');
    console.error('[weixinclaw]   请让老板先在微信给 ClawBot 发一条消息触发 host 刷新游标，或用 --context <token> 显式传入。');
    process.exit(2);
  }
  // ⚠️ 只打印长度，绝不打印 token 明文
  console.log(`[weixinclaw] channel=${channel.name} to=${to} mode=proactive appid=${ILINK_APP_ID} cver=${CLIENT_VERSION} chver=${CHANNEL_VERSION} ctx_src=${ctxSrc} ctx_len=${ctx.length}`);

  let n = 0;
  if (a.image) {
    await sendImage(channel, to, a.image, a.caption || '', ctx);
    console.log('[weixinclaw] 图片已推送'); n++;
  } else if (a.video) {
    await sendVideo(channel, to, a.video, a.caption || '', ctx);
    console.log('[weixinclaw] 视频已推送'); n++;
  } else if (a.file) {
    await sendFile(channel, to, a.file, a.name || path.basename(a.file), a.caption || '', ctx);
    console.log('[weixinclaw] 文件已推送'); n++;
  } else if (a.textFile) {
    const t = fs.readFileSync(a.textFile, 'utf-8').replace(/\r\n/g, '\n').trim();
    n += await sendText(channel, to, t, ctx);
  } else if (a.text != null) {
    n += await sendText(channel, to, a.text, ctx);
  } else {
    n += await sendText(channel, to, DEFAULT_TEXT, ctx);
  }

  console.log(`[weixinclaw] OK — 共推送 ${n} 条消息，请老板在微信确认是否收到 ClawBot 推送。`);
})().catch((e) => {
  console.error('[weixinclaw] FAILED:', e.message);
  process.exit(1);
});
