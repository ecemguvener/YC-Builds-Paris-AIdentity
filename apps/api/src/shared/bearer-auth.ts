import type { FastifyRequest } from "fastify";
import { getAgentIdentityByToken, type AgentIdentity } from "../identity.js";

/**
 * Parse the Bearer token from a request's Authorization header, look up the
 * corresponding agent identity, and return it only if it is active.
 *
 * Shared by the payment and email tool route modules.
 */
export function readActiveBearerIdentity(request: FastifyRequest): AgentIdentity | null {
  const authorization = request.headers.authorization;
  if (!authorization) return null;
  const [scheme, token] = authorization.split(/\s+/, 2);
  if (scheme?.toLowerCase() !== "bearer" || !token) return null;
  const identity = getAgentIdentityByToken(token.trim());
  if (!identity || identity.status !== "active") return null;
  return identity;
}
