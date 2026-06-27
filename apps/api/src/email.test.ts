import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "./config.js";
import { registerEmailRoutes, extractEmail } from "./email.js";
import { registerIdentityRoutes } from "./identity.js";

// Minimal config: no RESEND_API_KEY and no OPENAI_API_KEY, so the capability
// runs in mock-send mode with heuristic drafting — fully offline.
const config = {
  PUBLIC_API_URL: "http://localhost:4001",
  EMAIL_FROM_DOMAIN: "agents.barkan.dev"
} as unknown as AppConfig;

async function buildTestApp() {
  const app = Fastify({ logger: false });
  registerEmailRoutes(app, config);
  registerIdentityRoutes(app, config);
  return app;
}

async function initEmailAgent(app: Awaited<ReturnType<typeof buildTestApp>>, requiresApproval = false) {
  const response = await app.inject({
    method: "POST",
    url: "/api/identity/init",
    payload: {
      agent_name: "Ava",
      tools: ["email"],
      permissions: { "email.send": true, requires_human_approval: requiresApproval }
    }
  });
  expect(response.statusCode).toBe(201);
  const body = response.json();
  return { token: body.identity_token as string, agentId: body.agent_id as string, email: body.email as string };
}

describe("extractEmail", () => {
  it("pulls an address out of free text", () => {
    expect(extractEmail("Email john@example.com about the demo")).toBe("john@example.com");
  });
  it("returns null when there is no address", () => {
    expect(extractEmail("Email John about the demo")).toBeNull();
  });
});

describe("email capability routes", () => {
  it("sends an explicit email via the mock provider and logs activity", async () => {
    const app = await buildTestApp();
    const { token, agentId, email } = await initEmailAgent(app);

    const send = await app.inject({
      method: "POST",
      url: "/api/tools/email/send",
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "john@example.com", subject: "Meeting tomorrow", body: "Are you free?" }
    });
    expect(send.statusCode).toBe(201);
    expect(send.json()).toMatchObject({ ok: true, from: email, to: "john@example.com", status: "sent" });

    const activity = await app.inject({
      method: "GET",
      url: `/api/identity/${agentId}/email-activity`,
      headers: { authorization: `Bearer ${token}` }
    });
    expect(activity.statusCode).toBe(200);
    const body = activity.json();
    expect(body.email_identity.provider).toBe("mock");
    expect(body.messages).toHaveLength(1);
    expect(body.messages[0]).toMatchObject({ direction: "outbound", to_email: "john@example.com" });

    await app.close();
  });

  it("drafts and sends from a plain-text request that includes an address", async () => {
    const app = await buildTestApp();
    const { token } = await initEmailAgent(app);

    const request = await app.inject({
      method: "POST",
      url: "/api/tools/email/request",
      headers: { authorization: `Bearer ${token}` },
      payload: { request: "Email sarah@acme.com and ask if she can send the contract today." }
    });
    expect(request.statusCode).toBe(201);
    const body = request.json();
    expect(body.ok).toBe(true);
    expect(body.to).toBe("sarah@acme.com");
    expect(body.parsed.parsed_by).toBe("heuristic");
    expect(body.parsed.body).toContain("Ava");

    await app.close();
  });

  it("asks for a recipient when the request has no address", async () => {
    const app = await buildTestApp();
    const { token } = await initEmailAgent(app);

    const request = await app.inject({
      method: "POST",
      url: "/api/tools/email/request",
      headers: { authorization: `Bearer ${token}` },
      payload: { request: "Email John and ask if he can meet tomorrow." }
    });
    expect(request.statusCode).toBe(422);
    expect(request.json().error).toMatch(/recipient/i);

    await app.close();
  });

  it("blocks sending when human approval is required and not granted", async () => {
    const app = await buildTestApp();
    const { token } = await initEmailAgent(app, true);

    const blocked = await app.inject({
      method: "POST",
      url: "/api/tools/email/send",
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "john@example.com", subject: "Hi", body: "Hello" }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatch(/approval/i);

    const allowed = await app.inject({
      method: "POST",
      url: "/api/tools/email/send",
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "john@example.com", subject: "Hi", body: "Hello", approved: true }
    });
    expect(allowed.statusCode).toBe(201);

    await app.close();
  });

  it("pauses and resumes the email identity", async () => {
    const app = await buildTestApp();
    const { token } = await initEmailAgent(app);

    const paused = await app.inject({ method: "POST", url: "/api/tools/email/pause", headers: { authorization: `Bearer ${token}` } });
    expect(paused.statusCode).toBe(200);
    expect(paused.json().status).toBe("paused");

    const blocked = await app.inject({
      method: "POST",
      url: "/api/tools/email/send",
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "john@example.com", subject: "Hi", body: "Hello" }
    });
    expect(blocked.statusCode).toBe(403);
    expect(blocked.json().error).toMatch(/paused/i);

    const resumed = await app.inject({ method: "POST", url: "/api/tools/email/resume", headers: { authorization: `Bearer ${token}` } });
    expect(resumed.json().status).toBe("active");

    await app.close();
  });

  it("matches an inbound reply to the agent and raises a notification", async () => {
    const app = await buildTestApp();
    const { token, agentId, email } = await initEmailAgent(app);

    await app.inject({
      method: "POST",
      url: "/api/tools/email/send",
      headers: { authorization: `Bearer ${token}` },
      payload: { to: "john@example.com", subject: "Meeting tomorrow", body: "Are you free?" }
    });

    const inbound = await app.inject({
      method: "POST",
      url: "/api/webhooks/email/inbound",
      payload: { from: "John <john@example.com>", to: email, subject: "Re: Meeting tomorrow", text: "Yes, 2pm works for me." }
    });
    expect(inbound.statusCode).toBe(200);
    expect(inbound.json().matched).toBe(true);

    const activity = await app.inject({
      method: "GET",
      url: `/api/identity/${agentId}/email-activity`,
      headers: { authorization: `Bearer ${token}` }
    });
    const body = activity.json();
    expect(body.reply_notifications).toHaveLength(1);
    expect(body.reply_notifications[0].from_email).toBe("john@example.com");
    // outbound + inbound share a thread
    const threads = new Set(body.messages.map((message: { thread_id: string }) => message.thread_id));
    expect(threads.size).toBe(1);

    await app.close();
  });

  it("ignores inbound mail to an unknown address", async () => {
    const app = await buildTestApp();
    await initEmailAgent(app);

    const inbound = await app.inject({
      method: "POST",
      url: "/api/webhooks/email/inbound",
      payload: { from: "spam@nowhere.com", to: "nobody@agents.barkan.dev", subject: "Hello", text: "..." }
    });
    expect(inbound.statusCode).toBe(200);
    expect(inbound.json().matched).toBe(false);

    await app.close();
  });
});
