import { test, expect, beforeEach } from "bun:test";
import { rm } from "node:fs/promises";
import { join } from "node:path";
import {
  createAgentMessageStore,
  DEFAULT_AGENT_MESSAGE_CONFIG,
  AGENT_MESSAGE_SYSTEM,
  wrapAgentMessage,
  type AgentSessionBinding,
  type AgentPromptTarget,
  type AgentMessageDeliveryResult,
} from "./agent-message.js";

function fakePromptTarget(calls: { text: string; system?: string }[]): AgentPromptTarget {
  return async (
    _workspace: unknown,
    _sessionId: string,
    input: { text: string; system?: string },
  ) => {
    calls.push(input);
    return "";
  };
}

const FAKE_WORKSPACE = { id: "ws1", path: "/tmp/test" } as any;

function binding(key: string, session: string, role: "coordinator" | "worker" = "worker", engineId = "opencode"): AgentSessionBinding {
  return { agentKey: key, sessionId: session, engineId, role };
}

function assertDelivered(res: AgentMessageDeliveryResult): asserts res is Extract<AgentMessageDeliveryResult, { delivered: true }> {
  if (!res.delivered) throw new Error(`Expected delivered but got: ${res.reason}`);
}

function assertRejected(res: AgentMessageDeliveryResult): asserts res is Extract<AgentMessageDeliveryResult, { delivered: false }> {
  if (res.delivered) throw new Error(`Expected rejection but got delivered`);
}

let store: ReturnType<typeof createAgentMessageStore>;
let promptCalls: { text: string; system?: string }[];
let promptTarget: AgentPromptTarget;

beforeEach(() => {
  store = createAgentMessageStore();
  promptCalls = [];
  promptTarget = fakePromptTarget(promptCalls);
});

// ─── registerAgent / listAgents / findAgentBySession ────────────────────────

test("registerAgent and listAgents", () => {
  store.registerAgent("ws1", binding("a", "s1"));
  store.registerAgent("ws1", binding("b", "s2"));
  const list = store.listAgents("ws1");
  expect(list).toHaveLength(2);
  expect(list.map((b) => b.agentKey)).toContain("a");
  expect(list.map((b) => b.agentKey)).toContain("b");
});

test("findAgentBySession returns the binding", () => {
  store.registerAgent("ws1", binding("coord", "ses_x"));
  const found = store.findAgentBySession("ws1", "ses_x");
  expect(found).toBeDefined();
  expect(found!.agentKey).toBe("coord");
});

test("findAgentBySession returns undefined for unknown session", () => {
  expect(store.findAgentBySession("ws1", "ses_missing")).toBeUndefined();
});

// ─── deliver success path ───────────────────────────────────────────────────

test("deliver succeeds with coordinator->worker", async () => {
  store.registerAgent("ws1", binding("coord", "s_coord", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s_w1"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "coord",
    toAgent: "w1",
    body: "hello",
  }, promptTarget);
  assertDelivered(res);
  expect(res.ok).toBe(true);
  expect(res.targetSessionId).toBe("s_w1");
  expect(res.depth).toBe(1);
  expect(res.budgetUsed).toBe(1);
  expect(res.truncated).toBe(false);
  expect(promptCalls).toHaveLength(1);
  expect(promptCalls[0].text).toContain("<inter-agent-message");
  expect(promptCalls[0].text).toContain('from="coord"');
  expect(promptCalls[0].text).toContain('to="w1"');
  expect(promptCalls[0].text).toContain("hello");
  expect(promptCalls[0].system).toBe(AGENT_MESSAGE_SYSTEM);
});

test("traceId is preserved when supplied", async () => {
  store.registerAgent("ws1", binding("coord", "s1", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s2"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "coord",
    toAgent: "w1",
    body: "msg",
    traceId: "my_trace_123",
  }, promptTarget);
  assertDelivered(res);
  expect(res.traceId).toBe("my_trace_123");
});

// ─── self_message ────────────────────────────────────────────────────────────

test("self_message rejected", async () => {
  store.registerAgent("ws1", binding("a", "s1"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "a",
    toAgent: "a",
    body: "self",
  }, promptTarget);
  assertRejected(res);
  expect(res.reason).toBe("self_message");
  expect(promptCalls).toHaveLength(0);
});

// ─── unknown_agent ──────────────────────────────────────────────────────────

test("unknown fromAgent rejected", async () => {
  store.registerAgent("ws1", binding("a", "s1"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "unknown",
    toAgent: "a",
    body: "x",
  }, promptTarget);
  assertRejected(res);
  expect(res.reason).toBe("unknown_agent");
  expect(promptCalls).toHaveLength(0);
});

test("unknown toAgent rejected", async () => {
  store.registerAgent("ws1", binding("a", "s1"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "a",
    toAgent: "unknown",
    body: "x",
  }, promptTarget);
  assertRejected(res);
  expect(res.reason).toBe("unknown_agent");
  expect(promptCalls).toHaveLength(0);
});

