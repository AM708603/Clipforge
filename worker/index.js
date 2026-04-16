// ClipForge — Cloudflare Worker
// Fetches YouTube transcript via yt-transcript API, sends to Gemini, returns clip timestamps

const CORS_HEADERS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Content-Type": "application/json",
};

export default {
  async fetch(request, env) {
    // Handle CORS preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: CORS_HEADERS });
    }

    const url = new URL(request.url);

    // ── GET /health ──────────────────────────────────────────────
    if (url.pathname === "/health") {
      return json({ status: "ok", service: "ClipForge Worker" });
    }

    // ── POST /api/info ───────────────────────────────────────────
    if (url.pathname === "/api/info" && request.method === "POST") {
      return handleInfo(request, env);
    }

    // ── POST /api/clips ──────────────────────────────────────────
    if (url.pathname === "/api/clips" && request.method === "POST") {
      return handleClips(request, env);
    }

    return json({ error: "Not found" }, 404);
  },
};

// ─────────────────────────────────────────────────────────────────
// HELPER: extract YouTube video ID from any URL format
// ─────────────────────────────────────────────────────────────────
function extractVideoId(urlStr) {
  try {
    const u = new URL(urlStr);
    // Standard: youtube.com/watch?v=ID
    if (u.searchParams.get("v")) return u.searchParams.get("v");
    // Short: youtu.be/ID
    if (u.hostname === "youtu.be") return u.pathname.slice(1).split("?")[0];
    // Embed: youtube.com/embed/ID
    const embedMatch = u.pathname.match(/\/embed\/([^/?]+)/);
    if (embedMatch) return embedMatch[1];
    // Shorts: youtube.com/shorts/ID
    const shortsMatch = u.pathname.match(/\/shorts\/([^/?]+)/);
    if (shortsMatch) return shortsMatch[1];
  } catch (_) {}
  // Plain ID fallback
  if (/^[a-zA-Z0-9_-]{11}$/.test(urlStr.trim())) return urlStr.trim();
  return null;
}

// ─────────────────────────────────────────────────────────────────
// HELPER: fetch YouTube video metadata via oEmbed (no API key)
// ─────────────────────────────────────────────────────────────────
async function fetchVideoInfo(videoId) {
  const oembedUrl = `https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`;
  const res = await fetch(oembedUrl);
  if (!res.ok) throw new Error("Could not fetch video info. Check the URL.");
  const data = await res.json();
  return {
    title: data.title || "Unknown",
    channel: data.author_name || "Unknown",
    thumbnail: `https://img.youtube.com/vi/${videoId}/maxresdefault.jpg`,
  };
}

// ─────────────────────────────────────────────────────────────────
// HELPER: fetch transcript via youtube-transcript API (free, no key)
// ─────────────────────────────────────────────────────────────────
async function fetchTranscript(videoId) {
  try {
    // Use youtubetranscript.com public API endpoint
    const res = await fetch(
      `https://api.youtubetranscript.com/?videoID=${videoId}`,
      { headers: { "Accept": "application/json" } }
    );
    if (!res.ok) return null;
    const data = await res.json();
    if (!data || !Array.isArray(data.transcript)) return null;
    // data.transcript = [{text, start, dur}, ...]
    return data.transcript.slice(0, 800); // cap to avoid token overflow
  } catch (_) {
    return null;
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER: call Gemini Flash (free, 1500 req/day)
// ─────────────────────────────────────────────────────────────────
async function callGemini(apiKey, prompt) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 1500,
        },
      }),
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini error: ${err}`);
  }
  const data = await res.json();
  const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";
  return raw.trim();
}

// ─────────────────────────────────────────────────────────────────
// HELPER: build prompt and parse AI response
// ─────────────────────────────────────────────────────────────────
function buildPrompt(transcript, numClips) {
  let transcriptText = "";
  if (transcript && transcript.length > 0) {
    for (const seg of transcript) {
      const start = parseFloat(seg.start || 0);
      const m = Math.floor(start / 60);
      const s = Math.floor(start % 60);
      transcriptText += `[${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}] ${(seg.text||"").replace(/\n/g," ")}\n`;
    }
    transcriptText = transcriptText.slice(0, 11000);
  }

  if (transcriptText.length > 100) {
    return `You are an expert short-form video editor for Instagram Reels, YouTube Shorts, and TikTok.

Here is a transcript of a long-form video/podcast:

${transcriptText}

Find the ${numClips} BEST moments to cut as viral short clips (each 30-90 seconds).
Look for: strong hooks, surprising facts, emotional moments, actionable tips, funny parts, strong opinions, story peaks.

Rules:
- Each clip: 30 to 90 seconds long
- No overlapping clips
- Start at a natural sentence start, end at a natural sentence end
- Pick the highest-energy, most shareable moments

