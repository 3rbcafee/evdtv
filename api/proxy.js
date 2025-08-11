// api/proxy.js
// Vercel Node.js Serverless function — proxy + CORS for HLS
// NOTE: set UPSTREAM_HOST / UPSTREAM_USER / UPSTREAM_PASS in Vercel env vars.

export default async function handler(req, res) {
  const CORS = {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
    "Access-Control-Allow-Headers": "*"
  };

  // OPTIONS preflight
  if (req.method === "OPTIONS") {
    for (const k in CORS) res.setHeader(k, CORS[k]);
    res.statusCode = 204;
    res.end();
    return;
  }

  // helper to read query
  const fullUrl = new URL(req.url, `https://${req.headers.host}`);
  const params = fullUrl.searchParams;

  // env / defaults
  const UPSTREAM_HOST = process.env.UPSTREAM_HOST || "http://spider-tv.co:80";
  const UPSTREAM_USER = process.env.UPSTREAM_USER || "052802294";
  const UPSTREAM_PASS = process.env.UPSTREAM_PASS || "796089039472";

  // simple VLC-like headers (you can tweak)
  const upstreamHeaders = {
    "User-Agent": process.env.USER_AGENT || "VLC/3.0.20 LibVLC/3.0.20",
    "Referer": process.env.REFERER || ""
  };

  // Helper: write CORS headers
  function attachCors(target) {
    for (const k in CORS) target.setHeader(k, CORS[k]);
  }

  // ---------- Resource proxy (segments or absolute URLs) ----------
  // Accept: /resource?url=<absolute>  OR /resource?channel=39985&uri=path/to/seg.ts
  if (fullUrl.pathname === "/resource" || params.has("url") || (params.has("channel") && params.has("uri"))) {
    let target;
    if (params.has("url")) {
      target = params.get("url");
    } else if (params.has("channel") && params.has("uri")) {
      const channel = params.get("channel');
      const uri = params.get("uri");
      // uri is expected encoded (vercel rewrite will preserve it)
      target = `${UPSTREAM_HOST}/live/${UPSTREAM_USER}/${UPSTREAM_PASS}/${channel}/${uri}`;
    } else {
      res.statusCode = 400;
      attachCors(res);
      res.end("Bad resource request");
      return;
    }

    try {
      const upstreamRes = await fetch(target, { headers: upstreamHeaders });
      if (!upstreamRes.ok) {
        const txt = await upstreamRes.text().catch(() => "");
        res.statusCode = upstreamRes.status;
        attachCors(res);
        res.setHeader("Content-Type", "text/plain");
        res.end(txt || `Upstream ${upstreamRes.status}`);
        return;
      }

      // forward some headers and CORS
      const contentType = upstreamRes.headers.get("content-type") || "";
      if (contentType) res.setHeader("Content-Type", contentType);
      attachCors(res);

      // stream upstream body to client in chunks
      const reader = upstreamRes.body.getReader();
      res.statusCode = upstreamRes.status;
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        // value is a Uint8Array
        res.write(Buffer.from(value));
      }
      res.end();
      return;
    } catch (err) {
      console.error("resource error:", err);
      res.statusCode = 500;
      attachCors(res);
      res.end("Internal proxy error");
      return;
    }
  }

  // ---------- Playlist handler ----------
  // We expect a rewrite to call /api/proxy?channel=39985 when URL is /39985.m3u8
  const channel = params.get("channel");
  if (channel) {
    try {
      const upstreamUrl = `${UPSTREAM_HOST}/live/${UPSTREAM_USER}/${UPSTREAM_PASS}/${channel}.m3u8`;
      const upstreamRes = await fetch(upstreamUrl, { headers: upstreamHeaders });

      if (!upstreamRes.ok) {
        const txt = await upstreamRes.text().catch(() => "");
        res.statusCode = upstreamRes.status;
        attachCors(res);
        res.setHeader("Content-Type", "text/plain");
        res.end(txt || `Upstream ${upstreamRes.status}`);
        return;
      }

      const text = await upstreamRes.text();
      // build origin (public URL) so segments point back to us
      const proto = req.headers["x-forwarded-proto"] || "https";
      const origin = `${proto}://${req.headers.host}`;

      const rewritten = text.split(/\r?\n/).map(line => {
        if (!line || line.startsWith("#")) return line;
        if (/^https?:\/\//i.test(line)) {
          return `${origin}/resource?url=${encodeURIComponent(line)}`;
        } else {
          // relative segment -> proxy with channel+uri
          return `${origin}/resource?channel=${encodeURIComponent(channel)}&uri=${encodeURIComponent(line)}`;
        }
      }).join("\n");

      attachCors(res);
      res.setHeader("Content-Type", "application/vnd.apple.mpegurl; charset=utf-8");
      res.end(rewritten);
      return;
    } catch (err) {
      console.error("playlist error:", err);
      res.statusCode = 500;
      attachCors(res);
      res.end("Internal proxy error");
      return;
    }
  }

  // default
  attachCors(res);
  res.statusCode = 404;
  res.end("Not found");
}
