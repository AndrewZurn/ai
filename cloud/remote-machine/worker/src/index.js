const API = "https://api.hetzner.cloud/v1";
const ZONE = "America/Los_Angeles";

export default {
  async fetch(request, env) {
    try {
      if (!(await authorized(request, env))) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "WWW-Authenticate": 'Basic realm="remote-devbox"' },
        });
      }

      const path = new URL(request.url).pathname;
      if (path === "/status" && request.method === "GET") return json(await status(env));
      if (request.method !== "POST" || !["/start", "/stop"].includes(path)) {
        return json({ error: "Use GET /status or POST /start and /stop" }, 405);
      }
      return json(path === "/start" ? await start(env) : await stop(env), 202);
    } catch (error) {
      console.error(JSON.stringify({ message: "request failed", error: String(error) }));
      return json({ error: "Internal server error" }, 500);
    }
  },

  async scheduled(controller, env) {
    if (await reconcile(env)) return;
    const parts = new Intl.DateTimeFormat("en-US", {
      timeZone: ZONE,
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    }).formatToParts(new Date(controller.scheduledTime));
    const local = Object.fromEntries(parts.map(({ type, value }) => [type, value]));

    if (local.hour === "22" && local.minute === "00") return stop(env);
    if (local.minute === "00") return stopIfIdle(env);
    return undefined;
  },
};

async function authorized(request, env) {
  const value = request.headers.get("Authorization") || "";
  if (!value.startsWith("Basic ")) return false;
  const decoded = atob(value.slice(6));
  const separator = decoded.indexOf(":");
  return separator >= 0 &&
    constantTime(decoded.slice(0, separator), env.BASIC_AUTH_USERNAME) &&
    constantTime(decoded.slice(separator + 1), env.BASIC_AUTH_PASSWORD);
}

function constantTime(left, right) {
  if (typeof right !== "string") return false;
  const a = new TextEncoder().encode(left);
  const b = new TextEncoder().encode(right);
  let result = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    result |= (a[i % (a.length || 1)] || 0) ^ (b[i % (b.length || 1)] || 0);
  }
  return result === 0;
}

async function doRequest(env, path, options = {}) {
  const { ignoreNotFound = false, ...requestOptions } = options;
  const response = await fetch(`${API}${path}`, {
    ...requestOptions,
    headers: {
      Authorization: `Bearer ${env.HETZNER_TOKEN}`,
      "Content-Type": "application/json",
      ...(requestOptions.headers || {}),
    },
  });
  const body = await response.json();
  if (!response.ok) {
    if (ignoreNotFound && response.status === 404) return null;
    const method = requestOptions.method || "GET";
    throw new Error(`Hetzner ${method} ${path} ${response.status}: ${JSON.stringify(body)}`);
  }
  return body;
}

async function findServer(env) {
  const body = await doRequest(env, `/servers?label_selector=role=${encodeURIComponent(env.SERVER_LABEL)}&per_page=100`);
  return body.servers?.[0] || null;
}

async function start(env) {
  if (await reconcile(env)) return { state: "finishing_previous_stop" };
  const server = await findServer(env);
  if (server) return { state: server.status, server_id: server.id, ip: server.public_net?.ipv4?.ip };

  const snapshot = await latestSnapshot(env);
  if (!snapshot) {
    return { state: "missing_snapshot", message: "The initial NixOS server must be stopped once to create a snapshot" };
  }

  const body = await doRequest(env, "/servers", {
    method: "POST",
    body: JSON.stringify({
      name: env.SERVER_NAME,
      server_type: env.SERVER_TYPE,
      location: env.LOCATION,
      image: snapshot.id,
      labels: { role: env.SERVER_LABEL },
      start_after_create: true,
      public_net: { ipv4: Number(env.PRIMARY_IP_ID), enable_ipv6: true },
    }),
  });
  return { state: "creating", server_id: body.server.id, snapshot_id: snapshot.id };
}

async function stopIfIdle(env) {
  const server = await findServer(env);
  if (!server || server.status !== "running") return { state: server?.status || "absent" };

  const end = new Date();
  const start = new Date(end.getTime() - Number(env.IDLE_MINUTES) * 60_000);
  const metrics = await doRequest(env, `/servers/${server.id}/metrics?type=cpu&start=${encodeURIComponent(start.toISOString())}&end=${encodeURIComponent(end.toISOString())}`);
  const values = metrics.metrics?.time_series?.cpu?.values || [];
  if (!values.length) return { state: "running", idle: false, reason: "no CPU metrics" };

  const average = values.reduce((total, value) => total + Number(value[1]), 0) / values.length;
  if (average < Number(env.IDLE_CPU_PERCENT)) return stop(env);
  return { state: "running", idle: false, cpu_average: average };
}

