import fastify from "fastify";
import cookie from "@fastify/cookie";
import cors from "@fastify/cors";
import { ZodError } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections } from "./db.js";
import { buildCorsOptionsForRequest, isPublicCorsPath, isTrustedDashboardOrigin } from "./cors.js";
import { registerAtlasAgentBridge } from "./atlas/agent-bridge.js";
import { registerAtlasRoutes } from "./atlas/routes.js";
import { registerAuthRoutes } from "./auth.js";
import { registerDashboardChatRoutes } from "./dashboard-chat.js";
import { registerEmailRoutes, registerSiteEmailRoutes } from "./email.js";
import { registerIdentityRoutes } from "./identity.js";
import { registerPaymentRoutes, registerSitePaymentRoutes } from "./payments.js";
import { registerSiteRoutes } from "./sites.js";
import { registerWidgetRoutes } from "./widget.js";

export async function buildApp(config: AppConfig, collections: Collections) {
  const app = fastify({
    logger: {
      level: config.NODE_ENV === "test" ? "silent" : "info"
    },
    bodyLimit: 8 * 1024 * 1024
  });

  // Keep the raw JSON body around so the email inbound webhook can verify the
  // Resend (Svix) signature, which is computed over the exact bytes received.
  app.addContentTypeParser("application/json", { parseAs: "string" }, (request, body, done) => {
    (request as { rawBody?: string }).rawBody = typeof body === "string" ? body : "";
    if (typeof body !== "string" || body.trim() === "") {
      done(null, {});
      return;
    }
    try {
      done(null, JSON.parse(body));
    } catch (error) {
      (error as Error & { statusCode?: number }).statusCode = 400;
      done(error as Error, undefined);
    }
  });

  await app.register(cookie);
  await app.register(cors, {
    delegator: (request, callback) => {
      callback(null, buildCorsOptionsForRequest(config, request));
    }
  });

  app.addHook("preHandler", async (request, reply) => {
    const origin = request.headers.origin;
    if (
      typeof origin === "string" &&
      !isPublicCorsPath(request.url) &&
      !isTrustedDashboardOrigin(origin, config)
    ) {
      return reply.code(403).send({ error: "origin is not allowed" });
    }
  });

  app.addHook("preSerialization", async (_request, reply, payload) => {
    if (
      reply.statusCode >= 400 &&
      isRecord(payload) &&
      typeof payload.error === "string" &&
      typeof payload.message !== "string"
    ) {
      return { ...payload, message: payload.error };
    }

    return payload;
  });

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      const message = "invalid request";
      reply.code(400).send({
        error: message,
        message,
        details: error.flatten()
      });
      return;
    }

    app.log.error(error);
    reply.code(500).send({ error: "internal server error", message: "internal server error" });
  });

  app.get("/api/health", async () => ({ ok: true }));

  registerAtlasAgentBridge(app, collections, config);
  registerAtlasRoutes(app, collections, config);
  registerAuthRoutes(app, collections, config);
  registerDashboardChatRoutes(app, collections, config);
  registerEmailRoutes(app, config);
  registerSiteEmailRoutes(app, collections, config);
  registerIdentityRoutes(app, config);
  registerPaymentRoutes(app, config);
  registerSitePaymentRoutes(app, collections, config);
  registerSiteRoutes(app, collections, config);
  await registerWidgetRoutes(app, collections, config);

  return app;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}
