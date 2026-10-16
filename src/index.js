const API_ORIGIN = "https://demo.douyin.wtf";
const ALLOWED_INPUT_HOSTS = new Set([
  "douyin.com", "www.douyin.com", "v.douyin.com",
  "iesdouyin.com", "www.iesdouyin.com",
]);
const MEDIA_HOST_SUFFIXES = [
  "douyinvod.com", "douyinpic.com", "snssdk.com", "ibytedtos.com", "zjcdn.com", "douyin.com",
  "byteimg.com", "bytecdn.cn", "bytedance.net",
];
const TOKEN_TTL_MS = 30 * 60 * 1000;
const PARSE_INTERVAL_MS = 1000;

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/parse") {
      if (request.method !== "POST") return json({ error: "请使用 POST 请求。" }, 405);
      const limiter = env.PARSE_LIMITER.get(env.PARSE_LIMITER.idFromName("global"));
      await limiter.fetch("https://parse-limiter/slot", {
        headers: { "x-client-ip": request.headers.get("CF-Connecting-IP") || "unknown" },
      });
      return parseDouyinLink(request, env);
    }
    if (url.pathname === "/api/download") {
      if (request.method !== "POST") return json({ error: "请使用 POST 请求。" }, 405);
      return proxyMedia(request, env, "attachment", "video");
    }
    if (url.pathname === "/api/preview" || url.pathname === "/api/cover") {
      if (request.method !== "GET") return json({ error: "请使用 GET 请求。" }, 405);
      return proxyMedia(request, env, "inline", url.pathname === "/api/cover" ? "image" : "video");
    }
    return env.ASSETS.fetch(request);
  },
};

// 只把验证过的抖音链接交给固定解析 API，避免代理任意地址。
async function parseDouyinLink(request, env) {
  let input;
  try {
    const body = await request.json();
    input = typeof body.url === "string" ? body.url.trim() : "";
  } catch {
    return json({ error: "请求内容不是有效的 JSON。" }, 400);
  }
  if (!input || input.length > 4096) return json({ error: "请输入抖音链接或作品 ID。" }, 400);

  let sourceUrl;
  if (/^\d{10,25}$/.test(input)) {
    sourceUrl = new URL(`https://www.douyin.com/video/${input}`);
  } else {
    try {
      sourceUrl = new URL(input);
    } catch {
      return json({ error: "请输入有效的抖音链接或 10 至 25 位作品 ID。" }, 400);
    }
  }
  if (sourceUrl.protocol !== "https:" || !ALLOWED_INPUT_HOSTS.has(sourceUrl.hostname.toLowerCase())) {
    return json({ error: "目前只支持抖音作品链接。" }, 400);
  }

  try {
    // 演示账号口令由上游公开提供；会话 Cookie 只在 Worker 内使用。
    const demoResponse = await fetch(`${API_ORIGIN}/api/v1/auth/demo`, {
      headers: { accept: "application/json" },
    });
    const demoBody = await demoResponse.json();
    const password = demoBody?.data?.password;
    if (!demoResponse.ok || typeof password !== "string" || !password) {
      return json({ error: "演示服务暂时无法登录，请稍后重试。" }, 502);
    }

    const loginResponse = await fetch(`${API_ORIGIN}/api/v1/auth/login`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json" },
      body: JSON.stringify({ username: "demo", password }),
    });
    if (!loginResponse.ok) return json({ error: "演示服务登录失败，请稍后重试。" }, 502);
    const cookie = sessionCookie(loginResponse.headers);
    if (!cookie) return json({ error: "演示服务没有返回有效会话。" }, 502);

    // 同步解析并请求原始数据，以兼容上游标准化媒体列表和原始视频码率列表。
    const parseResponse = await fetch(`${API_ORIGIN}/api/v1/parse?wait=25`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", cookie },
      body: JSON.stringify({ url: sourceUrl.href, include_raw: true }),
    });
    const result = await parseResponse.json();
    if (!parseResponse.ok || result?.success === false) {
      if (parseResponse.status === 429) {
        return json({ error: "演示解析服务正在限流，请稍等片刻再试。" }, 429);
      }
      return json({ error: safeApiMessage(result) }, 502);
    }
    const data = result?.data?.data ?? result?.data;
    if (!data || typeof data !== "object") return json({ error: "解析服务返回的数据结构暂不受支持。" }, 502);
    return json({ result: await normalizeResult(data, env) });
  } catch {
    return json({ error: "连接解析服务失败，请稍后重试。" }, 502);
  }
}

