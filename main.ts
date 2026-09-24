const RELAY_SECRET = (Deno.env.get("RELAY_SECRET") ?? "").trim();
const DISCORD_API = "https://discord.com";
const DISCORD_GATEWAY = "wss://gateway.discord.gg/";

const activeSockets = new Set<WebSocket>();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data, null, 2) + "\n", {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

function safeClose(socket: WebSocket, code = 1000, reason = "") {
  try {
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close(code, reason.slice(0, 123));
    }
  } catch {
    // Ignore duplicate/late closes.
  }
}

function cleanHeaders(input: Headers): Headers {
  const headers = new Headers(input);
  for (const name of [
    "host",
    "connection",
    "content-length",
    "x-forwarded-for",
    "x-forwarded-host",
    "x-forwarded-proto",
    "x-real-ip",
    "cf-connecting-ip",
    "cf-ipcountry",
    "cf-ray",
  ]) {
    headers.delete(name);
  }
  return headers;
}

async function proxyDiscordRest(request: Request, url: URL, path: string): Promise<Response> {
  const upstream = new URL(path + url.search, DISCORD_API);
  const upstreamHeaders = cleanHeaders(request.headers);
  upstreamHeaders.set("accept-encoding", "identity");

  const init: RequestInit = {
    method: request.method,
    headers: upstreamHeaders,
    redirect: "manual",
  };

  if (request.method !== "GET" && request.method !== "HEAD") {
    init.body = request.body;
  }

  try {
    const response = await fetch(upstream, init);
    const body = await response.arrayBuffer();
    const headers = new Headers(response.headers);
    for (const name of [
      "content-encoding",
      "content-length",
      "transfer-encoding",
      "connection",
    ]) {
      headers.delete(name);
    }

    return new Response(body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  } catch (error) {
    console.error("REST proxy error", error);
    return json({ ok: false, error: `REST proxy failed: ${error}` }, 502);
  }
}

function proxyDiscordGateway(request: Request, url: URL): Response {
  if ((request.headers.get("upgrade") ?? "").toLowerCase() !== "websocket") {
    return json({ ok: false, error: "Expected a WebSocket upgrade" }, 426);
  }

  const { socket: client, response } = Deno.upgradeWebSocket(request, {
    idleTimeout: 0,
  });

  const upstreamUrl = new URL(DISCORD_GATEWAY);
  upstreamUrl.search = url.search;
  const upstream = new WebSocket(upstreamUrl.toString());

  upstream.binaryType = "arraybuffer";
  client.binaryType = "arraybuffer";

  activeSockets.add(client);
  activeSockets.add(upstream);

  let clientOpen = false;
  let upstreamOpen = false;
  const pendingToUpstream: (string | ArrayBuffer | Blob)[] = [];
  const pendingToClient: (string | ArrayBuffer | Blob)[] = [];

  client.onopen = () => {
    clientOpen = true;
    for (const message of pendingToClient.splice(0)) client.send(message);
  };

  upstream.onopen = () => {
    upstreamOpen = true;
    for (const message of pendingToUpstream.splice(0)) upstream.send(message);
  };

  client.onmessage = (event) => {
    if (upstreamOpen && upstream.readyState === WebSocket.OPEN) {
      upstream.send(event.data);
    } else {
      pendingToUpstream.push(event.data);
    }
  };

  upstream.onmessage = (event) => {
    if (clientOpen && client.readyState === WebSocket.OPEN) {
      client.send(event.data);
    } else {
      pendingToClient.push(event.data);
    }
  };

  client.onerror = (event) => {
    console.error("Client WebSocket error", event);
    safeClose(upstream, 1011, "client websocket error");
  };

  upstream.onerror = (event) => {
    console.error("Discord Gateway WebSocket error", event);
    safeClose(client, 1011, "upstream websocket error");
  };

  client.onclose = (event) => {
    activeSockets.delete(client);
    safeClose(upstream, event.code || 1000, event.reason || "client closed");
  };

  upstream.onclose = (event) => {
    activeSockets.delete(upstream);
    safeClose(client, event.code || 1000, event.reason || "discord closed");
  };

  return response;
}

async function handler(request: Request): Promise<Response> {
  const url = new URL(request.url);

  if (url.pathname === "/") {
    return json({
      ok: true,
      service: "discord-deno-relay",
      secret_configured: RELAY_SECRET.length > 0,
      runtime: "deno",
      active_websockets: activeSockets.size,
    });
  }

  if (url.pathname === "/test-discord") {
    const started = performance.now();
    try {
      const response = await fetch("https://discord.com/api/v10/gateway", {
        headers: {
          "user-agent": "RocketWatchRelay/1.0",
          "accept-encoding": "identity",
        },
      });
      const body = await response.text();
      return json({
        ok: response.ok,
        status: response.status,
        elapsed_ms: Math.round(performance.now() - started),
        body: body.slice(0, 500),
        active_websockets: activeSockets.size,
      }, response.ok ? 200 : 502);
    } catch (error) {
      return json({
        ok: false,
        elapsed_ms: Math.round(performance.now() - started),
        error: String(error),
        active_websockets: activeSockets.size,
      }, 502);
    }
  }

  if (!RELAY_SECRET) {
    return json({ ok: false, error: "RELAY_SECRET is not configured" }, 500);
  }

  const prefix = `/p/${RELAY_SECRET}`;
  if (!url.pathname.startsWith(prefix + "/")) {
    return json({ ok: false, error: "Not found" }, 404);
  }

  const path = url.pathname.slice(prefix.length);

  if (path === "/gateway" || path === "/gateway/") {
    return proxyDiscordGateway(request, url);
  }

  if (path.startsWith("/api/")) {
    return await proxyDiscordRest(request, url, path);
  }

  return json({ ok: false, error: "Not found" }, 404);
}

// Deno Deploy can evict a healthy instance even while a WebSocket is open.
// Close sockets explicitly on SIGINT so clients reconnect to a fresh instance
// instead of lingering on a dead relay session.
Deno.addSignalListener("SIGINT", () => {
  console.log(`SIGINT received; closing ${activeSockets.size} WebSocket(s) for reconnect`);
  for (const socket of Array.from(activeSockets)) {
    safeClose(socket, 1012, "relay instance restarting");
  }
  activeSockets.clear();
});

Deno.serve(handler);
