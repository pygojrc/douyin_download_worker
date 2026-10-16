const API_ORIGIN = "https://demo.douyin.wtf";
const ALLOWED_INPUT_HOSTS = new Set([
  "douyin.com", "www.douyin.com", "v.douyin.com",
  "iesdouyin.com", "www.iesdouyin.com",
]);

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/api/parse") {
      if (request.method !== "POST") return json({ error: "请使用 POST 请求。" }, 405);
      return parseDouyinLink(request);
    }
    return env.ASSETS.fetch(request);
  },
};

// 只把验证过的抖音链接交给固定解析 API，避免代理任意地址。
async function parseDouyinLink(request) {
  let input;
  try {
    const body = await request.json();
    input = typeof body.url === "string" ? body.url.trim() : "";
  } catch {
    return json({ error: "请求内容不是有效的 JSON。" }, 400);
  }
  if (!input || input.length > 4096) return json({ error: "请粘贴有效的抖音链接。" }, 400);

  let sourceUrl;
  try {
    sourceUrl = new URL(input);
  } catch {
    return json({ error: "链接格式无效，请粘贴完整的 https:// 链接。" }, 400);
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

    // wait=25 使用演示 API 的同步解析路径，避免前端轮询共享任务队列。
    const parseResponse = await fetch(`${API_ORIGIN}/api/v1/parse?wait=25`, {
      method: "POST",
      headers: { accept: "application/json", "content-type": "application/json", cookie },
      body: JSON.stringify({ url: sourceUrl.href }),
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
    return json({ result: normalizeResult(data) });
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

// 只把页面要用的字段返回浏览器，不透出原始视频地址。
function normalizeResult(data) {
  const raw = data.raw ?? data;
  const video = raw.video ?? {};
  const author = data.author ?? raw.author ?? {};
  const stats = data.stats ?? raw.statistics ?? {};
  const duration = data.duration_ms ?? video.duration ?? null;
  const created = data.created_at ?? raw.create_time ?? null;
  const variants = Array.isArray(data.video_variants) ? data.video_variants
    : Array.isArray(data.videoVariants) ? data.videoVariants
      : Array.isArray(video.bit_rate) ? video.bit_rate : [];

  return {
    title: firstText(data.title, data.description, raw.desc),
    contentId: firstText(data.content_id, raw.aweme_id),
    author: firstText(author.nickname, author.name),
    createdAt: normalizeTimestamp(created),
    durationMs: finiteNumber(duration),
    statistics: {
      likes: nullableNumber(stats.digg_count),
      comments: nullableNumber(stats.comment_count),
      shares: nullableNumber(stats.share_count),
      collects: nullableNumber(stats.collect_count),
    },
    variants: variants.map(normalizeVariant),
  };
}

function normalizeVariant(variant) {
  const addr = variant.play_addr ?? variant.playAddr ?? {};
  const h265 = variant.is_h265;
  return {
    width: finiteNumber(addr.width ?? variant.width),
    height: finiteNumber(addr.height ?? variant.height),
    fps: finiteNumber(variant.FPS ?? variant.fps),
    codec: h265 === true ? "H.265" : h265 === false ? "H.264" : "未知编码",
    format: firstText(variant.format),
    sizeBytes: finiteNumber(variant.data_size ?? variant.size_bytes),
  };
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