function sessionCookie(headers) {
  const values = typeof headers.getSetCookie === "function" ? headers.getSetCookie() : [headers.get("set-cookie") || ""];
  for (const value of values) {
    const match = value.match(/(?:^|[,; ]+)dtk_session=([^;,\s]+)/);
    if (match) return `dtk_session=${match[1]}`;
  }
  return "";
}

function safeApiMessage(body) {
  const message = body?.error?.message;
  return typeof message === "string" && message.length < 240
    ? `解析失败：${message}` : "解析服务暂时不可用，请稍后重试。";
}

// 只返回页面需要的字段；代理地址使用短时签名，不能被改成任意 URL。
async function normalizeResult(data, env) {
  const raw = data.raw ?? data;
  const video = raw.video ?? {};
  const author = data.author ?? raw.author ?? {};
  const stats = data.stats ?? raw.statistics ?? {};
  const duration = data.duration_ms ?? video.duration ?? null;
  const created = data.created_at ?? raw.create_time ?? null;
  // 新版接口返回 media.streams；旧版/原始结构使用 video.bit_rate。
  const streams = data.media?.streams;
  const variants = Array.isArray(streams) && streams.length ? streams
    : Array.isArray(data.video_variants) ? data.video_variants
      : Array.isArray(data.videoVariants) ? data.videoVariants
        : Array.isArray(video.bit_rate) ? video.bit_rate : [];

  const title = firstText(data.title, data.description, raw.desc);
  const contentId = firstText(data.content_id, raw.aweme_id);
  const cover = firstText(
    data.cover_url, data.coverUrl,
    raw.video?.cover?.url_list?.[0], raw.video?.origin_cover?.url_list?.[0],
    raw.video?.dynamic_cover?.url_list?.[0], raw.video?.animated_cover?.url_list?.[0],
  );
  const authorName = firstText(typeof author === "string" ? author : null, author.nickname, author.name);
  const createdAt = normalizeTimestamp(created);
  const fileName = buildFileName(title, authorName, createdAt);
  return {
    title,
    contentId,
    coverUrl: cover && env.MEDIA_PROXY_SECRET && safeMediaUrl(cover) && isAllowedMediaHost(new URL(cover).hostname)
      ? await createProxyUrl(cover, fileName, env.MEDIA_PROXY_SECRET, "/api/cover") : null,
    author: authorName,
    createdAt,
    fileName,
    durationMs: finiteNumber(duration),
    statistics: {
      likes: nullableNumber(stats.likes ?? stats.digg_count ?? raw.statistics?.digg_count),
      comments: nullableNumber(stats.comments ?? stats.comment_count ?? raw.statistics?.comment_count),
      shares: nullableNumber(stats.shares ?? stats.share_count ?? raw.statistics?.share_count),
      collects: nullableNumber(stats.collects ?? stats.collect_count ?? raw.statistics?.collect_count),
    },
    variants: await Promise.all(variants.map(variant => normalizeVariant(variant, fileName, env))),
  };
}

async function normalizeVariant(variant, fileName, env) {
  const addr = variant.play_addr ?? variant.playAddr ?? {};
  const h265 = variant.is_h265 ?? variant.codec === "h265";
  const urls = Array.isArray(variant.urls) ? variant.urls
    : Array.isArray(addr.url_list) ? addr.url_list : [];
  const url = safeMediaUrl(variant.url) ?? urls.map(safeMediaUrl).find(Boolean) ?? null;
  const proxyToken = url && env.MEDIA_PROXY_SECRET && isAllowedMediaHost(new URL(url).hostname)
    ? await createProxyToken(url, fileName, env.MEDIA_PROXY_SECRET) : null;
  return {
    url,
    proxyToken,
    previewUrl: proxyToken ? await createProxyUrlFromToken(proxyToken, "/api/preview") : null,
    width: finiteNumber(addr.width ?? variant.width),
    height: finiteNumber(addr.height ?? variant.height),
    fps: finiteNumber(variant.FPS ?? variant.fps),
    codec: h265 === true ? "H.265" : h265 === false ? "H.264" : "未知编码",
    format: firstText(variant.format),
    bitrate: finiteNumber(variant.bitrate ?? variant.bit_rate),
    watermark: variant.watermark === true,
    sizeBytes: finiteNumber(addr.data_size ?? variant.data_size ?? variant.size_bytes),
  };
}