// ─── engine_mismatch ────────────────────────────────────────────────────────

test("engine_mismatch rejected when sameEngineOnly=true", async () => {
  store.registerAgent("ws1", binding("a", "s1", "worker", "opencode"));
  store.registerAgent("ws1", binding("b", "s2", "worker", "codex"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "a",
    toAgent: "b",
    body: "x",
  }, promptTarget);
  assertRejected(res);
  expect(res.reason).toBe("engine_mismatch");
  expect(promptCalls).toHaveLength(0);
});

// ─── topology ────────────────────────────────────────────────────────────────

test("worker->coordinator allowed (report up)", async () => {
  store.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s_w1"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "w1",
    toAgent: "coord",
    body: "report",
  }, promptTarget);
  assertDelivered(res);
  expect(res.ok).toBe(true);
  expect(res.delivered).toBe(true);
});

test("worker->worker first message rejected (topology_denied)", async () => {
  store.registerAgent("ws1", binding("w1", "s1"));
  store.registerAgent("ws1", binding("w2", "s2"));
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "w1",
    toAgent: "w2",
    body: "x",
  }, promptTarget);
  assertRejected(res);
  expect(res.reason).toBe("topology_denied");
});

test("worker->worker reply allowed after coordinator opens exchange", async () => {
  store.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s1"));
  store.registerAgent("ws1", binding("w2", "s2"));
  // Coordinator initiates: coord -> w1
  await store.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "hi" }, promptTarget);
  // w1 replies to coord (allowed: worker->coordinator)
  let res = await store.deliver(FAKE_WORKSPACE, { fromAgent: "w1", toAgent: "coord", body: "reply" }, promptTarget);
  assertDelivered(res);
  // w1 -> w2: now ALLOWED (first exchange on activated pair)
  res = await store.deliver(FAKE_WORKSPACE, { fromAgent: "w1", toAgent: "w2", body: "x" }, promptTarget);
  assertDelivered(res);
  // w2 -> w1: reply allowed
  res = await store.deliver(FAKE_WORKSPACE, { fromAgent: "w2", toAgent: "w1", body: "y" }, promptTarget);
  assertDelivered(res);
  // w1 -> w2 again: exceeds workerExchangeLimit (2nd worker msg on this pair)
  res = await store.deliver(FAKE_WORKSPACE, { fromAgent: "w1", toAgent: "w2", body: "z" }, promptTarget);
  assertRejected(res);
  expect(res.reason).toBe("topology_denied");
});

test("worker->worker second exchange allowed after coordinator opens each pair", async () => {
  store.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s1"));
  store.registerAgent("ws1", binding("w2", "s2"));
  // Coordinator opens w1↔w2 exchange by sending to w1 first
  await store.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "open" }, promptTarget);
  // w1 -> w2: first exchange on activated pair → allowed
  let res = await store.deliver(FAKE_WORKSPACE, { fromAgent: "w1", toAgent: "w2", body: "x" }, promptTarget);
  assertDelivered(res);
  // w2 -> w1: reply → allowed
  res = await store.deliver(FAKE_WORKSPACE, { fromAgent: "w2", toAgent: "w1", body: "reply" }, promptTarget);
  assertDelivered(res);
});

// ─── depth_exceeded ─────────────────────────────────────────────────────────

test("depth_exceeded after maxPairDepth messages", async () => {
  store.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s1"));
  // Send 3 messages (maxPairDepth=3)
  for (let i = 0; i < 3; i++) {
    const res = await store.deliver(FAKE_WORKSPACE, {
      fromAgent: "coord",
      toAgent: "w1",
      body: `msg${i}`,
    }, promptTarget);
    assertDelivered(res);
  }
  // 4th message should exceed
  const res = await store.deliver(FAKE_WORKSPACE, {
    fromAgent: "coord",
    toAgent: "w1",
    body: "msg3",
  }, promptTarget);
  assertRejected(res);
  expect(res.reason).toBe("depth_exceeded");
  // counters should NOT have been incremented for the rejected call
  expect(promptCalls).toHaveLength(3);
});

// ─── budget_exceeded ────────────────────────────────────────────────────────

test("budget_exceeded after workspaceBudget messages + frozen", async () => {
  // Use a store with budget=2 for this test
  const smallStore = createAgentMessageStore({ ...DEFAULT_AGENT_MESSAGE_CONFIG, workspaceBudget: 2 });
  smallStore.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  smallStore.registerAgent("ws1", binding("w1", "s1"));
  const r1 = await smallStore.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "a" }, promptTarget);
  const r2 = await smallStore.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "b" }, promptTarget);
  assertDelivered(r1);
  assertDelivered(r2);
  const r3 = await smallStore.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "c" }, promptTarget);
  assertRejected(r3);
  expect(r3.reason).toBe("budget_exceeded");
  expect(r3.frozen).toBe(true);
  // promptCalls should be 2 (the two successful ones)
  expect(promptCalls).toHaveLength(2);
});

// ─── truncation ─────────────────────────────────────────────────────────────

