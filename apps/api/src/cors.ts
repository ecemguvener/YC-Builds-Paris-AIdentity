import type { FastifyRequest } from "fastify";
import type { AppConfig } from "./config.js";

type CorsOptions = {
  origin?: string | boolean;
  credentials?: boolean;
  methods?: string[];
  strictPreflight?: boolean;
};

const corsMethods = ["GET", "HEAD", "PUT", "PATCH", "POST", "DELETE", "OPTIONS"];

export function buildCorsOptionsForRequest(config: AppConfig, request: FastifyRequest): CorsOptions {
  if (isPublicCorsPath(request.url)) {
    return {
      origin: true,
      credentials: false,
      methods: corsMethods,
      strictPreflight: false
    };
  }

  const origin = request.headers.origin;
  return {
    origin: typeof origin === "string" && isTrustedDashboardOrigin(origin, config) ? origin : false,
    credentials: true,
    methods: corsMethods,
    strictPreflight: false
  };
}

export function buildTrustedDashboardCorsHeaders(origin: unknown, config: AppConfig): Record<string, string> {
  if (typeof origin !== "string" || !isTrustedDashboardOrigin(origin, config)) {
    return {};
  }

  return {
    "access-control-allow-origin": origin,
    "access-control-allow-credentials": "true",
    vary: "Origin"
  };
}

export function buildPublicCorsHeaders(origin: unknown): Record<string, string> {
  return {
    "access-control-allow-origin": typeof origin === "string" && origin.trim() ? origin : "*",
    vary: "Origin"
  };
}

export function isTrustedDashboardOrigin(origin: string, config: AppConfig): boolean {
  const normalizedOrigin = normalizeOrigin(origin);
  if (getTrustedDashboardOrigins(config).has(normalizedOrigin)) {
    return true;
  }

  return config.NODE_ENV !== "production" && isDevelopmentDashboardOrigin(normalizedOrigin, config);
}

export function isPublicCorsPath(requestUrl: string): boolean {
  const pathname = requestUrl.split("?", 1)[0] || "/";
  return pathname === "/api/webhooks/email/inbound";
}

export function getTrustedDashboardOrigins(config: AppConfig): Set<string> {
  return new Set([config.PUBLIC_APP_URL, config.PUBLIC_API_URL].map(normalizeOrigin).filter(Boolean));
}

function isDevelopmentDashboardOrigin(origin: string, config: AppConfig): boolean {
  if (!origin) {
    return false;
  }

  try {
    const parsedOrigin = new URL(origin);
    if (parsedOrigin.protocol !== "http:" && parsedOrigin.protocol !== "https:") {
      return false;
    }

    const dashboardPort = getUrlPort(config.PUBLIC_APP_URL);
    if (dashboardPort && parsedOrigin.port !== dashboardPort) {
      return false;
    }

    return isLocalDevelopmentHostname(parsedOrigin.hostname);
  } catch {
    return false;
  }
}

function getUrlPort(value: string): string {
  try {
    const url = new URL(value);
    if (url.port) {
      return url.port;
    }

    return url.protocol === "https:" ? "443" : "80";
  } catch {
    return "";
  }
}

function isLocalDevelopmentHostname(hostname: string): boolean {
  const normalizedHostname = hostname.toLowerCase();
  if (
    normalizedHostname === "localhost" ||
    normalizedHostname === "127.0.0.1" ||
    normalizedHostname === "::1" ||
    normalizedHostname === "[::1]"
  ) {
    return true;
  }

  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(normalizedHostname)) {
    return true;
  }

  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(normalizedHostname)) {
    return true;
  }

  const privateNetworkMatch = normalizedHostname.match(/^172\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (privateNetworkMatch) {
    const secondOctet = Number(privateNetworkMatch[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }

  const tailnetMatch = normalizedHostname.match(/^100\.(\d{1,3})\.\d{1,3}\.\d{1,3}$/);
  if (tailnetMatch) {
    const secondOctet = Number(tailnetMatch[1]);
    return secondOctet >= 64 && secondOctet <= 127;
  }

  return false;
}

function normalizeOrigin(value: string): string {
  try {
    return new URL(value).origin;
  } catch {
    return "";
  }
}