async function proxyMedia(request, env, disposition, type) {
  if (!env.MEDIA_PROXY_SECRET) return json({ error: "代理下载暂未配置。" }, 503);
  let token;
  try {
    token = request.method === "GET" ? new URL(request.url).searchParams.get("token") : (await request.formData()).get("token");
  } catch {
    return json({ error: "下载请求格式无效。" }, 400);
  }
  if (typeof token !== "string" || token.length > 12000) return json({ error: "媒体链接无效或已过期，请重新解析。" }, 400);

  let payload;
  try {
    payload = await verifyProxyToken(token, env.MEDIA_PROXY_SECRET);
  } catch {
    return json({ error: "媒体链接无效或已过期，请重新解析。" }, 403);
  }
  const mediaUrl = safeMediaUrl(payload.url);
  if (!mediaUrl || !isAllowedMediaHost(new URL(mediaUrl).hostname)) {
    return json({ error: "媒体地址不在允许的来源范围内。" }, 403);
  }

  try {
    const upstream = await fetchMedia(mediaUrl, request.headers.get("range"));
    if (!upstream.ok && upstream.status !== 206) {
      return json({ error: "上游视频地址已失效，请重新解析。" }, upstream.status === 404 ? 404 : 502);
    }
    const contentType = upstream.headers.get("content-type") || "application/octet-stream";
    const validType = type === "image" ? contentType.startsWith("image/")
      : contentType.startsWith("video/") || ["application/octet-stream", "binary/octet-stream"].includes(contentType.split(";")[0].trim());
    if (!validType) {
      return json({ error: type === "image" ? "上游封面格式暂不支持。" : "上游返回的内容不是可播放的视频。" }, 502);
    }
    const headers = new Headers({
      "content-type": contentType,
      "content-disposition": contentDisposition(payload.fileName, disposition),
      "cache-control": "private, no-store",
      "x-content-type-options": "nosniff",
      "accept-ranges": upstream.headers.get("accept-ranges") || "bytes",
    });
    for (const name of ["content-length", "content-range"]) {
      const value = upstream.headers.get(name);
      if (value) headers.set(name, value);
    }
    return new Response(upstream.body, { status: upstream.status, headers });
  } catch {
    return json({ error: "代理下载连接失败，请稍后重试。" }, 502);
  }
}

async function fetchMedia(initialUrl, range) {
  let current = new URL(initialUrl);
  const headers = new Headers({ accept: "*/*", "accept-encoding": "identity" });
  if (range) headers.set("range", range);
  for (let hop = 0; hop <= 3; hop++) {
    if (!isAllowedMediaHost(current.hostname)) throw new Error("媒体重定向地址不受支持");
    const response = await fetch(current, { headers, redirect: "manual" });
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.get("location");
    if (!location || hop === 3) throw new Error("媒体重定向次数过多");
    current = new URL(location, current);
    if (current.protocol !== "https:") throw new Error("媒体重定向协议不受支持");
  }
  throw new Error("媒体重定向次数过多");
}

async function createProxyToken(url, fileName, secret) {
  const payload = { url, fileName, expiresAt: Date.now() + TOKEN_TTL_MS };
  const encoded = base64UrlEncode(new TextEncoder().encode(JSON.stringify(payload)));
  const key = await importSigningKey(secret);
  const signature = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(encoded));
  return `${encoded}.${base64UrlEncode(new Uint8Array(signature))}`;
}

async function createProxyUrl(url, fileName, secret, path) {
  return createProxyUrlFromToken(await createProxyToken(url, fileName, secret), path);
}

async function createProxyUrlFromToken(token, path) {
  return `${path}?token=${encodeURIComponent(token)}`;
}

async function verifyProxyToken(token, secret) {
  const [encoded, signature, extra] = token.split(".");
  if (!encoded || !signature || extra) throw new Error("Invalid token");
  const key = await importSigningKey(secret);
  const valid = await crypto.subtle.verify("HMAC", key, base64UrlDecode(signature), new TextEncoder().encode(encoded));
  if (!valid) throw new Error("Invalid signature");
  const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(encoded)));
  if (!Number.isFinite(payload.expiresAt) || payload.expiresAt < Date.now() || payload.expiresAt > Date.now() + TOKEN_TTL_MS + 60000) {
    throw new Error("Expired token");
  }
  if (typeof payload.url !== "string" || typeof payload.fileName !== "string") throw new Error("Invalid payload");
  return payload;
}

