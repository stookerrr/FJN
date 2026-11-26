export async function onRequestPost(context) {
  const key = context.env.GEMINI_API_KEY;
  if (!key) {
    return Response.json({ error: "GEMINI_API_KEY is not configured on the server." }, { status: 500 });
  }

  let body;
  try {
    body = await context.request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const { prompt, contents, systemInstruction, jsonMode, schema } = body || {};
  const finalContents = Array.isArray(contents) && contents.length
    ? contents
    : prompt
      ? [{ role: "user", parts: [{ text: prompt }] }]
      : null;

  if (!finalContents) {
    return Response.json({ error: "Missing prompt or contents" }, { status: 400 });
  }

  const fallback = ["gemini-2.5-flash", "gemini-2.0-flash", "gemini-3.8-flash", "gemini-2.5-flash-lite"];
  let models = fallback;
  try {
    const mRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(key)}`);
    if (mRes.ok) {
      const mData = await mRes.json();
      const list = (mData.models || [])
        .filter((m) => (m.supportedGenerationMethods || []).includes("generateContent"))
        .map((m) => m.name.replace(/^models\//, ""))
        .filter((n) => /gemini/i.test(n) && !/embedding|imagen|veo|tts|audio|robotics/i.test(n));
      const flash = list.filter((n) => /flash/i.test(n));
      const rest = list.filter((n) => !/flash/i.test(n));
      models = [...new Set([...flash, ...rest, ...fallback])];
    }
  } catch {}

  let lastErr = "Failed to reach Gemini API";
  for (const model of models.slice(0, 5)) {
    const genCfg = { temperature: 0.3 };
    if (jsonMode) {
      genCfg.responseMimeType = "application/json";
      if (schema) genCfg.responseSchema = schema;
    }

    const payload = { contents: finalContents, generationConfig: genCfg };
    if (systemInstruction) {
      payload.systemInstruction = { parts: [{ text: systemInstruction }] };
    }

    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      }
    );

    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      lastErr = data?.error?.message || `HTTP ${res.status}`;
      if (res.status === 404 || res.status === 400 || res.status === 429) continue;
      return Response.json({ error: lastErr }, { status: res.status });
    }

    const text = data?.candidates?.[0]?.content?.parts?.map((p) => p.text || "").join("") || "";
    if (text) return Response.json({ text });
  }

  return Response.json({ error: lastErr }, { status: 502 });
}
