// cony-relay — tiny Cloudflare Worker between the Mac and the phone.
// The Mac POSTs the current ping list here on every refresh; the phone
// GETs it over plain HTTPS from anywhere — no Tailscale required.
//
// POST /push   x-push-key: <PUSH_KEY>   body: {"pings":[...]}
// GET  /items  x-app-key:  <APP_KEY>    -> {"pushed_at": ISO, "pings":[...]}
// GET  /health                          -> {"ok":true}

const json = (code, obj) =>
  new Response(JSON.stringify(obj), {
    status: code,
    headers: { "content-type": "application/json" },
  });

export default {
  async fetch(req, env) {
    const url = new URL(req.url);

    if (req.method === "GET" && url.pathname === "/health") {
      return json(200, { ok: true });
    }

    if (req.method === "POST" && url.pathname === "/push") {
      if (!env.PUSH_KEY || req.headers.get("x-push-key") !== env.PUSH_KEY) {
        return json(401, { error: "bad key" });
      }
      const body = await req.text();
      if (body.length > 512_000) return json(413, { error: "too big" });
      let parsed;
      try {
        parsed = JSON.parse(body);
      } catch {
        return json(400, { error: "not json" });
      }
      const doc = { pushed_at: new Date().toISOString(), ...parsed };
      await env.CONY_KV.put("items", JSON.stringify(doc));
      return json(200, { ok: true, pings: (parsed.pings || []).length });
    }

    if (req.method === "GET" && url.pathname === "/items") {
      const key = req.headers.get("x-app-key") || url.searchParams.get("key");
      if (!env.APP_KEY || key !== env.APP_KEY) {
        return json(401, { error: "bad key" });
      }
      const doc = await env.CONY_KV.get("items");
      if (!doc) return json(404, { error: "nothing pushed yet" });
      return new Response(doc, {
        headers: { "content-type": "application/json" },
      });
    }

    return json(404, { error: "not found" });
  },
};
