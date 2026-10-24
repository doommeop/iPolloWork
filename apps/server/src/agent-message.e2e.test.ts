import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "./server.js";
import type { ServerConfig } from "./types.js";

const CLIENT_TOKEN = "e2e_client_token";
const HOST_TOKEN = "e2e_host_token";

const roots: string[] = [];
const servers: Awaited<ReturnType<typeof startServer>>[] = [];

async function temporaryRoot(prefix: string): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function serverConfig(workspaceRoot: string): ServerConfig {
  return {
    host: "127.0.0.1",
    port: 0,
    token: CLIENT_TOKEN,
    hostToken: HOST_TOKEN,
    configPath: join(workspaceRoot, "server.json"),
    approval: { mode: "auto", timeoutMs: 0 },
    corsOrigins: [],
    workspaces: [{
      id: "ws_e2e",
      name: "E2E Test",
      path: workspaceRoot,
      preset: "starter",
      workspaceType: "local",
    }],
    authorizedRoots: [workspaceRoot],
    readOnly: false,
    startedAt: Date.now(),
    tokenSource: "generated",
    hostTokenSource: "generated",
    logFormat: "pretty",
    logRequests: false,
  };
}

function clientHeaders() {
  return { authorization: `Bearer ${CLIENT_TOKEN}` };
}

function clientJsonHeaders() {
  return { ...clientHeaders(), "content-type": "application/json" };
}

async function boot() {
  const root = await temporaryRoot("ipollowork-agent-msg-e2e-");
  // Write minimal server config
  await writeFile(
    join(root, "server.json"),
    JSON.stringify({ agents: {} }),
    "utf8",
  );
  const config = serverConfig(root);
  const server = await startServer(config);
  servers.push(server);
  return { base: `http://127.0.0.1:${server.port}`, root, config };
}

afterEach(async () => {
  for (const server of servers) {
    try { await server.stop(); } catch { /* already stopped */ }
  }
  servers.length = 0;
  for (const root of roots) {
    try { await rm(root, { recursive: true, force: true }); } catch { /* already deleted */ }
  }
  roots.length = 0;
});

describe("agent-message routes", () => {
  let base: string;

  beforeEach(async () => {
    const { base: b } = await boot();
    base = b;
  });

  test("POST /workspace/:id/agents registers an agent", async () => {
    const res = await fetch(`${base}/workspace/ws_e2e/agents`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({
        agentKey: "coordinator",
        sessionId: "ses_coord_001",
        role: "coordinator",
      }),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; agents: Array<{ agentKey: string }> };
    expect(json.ok).toBe(true);
    expect(json.agents).toHaveLength(1);
    expect(json.agents[0].agentKey).toBe("coordinator");
  });

  test("POST /workspace/:id/agents rejects missing fields", async () => {
    const res = await fetch(`${base}/workspace/ws_e2e/agents`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({ agentKey: "w1" }), // missing sessionId
    });
    expect(res.status).toBe(400);
  });

  test("GET /workspace/:id/agent-message-trace returns empty initially", async () => {
    const res = await fetch(`${base}/workspace/ws_e2e/agent-message-trace`, {
      headers: clientHeaders(),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { items: unknown[] };
    expect(json.items).toHaveLength(0);
  });

  test("POST /workspace/:id/agent-message rejects unknown agents", async () => {
    const res = await fetch(`${base}/workspace/ws_e2e/agent-message`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({
        fromAgent: "unknown_a",
        toAgent: "unknown_b",
        body: "hello",
      }),
    });
    expect(res.status).toBe(409);
    const json = await res.json() as Record<string, unknown>;
    const message = String(json.message ?? "");
    expect(message).toContain("unknown_agent");
  });

  test("full flow: register agents + deliver message + trace", async () => {
    // Register agents
    const regRes = await fetch(`${base}/workspace/ws_e2e/agents`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({ agentKey: "coord", sessionId: "ses_c", role: "coordinator" }),
    });
    expect(regRes.status).toBe(200);

    const regRes2 = await fetch(`${base}/workspace/ws_e2e/agents`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({ agentKey: "writer", sessionId: "ses_w", role: "worker" }),
    });
    expect(regRes2.status).toBe(200);

    // Deliver message — will fail because session doesn't exist in test env,
    // but the route handler should process it and return a meaningful error
    const msgRes = await fetch(`${base}/workspace/ws_e2e/agent-message`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({
        fromAgent: "coord",
        toAgent: "writer",
        body: "請撰寫文案",
      }),
    });
    // Should not be 4xx from our handler (it's a 5xx from session not found)
    expect(msgRes.status).not.toBe(400);
    expect(msgRes.status).not.toBe(404);
    expect(msgRes.status).not.toBe(409);

    // Check trace endpoint still works
    const traceRes = await fetch(`${base}/workspace/ws_e2e/agent-message-trace`, {
      headers: clientHeaders(),
    });
    expect(traceRes.status).toBe(200);
    const traceJson = await traceRes.json() as { items: unknown[] };
    expect(Array.isArray(traceJson.items)).toBe(true);
  });
});

describe("engine-tools/call: sendAgentMessage", () => {
  let base: string;

  beforeEach(async () => {
    const { base: b } = await boot();
    base = b;
  });

  test("GET /engine-tools lists sendAgentMessage tool", async () => {
    const res = await fetch(`${base}/engine-tools`, {
      headers: clientHeaders(),
    });
    expect(res.status).toBe(200);
    const json = await res.json() as { ok: boolean; tools: Array<{ name: string }> };
    expect(json.ok).toBe(true);
    const names = json.tools.map(t => t.name);
    expect(names).toContain("ipollowork_send_agent_message");
  });

  test("POST /engine-tools/call with sendAgentMessage rejects unregistered session", async () => {
    const res = await fetch(`${base}/engine-tools/call`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({
        name: "ipollowork_send_agent_message",
        args: { targetAgent: "writer", body: "hello" },
        context: { workspaceId: "ws_e2e", sessionId: "ses_unregistered" },
      }),
    });
    expect(res.status).toBe(403);
    const json = await res.json() as { code?: string };
    expect(json.code).toBe("agent_message_source_not_registered");
  });

  test("POST /engine-tools/call with sendAgentMessage rejects missing targetAgent", async () => {
    // First register an agent, then try to call without targetAgent
    await fetch(`${base}/workspace/ws_e2e/agents`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({ agentKey: "coord", sessionId: "ses_c", role: "coordinator" }),
    });

    const res = await fetch(`${base}/engine-tools/call`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({
        name: "ipollowork_send_agent_message",
        args: { body: "hello" }, // missing targetAgent
        context: { workspaceId: "ws_e2e", sessionId: "ses_c" },
      }),
    });
    expect(res.status).toBe(400);
  });

  test("POST /engine-tools/call with unknown tool returns 404", async () => {
    const res = await fetch(`${base}/engine-tools/call`, {
      method: "POST",
      headers: clientJsonHeaders(),
      body: JSON.stringify({
        name: "nonexistent_tool",
        args: {},
        context: { workspaceId: "ws_e2e", sessionId: "ses_c" },
      }),
    });
    expect(res.status).toBe(404);
  });
});
