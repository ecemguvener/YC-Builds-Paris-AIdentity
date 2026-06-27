import Fastify from "fastify";
import { describe, expect, it } from "vitest";
import { registerIdentityRoutes } from "./identity.js";
import type { AppConfig } from "./config.js";

const config = {
  PUBLIC_API_URL: "http://localhost:4001",
  EMAIL_FROM_DOMAIN: "agents.barkan.dev"
} as AppConfig;

describe("identity layer routes", () => {
  it("initializes an identity, gates actions, audits actions, and revokes the token", async () => {
    const app = Fastify({ logger: false });
    registerIdentityRoutes(app, config);

    const initResponse = await app.inject({
      method: "POST",
      url: "/api/identity/init",
      payload: {
        agent_name: "Maya",
        agent_runtime: "openclaw",
        use_case: "customer_discovery",
        tools: ["email", "phone", "calendar"]
      }
    });
    expect(initResponse.statusCode).toBe(201);

    const initPayload = initResponse.json<{
      agent_id: string;
      identity_token: string;
      email: string;
      tool_endpoints: Record<string, string>;
    }>();
    expect(initPayload.agent_id).toMatch(/^agent_maya_/);
    expect(initPayload.identity_token).toMatch(/^identity_live_/);
    expect(initPayload.email).toContain("@agents.barkan.dev");

    const blockedCallResponse = await app.inject({
      method: "POST",
      url: "/api/tools/phone/call",
      headers: { authorization: `Bearer ${initPayload.identity_token}` },
      payload: {
        to: "+1 555 0100",
        script: "Hi, can we talk?"
      }
    });
    expect(blockedCallResponse.statusCode).toBe(403);

    const allowedCallResponse = await app.inject({
      method: "POST",
      url: "/api/tools/phone/call",
      headers: { authorization: `Bearer ${initPayload.identity_token}` },
      payload: {
        to: "+1 555 0100",
        script: "Hi, can we talk?",
        approved: true
      }
    });
    expect(allowedCallResponse.statusCode).toBe(200);
    expect(allowedCallResponse.json<{ ok: boolean }>().ok).toBe(true);

    const auditResponse = await app.inject({
      method: "GET",
      url: `/api/identity/${initPayload.agent_id}/audit-log`,
      headers: { authorization: `Bearer ${initPayload.identity_token}` }
    });
    expect(auditResponse.statusCode).toBe(200);
    expect(auditResponse.json<{ audit_log: Array<{ action: string }> }>().audit_log.map((entry) => entry.action)).toContain(
      "phone.call"
    );

    const revokeResponse = await app.inject({
      method: "POST",
      url: "/api/identity/revoke",
      headers: { authorization: `Bearer ${initPayload.identity_token}` }
    });
    expect(revokeResponse.statusCode).toBe(200);

    const revokedCallResponse = await app.inject({
      method: "POST",
      url: "/api/tools/phone/call",
      headers: { authorization: `Bearer ${initPayload.identity_token}` },
      payload: {
        to: "+1 555 0100",
        script: "This should not place a call.",
        approved: true
      }
    });
    expect(revokedCallResponse.statusCode).toBe(403);

    await app.close();
  });
});