test("truncation when body exceeds maxMessageTokens", async () => {
  const smallStore = createAgentMessageStore({ ...DEFAULT_AGENT_MESSAGE_CONFIG, maxMessageTokens: 10 });
  store = smallStore;
  store.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s1"));
  const longBody = "x".repeat(100);
  const res = await store.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: longBody }, promptTarget);
  assertDelivered(res);
  expect(res.truncated).toBe(true);
  expect(promptCalls[0].text).toContain("[truncated]");
});

// ─── trace ──────────────────────────────────────────────────────────────────

test("trace returns entries in order", async () => {
  store.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s1"));
  await store.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "a" }, promptTarget);
  await store.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "b" }, promptTarget);
  const trace = store.trace("ws1");
  expect(trace).toHaveLength(2);
  expect(trace[0].fromAgent).toBe("coord");
  expect(trace[1].fromAgent).toBe("coord");
});

test("trace capped at 200", async () => {
  const bigStore = createAgentMessageStore({ ...DEFAULT_AGENT_MESSAGE_CONFIG, maxPairDepth: 300, workspaceBudget: 300 });
  bigStore.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  bigStore.registerAgent("ws1", binding("w1", "s1"));
  for (let i = 0; i < 205; i++) {
    const r = await bigStore.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: `m${i}` }, promptTarget);
    assertDelivered(r);
  }
  expect(bigStore.trace("ws1")).toHaveLength(200);
});

// ─── promptTarget failure does not increment counters ───────────────────────

test("promptTarget error leaves counters unchanged", async () => {
  const freshStore = createAgentMessageStore();
  freshStore.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  freshStore.registerAgent("ws1", binding("w1", "s1"));
  const badTarget: AgentPromptTarget = async () => { throw new Error("boom"); };
  await expect(
    freshStore.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "x" }, badTarget),
  ).rejects.toThrow("boom");
  // Second call should still be depth=1 (first wasn't counted)
  const res = await freshStore.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "y" }, promptTarget);
  assertDelivered(res);
  expect(res.depth).toBe(1);
  expect(res.budgetUsed).toBe(1);
});

// ─── _clearWorkspace ────────────────────────────────────────────────────────

test("_clearWorkspace removes all state", async () => {
  store.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
  store.registerAgent("ws1", binding("w1", "s1"));
  await store.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "x" }, promptTarget);
  store._clearWorkspace("ws1");
  expect(store.listAgents("ws1")).toHaveLength(0);
  expect(store.trace("ws1")).toHaveLength(0);
});

// ─── persistence ─────────────────────────────────────────────────────────────

test("persistence: agents survive across store instances", async () => {
  const tmp = await import("node:os").then(m => m.tmpdir());
  const dbPath = join(tmp, `amg_persist_test_${Date.now()}.sqlite`);
  try {
    const store1 = createAgentMessageStore(DEFAULT_AGENT_MESSAGE_CONFIG, { dbPath });
    store1.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
    store1.registerAgent("ws1", binding("w1", "s1"));
    // Wait for DB init + saves
    await store1.ready;
    await new Promise(r => setTimeout(r, 50));

    // Create a new store pointing to the same DB
    const store2 = createAgentMessageStore(DEFAULT_AGENT_MESSAGE_CONFIG, { dbPath });
    await store2.ready;
    await new Promise(r => setTimeout(r, 50));

    // store2 should have loaded the agents
    const agents = store2.listAgents("ws1");
    expect(agents).toHaveLength(2);
    expect(agents.map(a => a.agentKey)).toContain("coord");
    expect(agents.map(a => a.agentKey)).toContain("w1");
  } finally {
    try { await rm(dbPath, { force: true }); } catch { /* ignore */ }
  }
});

test("persistence: traces survive across store instances", async () => {
  const tmp = await import("node:os").then(m => m.tmpdir());
  const dbPath = join(tmp, `amg_persist_trace_test_${Date.now()}.sqlite`);
  try {
    const store1 = createAgentMessageStore(DEFAULT_AGENT_MESSAGE_CONFIG, { dbPath });
    store1.registerAgent("ws1", binding("coord", "s_c", "coordinator"));
    store1.registerAgent("ws1", binding("w1", "s1"));
    await store1.deliver(FAKE_WORKSPACE, { fromAgent: "coord", toAgent: "w1", body: "hello" }, promptTarget);
    // Wait for DB init + deliver + save
    await store1.ready;
    await new Promise(r => setTimeout(r, 50));

    const store2 = createAgentMessageStore(DEFAULT_AGENT_MESSAGE_CONFIG, { dbPath });
    await store2.ready;
    await new Promise(r => setTimeout(r, 50));

    const trace = store2.trace("ws1");
    expect(trace).toHaveLength(1);
    expect(trace[0].fromAgent).toBe("coord");
    expect(trace[0].toAgent).toBe("w1");
  } finally {
    try { await rm(dbPath, { force: true }); } catch { /* ignore */ }
  }
});
