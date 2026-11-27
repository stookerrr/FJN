const DEFAULT_MODEL = "gemini-3.8-flash";
const MAX_REQUEST_BYTES = 1_000_000;
const MAX_TEXT_CHARS = 100_000;

function json(data, status = 200, extraHeaders = {}) {
  return Response.json(data, {
    status,
    headers: { "Cache-Control": "no-store", ...extraHeaders }
  });
}

function countTextChars(value) {
  if (typeof value === "string") return value.length;
  if (Array.isArray(value)) return value.reduce((n, item) => n + countTextChars(item), 0);
  if (value && typeof value === "object") {
    // Image bytes are bounded by MAX_REQUEST_BYTES, but aren't prompt text.
    return Object.entries(value).reduce((n, [key, item]) =>
      n + (key === "data" && typeof item === "string" ? 0 : countTextChars(item)), 0);
  }
  return 0;
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/gemini") return env.ASSETS.fetch(request);

    if (request.method !== "POST") {
      return json({ error: "Method not allowed. Use POST." }, 405, { Allow: "POST" });
    }

    // Reject cross-origin browser requests. This is not a substitute for user authentication/rate limits.
    const origin = request.headers.get("Origin");
    if (origin && origin !== url.origin) {
      return json({ error: "Cross-origin requests are not allowed." }, 403);
    }

    // Best-effort per-IP request cap. Cloudflare documents these limits as
    // approximate and separately enforced in each Cloudflare location.
    if (env.GEMINI_RATE_LIMITER) {
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const { success } = await env.GEMINI_RATE_LIMITER.limit({ key: ip });
      if (!success) return json({ error: "Too many AI requests. Please wait a minute and try again." }, 429);
    }

    const key = env.GEMINI_API_KEY;
    if (!key) {
      return json({ error: "GEMINI_API_KEY is not configured in Worker Secrets." }, 500);
    }

    const contentLength = Number(request.headers.get("content-length") || 0);
    if (contentLength > MAX_REQUEST_BYTES) return json({ error: "Request is too large." }, 413);

    let rawBody;
    try { rawBody = await request.text(); }
    catch { return json({ error: "Could not read request body." }, 400); }
    if (rawBody.length > MAX_REQUEST_BYTES) return json({ error: "Request is too large." }, 413);

    let body;
    try { body = JSON.parse(rawBody); }
    catch { return json({ error: "Invalid JSON body." }, 400); }
    if (!body || typeof body !== "object" || Array.isArray(body)) {
      return json({ error: "Invalid request format." }, 400);
    }

    const { prompt, contents, systemInstruction, jsonMode, schema } = body;
    const finalContents = Array.isArray(contents) && contents.length
      ? contents
      : (typeof prompt === "string" && prompt.trim()
        ? [{ role: "user", parts: [{ text: prompt }] }]
        : null);

    if (!finalContents) return json({ error: "Missing prompt or contents." }, 400);
    if (countTextChars(finalContents) > MAX_TEXT_CHARS) {
      return json({ error: "Prompt or conversation is too long." }, 413);
    }
    if (systemInstruction !== undefined &&
        (typeof systemInstruction !== "string" || systemInstruction.length > 20_000)) {
      return json({ error: "Invalid system instruction." }, 400);
    }
    if (jsonMode !== undefined && typeof jsonMode !== "boolean") {
      return json({ error: "jsonMode must be a boolean." }, 400);
    }
    if (schema !== undefined && (schema === null || typeof schema !== "object" || Array.isArray(schema))) {
      return json({ error: "Invalid response schema." }, 400);
    }

    const generationConfig = { temperature: 0.3 };
    if (jsonMode) {
      generationConfig.responseMimeType = "application/json";
      if (schema) generationConfig.responseSchema = schema;
    }

    const payload = { contents: finalContents, generationConfig };
    if (systemInstruction) payload.systemInstruction = { parts: [{ text: systemInstruction }] };

    const model = env.GEMINI_MODEL || DEFAULT_MODEL;
    let upstream;
    try {
      upstream = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload)
        }
      );
    } catch {
      return json({ error: "Could not connect to Gemini. Please try again." }, 502);
    }

    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) {
      const message = data?.error?.message || `Gemini API error (${upstream.status}).`;
      const status = upstream.status === 429 ? 429 :
        (upstream.status === 400 ? 400 : 502);
      return json({ error: message }, status);
    }

    const text = data?.candidates?.[0]?.content?.parts
      ?.map(part => typeof part.text === "string" ? part.text : "")
      .join("") || "";
    if (!text) return json({ error: "Gemini returned no text. The response may have been blocked." }, 502);

    return json({ text });
  }
};
