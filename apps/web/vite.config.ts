import fs from "node:fs";
import path from "node:path";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

const homepageDirectory = path.resolve(__dirname, "public/aidentity-homepage");

function getHomepageFilePath(requestUrl: string | undefined) {
  if (!requestUrl) {
    return null;
  }

  const pathname = new URL(requestUrl, "http://localhost").pathname;
  const routeAliases: Record<string, string> = {
    "/": "index.html",
    "/index.html": "index.html",
    "/contact": "contact.html",
    "/contact.html": "contact.html",
    "/404": "404.html",
    "/404.html": "404.html",
    "/legal/privacy": "legal/privacy.html",
    "/legal/privacy.html": "legal/privacy.html",
    "/legal/terms": "legal/terms.html",
    "/legal/terms.html": "legal/terms.html"
  };

  const relativePath =
    routeAliases[pathname] ??
    (pathname.startsWith("/framerusercontent.com/") ? pathname.slice(1) : null);

  if (!relativePath) {
    return null;
  }

  const filePath = path.resolve(homepageDirectory, relativePath);
  if (!filePath.startsWith(`${homepageDirectory}${path.sep}`) && filePath !== homepageDirectory) {
    return null;
  }

  return filePath;
}

function getContentType(filePath: string) {
  if (filePath.endsWith(".html")) {
    return "text/html; charset=utf-8";
  }

  if (filePath.endsWith(".png")) {
    return "image/png";
  }

  if (filePath.endsWith(".svg")) {
    return "image/svg+xml";
  }

  if (filePath.endsWith(".js")) {
    return "text/javascript; charset=utf-8";
  }

  if (filePath.endsWith(".css")) {
    return "text/css; charset=utf-8";
  }

  return "application/octet-stream";
}

export default defineConfig({
  plugins: [
    react(),
    {
      name: "aidentity-homepage-root",
      configureServer(server) {
        server.middlewares.use((request, response, next) => {
          if (request.method !== "GET" && request.method !== "HEAD") {
            next();
            return;
          }

          const filePath = getHomepageFilePath(request.url);
          if (!filePath || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
            next();
            return;
          }

          response.setHeader("Content-Type", getContentType(filePath));
          if (request.method === "HEAD") {
            response.end();
            return;
          }

          fs.createReadStream(filePath).pipe(response);
        });
      }
    }
  ],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src")
    }
  },
  server: {
    port: 4888,
    proxy: {
      "/api": {
        target: process.env.API_PROXY_TARGET ?? "http://127.0.0.1:4001",
        changeOrigin: false
      }
    }
  },
  test: {
    environment: "jsdom",
    setupFiles: "./src/test/setup.ts",
    include: ["src/**/*.test.tsx", "src/**/*.test.ts"]
  }
});
