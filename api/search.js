// Vercel Serverless Function: POST /api/search
//
// Uses the Gemini API (grounded with Google Search) to discover real clothing
// items matching a shopper's query, and returns them as structured JSON.
//
// SETUP (required for live results):
//   1. Get a key at https://aistudio.google.com/apikey
//   2. In Vercel: Project -> Settings -> Environment Variables
//        GEMINI_API_KEY = <your key>
//        GEMINI_MODEL   = gemini-3.5-flash        (optional override)
//   3. Redeploy.
//
// The key lives ONLY here, server-side. Never put it in index.html — anything
// in the browser bundle is public.
//
// If the key is absent this returns 503 and the frontend falls back to its
// local demo catalog, so the demo still works unconfigured.

const MODEL = process.env.GEMINI_MODEL || 'gemini-3.5-flash';

const RESPONSE_SHAPE = `Return ONLY a JSON array (no markdown fences, no prose). Each element:
{
  "name":   "product name as the retailer lists it",
  "brand":  "retailer or brand name",
  "price":  "price with currency symbol, e.g. $24.00",
  "color":  "the item's color name",
  "hex":    "#RRGGBB approximating that color",
  "url":    "a working link to the product, or the retailer's search page for this item",
  "why":    "under 12 words on why it matches"
}`;

function buildPrompt({ query, count, colorSensitive, hex, mode }) {
  const lines = [
    `A shopper is looking for clothing. Find ${count} real, currently-purchasable items that match.`,
    '',
    mode === 'draw'
      ? `They sketched a garment shape rather than typing. Sketch description: ${query}`
      : `Their request (may be in any language — interpret it, then search in the appropriate language): "${query}"`,
  ];

  if (colorSensitive && hex) {
    lines.push('', `COLOR IS CRITICAL: only return items whose color is within a few shades of ${hex}. Set "hex" to each item's true color so closeness can be verified.`);
  }

  lines.push(
    '',
    'Rules:',
    '- Use Google Search to ground every item in a real listing. Do not invent products.',
    '- Prefer mainstream retailers (Aritzia, Zara, Urban Outfitters, Nordstrom, Madewell, ASOS, Free People, Abercrombie, H&M, Revolve, Shein, Lulus, Princess Polly, Edikted, etc.).',
    '- If you cannot verify a direct product URL, use the retailer\'s search URL for that item name instead of guessing a product path.',
    '- Order by how well each matches the request, best first.',
    '- Vary brands and price points.',
    '',
    RESPONSE_SHAPE
  );

  return lines.join('\n');
}

function extractJson(text) {
  if (!text) return null;
  let t = text.trim().replace(/^```(?:json)?/i, '').replace(/```$/, '').trim();
  const start = t.indexOf('[');
  const end = t.lastIndexOf(']');
  if (start === -1 || end === -1 || end < start) return null;
  try {
    return JSON.parse(t.slice(start, end + 1));
  } catch {
    return null;
  }
}

function sanitize(items, count) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it) => it && typeof it === 'object' && it.name)
    .slice(0, count)
    .map((it) => {
      const hex = typeof it.hex === 'string' && /^#[0-9a-f]{6}$/i.test(it.hex.trim())
        ? it.hex.trim()
        : '#CCCCCC';
      let url = typeof it.url === 'string' ? it.url.trim() : '';
      if (!/^https?:\/\//i.test(url)) url = '';
      return {
        name: String(it.name).slice(0, 140),
        brand: String(it.brand || 'Unknown').slice(0, 60),
        price: String(it.price || '—').slice(0, 24),
        color: String(it.color || '').slice(0, 40),
        hex,
        url,
        why: String(it.why || '').slice(0, 90),
      };
    });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: 'Use POST.' });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) {
    return res.status(503).json({
      error: 'not_configured',
      message: 'GEMINI_API_KEY is not set on this deployment.',
    });
  }

  const body = typeof req.body === 'string' ? JSON.parse(req.body || '{}') : (req.body || {});
  const query = String(body.query || '').slice(0, 500).trim();
  const count = Math.min(Math.max(parseInt(body.count, 10) || 10, 1), 30);
  const mode = body.mode === 'draw' ? 'draw' : 'text';
  const colorSensitive = Boolean(body.colorSensitive);
  const hex = typeof body.hex === 'string' ? body.hex : null;

  if (!query) return res.status(400).json({ error: 'Empty query.' });

  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${MODEL}:generateContent`;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 55000);

    const gRes = await fetch(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-goog-api-key': apiKey,
      },
      signal: controller.signal,
      body: JSON.stringify({
        contents: [
          { role: 'user', parts: [{ text: buildPrompt({ query, count, colorSensitive, hex, mode }) }] },
        ],
        tools: [{ google_search: {} }],
        generationConfig: { temperature: 0.3 },
      }),
    });

    clearTimeout(timeout);

    if (!gRes.ok) {
      const detail = await gRes.text();
      console.error('Gemini error', gRes.status, detail.slice(0, 500));
      return res.status(502).json({
        error: 'upstream_failed',
        status: gRes.status,
        message: 'The Gemini API rejected the request.',
      });
    }

    const data = await gRes.json();
    const text = (data?.candidates?.[0]?.content?.parts || [])
      .map((p) => p.text || '')
      .join('');

    const items = sanitize(extractJson(text), count);

    if (!items.length) {
      return res.status(502).json({ error: 'unparseable', message: 'Model returned no usable items.' });
    }

    res.setHeader('Cache-Control', 's-maxage=300, stale-while-revalidate=600');
    return res.status(200).json({ items, source: 'gemini', model: MODEL });
  } catch (err) {
    console.error('search handler failed', err);
    const aborted = err && err.name === 'AbortError';
    return res.status(aborted ? 504 : 500).json({
      error: aborted ? 'timeout' : 'server_error',
      message: aborted ? 'Search timed out.' : 'Search failed.',
    });
  }
}