async function stop(env) {
  const server = await findServer(env);
  if (!server) return { state: "absent" };

  const pending = await env.REMOTE_DEVBOX_STATE.get("pending");
  if (pending) return { state: "snapshotting", ...JSON.parse(pending) };

  const action = await doRequest(env, `/servers/${server.id}/actions/shutdown`, {
    method: "POST",
    body: JSON.stringify({}),
  });
  await env.REMOTE_DEVBOX_STATE.put("pending", JSON.stringify({ phase: "shutdown", server_id: server.id, action_id: action.action.id }));
  return { state: "shutting_down", server_id: server.id, action_id: action.action.id };
}

async function reconcile(env) {
  const pending = await env.REMOTE_DEVBOX_STATE.get("pending", "json");
  if (!pending) return false;

  const body = await doRequest(env, `/actions/${pending.action_id}`);
  if (body.action.status === "running") return true;
  if (body.action.status !== "success") throw new Error(`Snapshot action failed: ${body.action.status}`);

  if (pending.phase === "shutdown") {
    const snapshot = await doRequest(env, `/servers/${pending.server_id}/actions/create_image`, {
      method: "POST",
      ignoreNotFound: true,
      body: JSON.stringify({
        description: `${env.SNAPSHOT_PREFIX}-${Date.now()}`,
        type: "snapshot",
        labels: { "managed-by": "remote-devbox-control" },
      }),
    });
    if (!snapshot) {
      await env.REMOTE_DEVBOX_STATE.delete("pending");
      return false;
    }
    const snapshot_id = snapshot.action.resources?.find((resource) => resource.type === "image")?.id;
    await env.REMOTE_DEVBOX_STATE.put("pending", JSON.stringify({ phase: "snapshot", server_id: pending.server_id, action_id: snapshot.action.id, snapshot_id }));
    return true;
  }

  if (pending.phase === "snapshot" && !(await pruneSnapshots(env, pending.snapshot_id))) return true;

  await doRequest(env, `/servers/${pending.server_id}`, {
    method: "DELETE",
    ignoreNotFound: true,
  });
  await env.REMOTE_DEVBOX_STATE.delete("pending");
  return false;
}

async function latestSnapshot(env) {
  const snapshots = await listSnapshots(env, (image) =>
    image.created_from?.name === env.SERVER_NAME);
  return snapshots[0] || null;
}

async function pruneSnapshots(env, newestSnapshotId) {
  const snapshots = await listSnapshots(env, () => true);

  // Wait for the new image to become visible before pruning older snapshots.
  if (newestSnapshotId && !snapshots.some((snapshot) => snapshot.id === newestSnapshotId)) return false;

  const managedSnapshots = snapshots.filter((snapshot) =>
    snapshot.labels?.["managed-by"] === "remote-devbox-control");
  for (const snapshot of managedSnapshots.slice(2)) {
    await doRequest(env, `/images/${snapshot.id}`, { method: "DELETE" });
  }
  return true;
}

async function listSnapshots(env, matches) {
  const snapshots = [];
  let page = 1;
  let lastPage = 1;

  do {
    const body = await doRequest(env, `/images?type=snapshot&status=available&per_page=100&page=${page}`);
    snapshots.push(...(body.images || []).filter((image) =>
      image.status === "available" && matches(image)));
    lastPage = body.meta?.pagination?.last_page || page;
    page += 1;
  } while (page <= lastPage);

  return snapshots.sort((left, right) =>
    Date.parse(right.created) - Date.parse(left.created) || right.id - left.id);
}

async function status(env) {
  const server = await findServer(env);
  const snapshot = await latestSnapshot(env);
  return {
    server: server ? { id: server.id, status: server.status, ip: server.public_net?.ipv4?.ip } : null,
    latest_snapshot: snapshot ? {
      id: snapshot.id,
      description: snapshot.description,
      created: snapshot.created,
      created_from: snapshot.created_from?.name,
    } : null,
  };
}

function json(body, status = 200) {
  return Response.json(body, { status });
}