function importSigningKey(secret) {
  return crypto.subtle.importKey("raw", new TextEncoder().encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

function base64UrlEncode(bytes) {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function base64UrlDecode(value) {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/");
  const binary = atob(base64 + "=".repeat((4 - base64.length % 4) % 4));
  return Uint8Array.from(binary, char => char.charCodeAt(0));
}

function isAllowedMediaHost(hostname) {
  const host = hostname.toLowerCase();
  return MEDIA_HOST_SUFFIXES.some(suffix => host === suffix || host.endsWith(`.${suffix}`));
}

function contentDisposition(fileName, disposition = "attachment") {
  const fallback = fileName.replace(/[^\x20-\x7e]/g, "_").replace(/[\\";]/g, "_");
  const encoded = encodeURIComponent(fileName).replace(/[!'()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

function safeMediaUrl(value) {
  if (typeof value !== "string") return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" ? url.href : null;
  } catch {
    return null;
  }
}

function buildFileName(title, author, createdAt) {
  const time = createdAt ? formatPublishTime(createdAt) : "";
  const parts = [safeFilenamePart(title, 60), safeFilenamePart(author, 40), time].filter(Boolean);
  return `${parts.join("_") || "抖音视频"}.mp4`;
}

function safeFilenamePart(value, maxLength) {
  if (typeof value !== "string") return "";
  let part = value.normalize("NFC")
    .replace(/[<>:"/\\|?*\u0000-\u001f\u007f]/g, "_")
    .replace(/[\s_]+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim();
  part = Array.from(part).slice(0, maxLength).join("").replace(/[. ]+$/g, "");
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(part)) part = `_${part}`;
  return part;
}

function formatPublishTime(value) {
  const date = new Date(value);
  if (Number.isNaN(date.valueOf())) return "";
  const fields = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(date).reduce((result, item) => ({ ...result, [item.type]: item.value }), {});
  return `${fields.year}${fields.month}${fields.day}_${fields.hour}${fields.minute}${fields.second}`;
}

function normalizeTimestamp(value) {
  const numeric = finiteNumber(value);
  if (numeric !== null) {
    const date = new Date(numeric < 1e12 ? numeric * 1000 : numeric);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  if (typeof value === "string" && value) {
    const date = new Date(value);
    return Number.isNaN(date.valueOf()) ? null : date.toISOString();
  }
  return null;
}

function firstText(...values) {
  return values.find(value => typeof value === "string" && value.trim())?.trim() ?? null;
}

function finiteNumber(value) {
  const number = Number(value);
  return value !== null && value !== "" && Number.isFinite(number) ? number : null;
}

function nullableNumber(value) {
  return value === null || value === undefined ? null : finiteNumber(value);
}

function json(body, status = 200) {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

// 单个 Durable Object 协调解析请求，确保不同 Worker 实例间也按 IP 排队。
export class ParseRateLimiter {
  constructor(state) {
    this.state = state;
  }

  async fetch(request) {
    const ip = request.headers.get("x-client-ip") || "unknown";
    const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(ip)));
    const key = `ip:${Array.from(digest, byte => byte.toString(16).padStart(2, "0")).join("")}`;
    const now = Date.now();
    const slot = await this.state.storage.transaction(async txn => {
      const nextAllowedAt = await txn.get(key) ?? now;
      const scheduledAt = Math.max(now, nextAllowedAt);
      await txn.put(key, scheduledAt + PARSE_INTERVAL_MS);
      return scheduledAt;
    });
    if (await this.state.storage.getAlarm() === null) {
      await this.state.storage.setAlarm(now + 60_000);
    }
    const delay = slot - now;
    if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
    return new Response(null, { status: 204 });
  }

  async alarm() {
    const entries = await this.state.storage.list({ prefix: "ip:", limit: 1000 });
    const now = Date.now();
    await Promise.all([...entries].filter(([, nextAllowedAt]) => nextAllowedAt <= now).map(([key]) => this.state.storage.delete(key)));
    if (entries.size === 1000) await this.state.storage.setAlarm(now + 60_000);
  }
}
