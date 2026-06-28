import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "../config.js";
import { getAgentIdentityByToken, recordIdentityAudit, type AgentIdentity } from "../identity.js";
import { placeAmazonOrder } from "./purchase.js";

const orderSchema = z.object({
  query: z.string().min(1).max(300),
  approved: z.boolean().optional()
});

function readBearerIdentity(request: FastifyRequest): AgentIdentity | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const identity = getAgentIdentityByToken(token.trim());
  if (!identity || identity.status !== "active") return null;
  return identity;
}

export function registerAmazonRoutes(app: FastifyInstance, config: AppConfig) {
  // Agent-facing tool. First call (no `approved`) returns the order review and
  // stops before placing. Placing requires `approved: true` AND the
  // payment.purchase permission — a real order spends real money.
  app.post("/api/tools/amazon/order", async (request, reply) => {
    const identity = readBearerIdentity(request);
    if (!identity) return reply.code(401).send({ error: "missing or invalid identity token" });

    if (!identity.permissions["payment.purchase"]) {
      recordIdentityAudit(identity.id, "amazon.order", "blocked", "permission denied: payment.purchase");
      return reply.code(403).send({ error: "permission denied: payment.purchase" });
    }

    const { query, approved } = orderSchema.parse(request.body ?? {});
    // A real order is placed only on an explicit approval. If the identity
    // requires human approval (default), the agent alone cannot place it.
    const willPlace = approved === true;

    recordIdentityAudit(
      identity.id,
      "amazon.order",
      "allowed",
      willPlace ? `Placing Amazon order for "${query}".` : `Amazon order review for "${query}".`
    );

    const result = await placeAmazonOrder(query, willPlace, config);

    recordIdentityAudit(
      identity.id,
      "amazon.order",
      result.status === "placed" ? "allowed" : result.status === "review" ? "allowed" : "blocked",
      `${result.status} • ${result.itemTitle ?? query}${result.orderNumber ? ` • ${result.orderNumber}` : ""} • ${result.detail}`
    );

    const code = result.status === "failed" || result.status === "blocked" ? 502 : result.status === "placed" ? 201 : 200;
    return reply.code(code).send({
      status: result.status,
      query: result.query,
      item_title: result.itemTitle,
      price: result.price,
      product_url: result.productUrl,
      order_number: result.orderNumber,
      screenshot_path: result.screenshotPath,
      detail: result.detail
    });
  });
}
