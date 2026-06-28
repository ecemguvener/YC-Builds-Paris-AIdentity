import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "./App";

describe("App", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    window.history.replaceState({}, "", "/");
  });

  it("shows the current public product copy without old widget setup language", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("not needed"));

    window.history.replaceState({}, "", "/plans");
    render(<App />);

    expect(await screen.findAllByText(/agent identities/i)).not.toHaveLength(0);
    expect(screen.getByText(/OpenClaw identity linking/i)).toBeInTheDocument();
    expect(screen.queryByText(/Action Mode/i)).not.toBeInTheDocument();
    expect(screen.queryByText(/widget snippet/i)).not.toBeInTheDocument();
  });

  it("renders the authenticated identity dashboard", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url.endsWith("/api/auth/me")) {
        return jsonResponse({
          user: {
            id: "user_1",
            email: "user@example.com",
            displayName: "User",
            avatarUrl: null,
            notificationPreferences: {
              productEmails: true,
              identityEmails: true,
              securityEmails: true
            },
            createdAt: new Date().toISOString()
          }
        });
      }
      if (url.endsWith("/api/sites")) {
        return jsonResponse({ sites: [] });
      }
      return jsonResponse({ error: "not found" }, 404);
    });

    window.history.replaceState({}, "", "/dashboard");
    render(<App />);

    await waitFor(() => expect(screen.getByText("Identities")).toBeInTheDocument());
    expect(screen.getByText("New identity")).toBeInTheDocument();
    expect(screen.queryByText(/npx aidentity connect/i)).not.toBeInTheDocument();
  });
});

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" }
  });
}