Respond ONLY with a valid JSON array. No markdown, no explanation, no extra text. Just the raw JSON array:
[
  {
    "title": "Short catchy title (max 7 words)",
    "description": "One sentence: why this clip will go viral",
    "hook": "Opening line for caption",
    "start": <start seconds as number>,
    "end": <end seconds as number>
  }
]`;
  } else {
    // No transcript — use structure-based suggestions
    return `You are an expert short-form video editor. I have a long podcast/video and no transcript is available.

Based on typical podcast structure, suggest ${numClips} clip segments that are likely to contain great shareable moments:
- Opening hook (0–90s)
- First key insight (~15% through a typical 60-min show = ~540s)
- Second insight (~35% = ~1260s)
- Surprising or emotional moment (~55% = ~1980s)
- Powerful closing thought (~88% = ~3168s)

Each clip should be 45–75 seconds. Respond ONLY with a valid JSON array, no markdown:
[
  {
    "title": "Catchy title",
    "description": "Why this section likely has great content",
    "hook": "Suggested caption hook",
    "start": <seconds>,
    "end": <seconds>
  }
]`;
  }
}

function parseAIResponse(raw) {
  // Strip markdown code fences if present
  let cleaned = raw.replace(/^```json\s*/i, "").replace(/\s*```$/i, "").trim();
  // Find first [ to last ]
  const start = cleaned.indexOf("[");
  const end = cleaned.lastIndexOf("]");
  if (start === -1 || end === -1) throw new Error("AI did not return valid JSON array");
  cleaned = cleaned.slice(start, end + 1);
  const arr = JSON.parse(cleaned);
  return arr.map(c => ({
    title: c.title || "Clip",
    description: c.description || "",
    hook: c.hook || "",
    start: Math.max(0, parseFloat(c.start) || 0),
    end: Math.max(0, parseFloat(c.end) || 0),
    duration: Math.round(Math.abs((parseFloat(c.end) || 0) - (parseFloat(c.start) || 0))),
  })).filter(c => c.end - c.start >= 15);
}

// ─────────────────────────────────────────────────────────────────
// ROUTE: POST /api/info  { url }
// ─────────────────────────────────────────────────────────────────
async function handleInfo(request, env) {
  try {
    const body = await request.json();
    const videoId = extractVideoId(body.url || "");
    if (!videoId) return json({ error: "Invalid YouTube URL" }, 400);

    const info = await fetchVideoInfo(videoId);
    return json({ ...info, videoId });
  } catch (e) {
    return json({ error: e.message }, 400);
  }
}

// ─────────────────────────────────────────────────────────────────
// ROUTE: POST /api/clips  { url, num_clips }
// ─────────────────────────────────────────────────────────────────
async function handleClips(request, env) {
  const GEMINI_API_KEY = env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) return json({ error: "GEMINI_API_KEY not configured in worker" }, 500);

  try {
    const body = await request.json();
    const videoId = extractVideoId(body.url || "");
    if (!videoId) return json({ error: "Invalid YouTube URL" }, 400);

    const numClips = Math.min(parseInt(body.num_clips) || 5, 8);

    // Fetch transcript (best effort — won't fail if unavailable)
    const transcript = await fetchTranscript(videoId);
    const hasTranscript = transcript && transcript.length > 10;

    // Build prompt & call Gemini
    const prompt = buildPrompt(hasTranscript ? transcript : null, numClips);
    const aiRaw = await callGemini(GEMINI_API_KEY, prompt);
    const clips = parseAIResponse(aiRaw);

    // Build cobalt download URLs for each clip
    const enrichedClips = clips.map((clip, i) => ({
      ...clip,
      index: i + 1,
      yt_timestamp_url: `https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(clip.start)}s`,
      // cobalt.tools API — free service that downloads YouTube clips
      cobalt_url: buildCobaltUrl(videoId, clip.start, clip.end),
      videoId,
    }));

    return json({
      clips: enrichedClips,
      has_transcript: hasTranscript,
      video_id: videoId,
    });
  } catch (e) {
    return json({ error: e.message }, 500);
  }
}

// ─────────────────────────────────────────────────────────────────
// HELPER: build cobalt.tools download link
// cobalt.tools is a free, open-source YouTube downloader
// ─────────────────────────────────────────────────────────────────
function buildCobaltUrl(videoId, start, end) {
  // cobalt.tools supports direct URL with timestamp
  // Format: https://cobalt.tools/  (user pastes timestamped URL)
  // We encode the timestamped YT URL for the user to use
  const ytUrl = encodeURIComponent(`https://www.youtube.com/watch?v=${videoId}&t=${Math.floor(start)}s`);
  return `https://cobalt.tools/?u=${ytUrl}`;
}

// ─────────────────────────────────────────────────────────────────
// UTIL
// ─────────────────────────────────────────────────────────────────
function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: CORS_HEADERS,
  });
}
