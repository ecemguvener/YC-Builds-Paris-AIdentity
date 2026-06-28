import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "./App";

const testUser = {
  id: "user_1",
  email: "maxence@example.com",
  displayName: null,
  phoneNumber: null,
  avatarUrl: null,
  notificationPreferences: {
    productEmails: true,
    documentationEmails: true,
    securityEmails: true
  },
  createdAt: "2026-01-01T00:00:00.000Z"
};

const testSite = {
  id: "site_1",
  name: "Test site",
  domain: "example.com",
  publicSiteKey: "site_public_key_123456",
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-05-17T00:00:00.000Z"
};

beforeEach(() => {
  window.history.pushState({}, "", "/dashboard");
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  window.history.pushState({}, "", "/");
  localStorage.clear();
});

describe("App", () => {
  it("shows the landing page on the root route without bootstrapping the dashboard", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.history.pushState({}, "", "/");

    render(<App />);

    expect(screen.getByLabelText("Loading Barkan homepage")).toBeInTheDocument();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("shows the pricing page without bootstrapping the dashboard", () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    window.history.pushState({}, "", "/plans");

    render(<App />);

    expect(screen.getByRole("heading", { name: /Pricing that scales\s+with your company\./ })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Launch" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Growth" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Enterprise" })).toBeInTheDocument();
    expect(screen.getByText("Recommended")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Founder-friendly answers." })).toBeInTheDocument();
    expect(screen.getAllByRole("link", { name: "Get started" })).toHaveLength(3);
    screen.getAllByRole("link", { name: "Get started" }).forEach((link) => {
      expect(link).toHaveAttribute("href", "/signin");
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("redirects dashboard visitors without a session to signin", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 401 }))
    );

    render(<App />);

    await waitFor(() => {
      expect(window.location.pathname).toBe("/signin");
    });
    expect(await screen.findByRole("heading", { name: "Welcome !" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Continue" })).toBeInTheDocument();
  });

  it("shows the auth screen on the signin route", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "no" }), { status: 401 }))
    );
    window.history.pushState({}, "", "/signin");

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Welcome !" })).toBeInTheDocument();
    expect(screen.getByLabelText("Email")).toBeInTheDocument();
  });

  it("shows an inline field error instead of submitting an empty auth email", async () => {
    const fetchMock = vi.fn(async (_input: RequestInfo | URL) =>
      new Response(JSON.stringify({ error: "no" }), { status: 401 })
    );
    vi.stubGlobal("fetch", fetchMock);
    window.history.pushState({}, "", "/signin");

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Please fill in this field.");
    expect(screen.getByLabelText("Email")).toHaveFocus();
    expect(fetchMock.mock.calls.some(([input]) => String(input).endsWith("/api/auth/check-email"))).toBe(false);
  });

  it("shows the backend email validation message when email lookup is rejected", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/auth/me")) {
        return new Response(JSON.stringify({ error: "no" }), { status: 401 });
      }

      if (url.endsWith("/api/auth/check-email") && method === "POST") {
        return new Response(
          JSON.stringify({
            error: "invalid request",
            details: {
              fieldErrors: { email: ["Invalid email"] },
              formErrors: []
            }
          }),
          { status: 400 }
        );
      }

      throw new Error("Fallback should not run after a validation response");
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.pushState({}, "", "/signin");

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "test@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("Invalid email");
    expect(fetchMock.mock.calls.filter(([input]) => String(input).endsWith("/api/auth/check-email"))).toHaveLength(1);
  });

  it("does not show non-json error response bodies in auth field errors", async () => {
    const htmlError = "<html><head><title>405 Not Allowed</title></head><body>nginx</body></html>";
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";

      if (url.endsWith("/api/auth/me")) {
        return new Response(JSON.stringify({ message: "no" }), { status: 401 });
      }

      if (url.endsWith("/api/auth/check-email") && method === "POST") {
        return new Response(htmlError, { status: 405, statusText: "Not Allowed" });
      }

      throw new Error("Fallback should not run after a failed validation response");
    });
    vi.stubGlobal("fetch", fetchMock);
    window.history.pushState({}, "", "/signin");

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "test@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("405 Not Allowed");
    expect(screen.getByRole("alert")).not.toHaveTextContent("<html>");
  });

  it("moves from signin to the dashboard after login", async () => {
    const fetchMock = stubSigninFetch();
    window.history.pushState({}, "", "/signin");

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "maxence@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Enter password" })).toBeInTheDocument();
    const passwordPanel = await findActiveAuthPanel("password");
    fireEvent.change(within(passwordPanel).getByLabelText("Password"), {
      target: { value: "password123" }
    });
    fireEvent.click(within(passwordPanel).getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Your sites" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboard");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/login$/),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("moves from signin to the dashboard after signup when the email is new", async () => {
    const fetchMock = stubSignupFetch();
    window.history.pushState({}, "", "/signin");

    render(<App />);

    fireEvent.change(await screen.findByLabelText("Email"), {
      target: { value: "new@example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Choose password" })).toBeInTheDocument();
    const passwordPanel = await findActiveAuthPanel("password");
    fireEvent.change(within(passwordPanel).getByLabelText("Password"), {
      target: { value: "password123" }
    });
    fireEvent.click(within(passwordPanel).getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Your sites" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboard");
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/signup$/),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("moves back to the landing page after sign out", async () => {
    const fetchMock = stubDashboardFetch(null);

    render(<App />);

    expect(await screen.findByRole("heading", { name: "Your sites" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Sign out" }));

    await waitFor(() => {
      expect(window.location.pathname).toBe("/");
    });
    expect(screen.getByLabelText("Loading Barkan homepage")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/auth\/logout$/),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("shows credentials by default without runtime mode controls", async () => {
    stubDashboardFetch(null);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));

    expect(`${window.location.pathname}${window.location.search}`).toBe("/dashboard/site/site_1?tab=credentials");
    expect(await screen.findByRole("tab", { name: "Credentials", selected: true })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Install snippet" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Runtime mode" })).not.toBeInTheDocument();
    expect(screen.queryByRole("combobox", { name: "Interaction mode" })).not.toBeInTheDocument();
    expect(screen.getByText("DOM-first")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "CLI API key" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("tab", { name: "Documentation" }));

    expect(`${window.location.pathname}${window.location.search}`).toBe("/dashboard/site/site_1?tab=documentation");
    expect(await screen.findByRole("tab", { name: "Documentation", selected: true })).toBeInTheDocument();
    expect(screen.getByText(/npx barkan connect/)).toBeInTheDocument();
  });

  it("opens a site detail documentation route directly", async () => {
    stubDashboardFetch(createRouteDocumentation("proj_site"));
    window.history.pushState({}, "", "/dashboard/site/site_1?tab=documentation");

    render(<App />);

    expect(await screen.findByRole("tab", { name: "Documentation", selected: true })).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Documentation map" })).toBeInTheDocument();
    expect(screen.getByText("/dashboard")).toBeInTheDocument();
  });

  it("defaults a site detail route without a tab to credentials", async () => {
    stubDashboardFetch(null);
    window.history.pushState({}, "", "/dashboard/site/site_1");

    render(<App />);

    expect(await screen.findByRole("tab", { name: "Credentials", selected: true })).toBeInTheDocument();
    expect(`${window.location.pathname}${window.location.search}`).toBe("/dashboard/site/site_1");
  });

  it("shows saved route documentation from site details", async () => {
    stubDashboardFetch(createRouteDocumentation("proj_site"), null, null, createBackendDocumentation("proj_site"));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Documentation" }));

    expect(await screen.findByRole("heading", { name: "Documentation map" })).toBeInTheDocument();
    expect(screen.getByText(/2 frontend routes · 1 backend endpoints/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Frontend routes" })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: "Backend endpoints" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Regenerate doc" })).toBeInTheDocument();
    expect(screen.getByRole("searchbox", { name: "Search documentation" })).toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Backend endpoints" }));

    expect(screen.getByText("POST")).toBeInTheDocument();
    expect(screen.getByText("/api/tasks")).toBeInTheDocument();
    expect(screen.getByText("Creates a task for the signed-in user.")).toBeInTheDocument();
    expect(screen.getByText("title: string required")).toBeInTheDocument();
  });

  it("does not call regenerate or flash the stepper when existing docs have no local agent", async () => {
    const fetchMock = stubDashboardFetch(createRouteDocumentation("proj_site"));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Documentation" }));
    const regenerateButton = await screen.findByRole("button", { name: "Regenerate doc" });

    expect(regenerateButton).toBeEnabled();
    expect(screen.getByTitle("Run npx barkan connect before regenerating")).toBeInTheDocument();
    expect(screen.queryByLabelText("Documentation generation progress")).not.toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).join("\n")).not.toContain("/documentation/generate");
    expect(fetchMock.mock.calls.map(([input]) => String(input)).join("\n")).not.toContain("/documentation-agent");
  });

  it("renders and searches route summaries inside the Documentation tab", async () => {
    const fetchMock = stubDashboardFetch(createRouteDocumentation("proj_site"));
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Documentation" }));

    expect(await screen.findByRole("heading", { name: "Documentation map" })).toBeInTheDocument();
    expect(screen.getByText("/")).toBeInTheDocument();
    expect(screen.getByText("Home page with sign in and sign up entry points.")).toBeInTheDocument();
    expect(screen.getByText("/dashboard")).toBeInTheDocument();
    expect(screen.getByText("Dashboard for managing sites, snippets, API keys, and documentation.")).toBeInTheDocument();

    fireEvent.change(screen.getByRole("searchbox", { name: "Search documentation" }), {
      target: { value: "dashboard" }
    });

    expect(screen.queryByText("Home page with sign in and sign up entry points.")).not.toBeInTheDocument();
    expect(screen.getByText("/dashboard")).toBeInTheDocument();
    expect(fetchMock.mock.calls.map(([input]) => String(input)).join("\n")).not.toContain("/api/atlas/projects");
  });

  it("shows the local-agent empty state before generation", async () => {
    stubDashboardFetch(null);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Documentation" }));

    expect(await screen.findByRole("heading", { name: "Connect to your codebase" })).toBeInTheDocument();
    expect(screen.getByText(/npx barkan connect/)).toBeInTheDocument();
  });

  it("generates documentation from the dashboard when the local agent is connected", async () => {
    const generatedDocumentation = createRouteDocumentation("proj_site");
    const generatedBackendDocumentation = createBackendDocumentation("proj_site");
    const fetchMock = stubDashboardFetch(null, createDocumentationAgent(), generatedDocumentation, null, generatedBackendDocumentation);
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Documentation" }));

    expect(await screen.findByRole("heading", { name: "Ready to generate documentation" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Generate documentation" }));

    expect(await screen.findByText("Files selection")).toBeInTheDocument();
    expect(await screen.findByRole("button", { name: "Regenerate doc" }, { timeout: 3000 })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate documentation" })).not.toBeInTheDocument();
    expect(screen.queryByLabelText("Documentation generation progress")).not.toBeInTheDocument();
    expect(screen.getByText("/dashboard")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Backend endpoints" }));
    expect(screen.getByText("/api/tasks")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/sites\/site_1\/documentation\/generate$/),
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
  });

  it("shows server-tracked documentation generation progress in site details", async () => {
    stubDashboardFetch(null, createDocumentationAgent(), null, null, null, {
      projectId: "proj_site",
      status: "running",
      activeStep: "frontend_documentation",
      completedSteps: ["connection"],
      stepProgress: {
        connection: { current: 1, total: 1, label: "Connected" },
        frontend_documentation: { current: 1, total: 2, label: "1/2 files" }
      },
      startedAt: "2026-05-18T10:00:00.000Z",
      updatedAt: "2026-05-18T10:00:01.000Z"
    });
    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    fireEvent.click(await screen.findByRole("tab", { name: "Documentation" }));

    expect(await screen.findByLabelText("Documentation generation progress")).toBeInTheDocument();
    expect(screen.getByText("Wait for connection")).toBeInTheDocument();
    expect(screen.getByText("Frontend docs")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Generate documentation" })).not.toBeInTheDocument();
  });

  it("only shows the raw API-key copy action for a newly created key", async () => {
    stubDashboardFetch(null);

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    expect(await screen.findByRole("heading", { name: "CLI API key" })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Copy key" })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole("button", { name: "Create API key" }));

    expect(await screen.findByRole("button", { name: "Copy key" })).toBeInTheDocument();
    expect(screen.queryByDisplayValue("ck_created_secret")).not.toBeInTheDocument();
  });

  it("creates a setup, waits for connection, generates docs, and then shows the install snippet", async () => {
    const generatedDocumentation = createRouteDocumentation("proj_new");
    const fetchMock = stubOnboardingFetch(generatedDocumentation);
    vi.stubGlobal("navigator", {
      ...navigator,
      clipboard: {
        writeText: vi.fn().mockResolvedValue(undefined)
      }
    });

    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: "New site" }))[0]);
    expect(window.location.pathname).toBe("/new-site");
    fireEvent.change(await screen.findByLabelText("Site name"), {
      target: { value: "New site" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Where will it live?" }, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Domain"), {
      target: { value: "new.example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("npx barkan connect ck_••••••••")).toBeInTheDocument();
    expect(screen.queryByText("npx barkan connect ck_onboarding_secret")).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/site-setups$/),
      expect.objectContaining({ method: "POST" })
    );
    expect(
      fetchMock.mock.calls.some(([input, init]) => String(input).endsWith("/api/sites") && init?.method === "POST")
    ).toBe(false);
    expect(screen.getByText("Run npx barkan connect from the client codebase with this CLI key.")).toBeInTheDocument();
    expect(screen.getByText("Wait for connection")).toBeInTheDocument();
    expect(screen.getByText("Backend docs")).toBeInTheDocument();
    expect(await screen.findByRole("heading", { name: "Connect to your codebase" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));

    expect(await screen.findByRole("button", { name: "Copied" })).toBeInTheDocument();
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith("npx barkan connect ck_onboarding_secret");
    fireEvent.click(screen.getByRole("button", { name: "Copied" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledTimes(2);
    expect(await screen.findByRole("heading", { name: "Ready to install" }, { timeout: 6000 })).toBeInTheDocument();
    expect(screen.getByText(/data-barkan-site="site_new_key"/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Copy code" }));
    expect(navigator.clipboard.writeText).toHaveBeenCalledWith(
      '<script async src="http://localhost:4000/widget.js" data-barkan-site="site_new_key"></script>'
    );
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Back to dashboard" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to dashboard" }));
    expect(await screen.findByRole("heading", { name: "Your sites" })).toBeInTheDocument();
    expect(window.location.pathname).toBe("/dashboard");
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(screen.getByText("new.example.com")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/site-setups\/proj_new\/documentation\/generate$/),
      expect.objectContaining({ method: "POST", credentials: "include" })
    );
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/site-setups\/proj_new\/complete$/),
      expect.objectContaining({ method: "POST" })
    );
  });

  it("can skip the codebase connection during site creation", async () => {
    const generatedDocumentation = createRouteDocumentation("proj_new");
    const fetchMock = stubOnboardingFetch(generatedDocumentation, {
      documentationAgent: {
        projectId: "proj_new",
        connected: false,
        connectedAt: null
      }
    });

    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: "New site" }))[0]);
    fireEvent.change(await screen.findByLabelText("Site name"), {
      target: { value: "New site" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Where will it live?" }, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Domain"), {
      target: { value: "new.example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByRole("heading", { name: "Connect to your codebase" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Skip for now" }));

    expect(await screen.findByRole("heading", { name: "Ready to install" })).toBeInTheDocument();
    expect(screen.getByText(/data-barkan-site="site_new_key"/)).toBeInTheDocument();
    expect(
      fetchMock.mock.calls.some(([input, init]) =>
        String(input).endsWith("/api/site-setups/proj_new/documentation/generate") && init?.method === "POST"
      )
    ).toBe(false);
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/site-setups\/proj_new\/complete$/),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ skipDocumentation: true })
      })
    );
  });

  it("shows background onboarding documentation progress in site details after skipping", async () => {
    const generatedDocumentation = createRouteDocumentation("proj_new");
    stubOnboardingFetch(generatedDocumentation, {
      streamDelayMs: 2000
    });

    render(<App />);

    fireEvent.click((await screen.findAllByRole("button", { name: "New site" }))[0]);
    fireEvent.change(await screen.findByLabelText("Site name"), {
      target: { value: "New site" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "Where will it live?" }, { timeout: 3000 })).toBeInTheDocument();
    fireEvent.change(await screen.findByLabelText("Domain"), {
      target: { value: "new.example.com" }
    });
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));

    expect(await screen.findByText("Files selection")).toBeInTheDocument();
    fireEvent.click(await screen.findByRole("button", { name: "Skip for now" }));

    expect(await screen.findByRole("heading", { name: "Ready to install" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Continue" }));
    expect(await screen.findByRole("heading", { name: "You're all set" })).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Back to dashboard" }));

    const newSiteDomain = await screen.findByText("new.example.com");
    const newSiteButton = newSiteDomain.closest("button");
    expect(newSiteButton).not.toBeNull();
    fireEvent.click(newSiteButton as HTMLButtonElement);
    fireEvent.click(await screen.findByRole("tab", { name: "Documentation" }));

    expect(await screen.findByLabelText("Documentation generation progress")).toBeInTheDocument();
    expect(screen.getByText("Wait for connection")).toBeInTheDocument();
    expect(screen.getByText("Backend docs")).toBeInTheDocument();
  });

  it("deletes a selected site from the site details", async () => {
    const fetchMock = stubDashboardFetch(null);
    vi.stubGlobal("confirm", vi.fn(() => true));

    render(<App />);

    fireEvent.click(await screen.findByRole("button", { name: /Test site/ }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete site" }));

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    });
    expect(screen.queryByRole("button", { name: /Test site/ })).not.toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith(
      expect.stringMatching(/\/api\/sites\/site_1$/),
      expect.objectContaining({ method: "DELETE" })
    );
  });
});

async function findActiveAuthPanel(inputName: string): Promise<HTMLElement> {
  let activeInput: HTMLInputElement | null = null;

  await waitFor(() => {
    activeInput = document.querySelector(`.auth-card__panel--active input[name="${inputName}"]`);
    expect(activeInput).not.toBeNull();
  });

  return activeInput!.closest(".auth-card__panel") as HTMLElement;
}

function createRouteDocumentation(projectId: string) {
  return {
    version: 1,
    project_id: projectId,
    generated_at: "2026-05-17T10:00:00.000Z",
    source_files: ["src/App.tsx"],
    routes: [
      {
        path: "/",
        summary: "Home page with sign in and sign up entry points."
      },
      {
        path: "/dashboard",
        summary: "Dashboard for managing sites, snippets, API keys, and documentation."
      }
    ]
  };
}

function createBackendDocumentation(projectId: string) {
  return {
    version: 1,
    project_id: projectId,
    generated_at: "2026-05-17T10:00:00.000Z",
    source_files: ["apps/api/src/tasks.ts"],
    endpoints: [
      {
        method: "POST",
        path: "/api/tasks",
        summary: "Creates a task for the signed-in user.",
        auth: "requires user session cookie",
        request: {
          body: {
            title: { type: "string", required: true },
            dueDate: { type: "YYYY-MM-DD", required: false }
          }
        },
        response: {
          success: "201 with created task object",
          errors: ["400 invalid body", "401 unauthenticated"]
        }
      }
    ]
  };
}

function createDocumentationAgent() {
  return {
    projectId: "proj_site",
    connected: true,
    connectedAt: "2026-05-17T09:00:00.000Z"
  };
}

function stubSigninFetch() {
  let isLoggedIn = false;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/auth/me")) {
      if (!isLoggedIn) {
        return new Response(JSON.stringify({ error: "no" }), { status: 401 });
      }

      return new Response(JSON.stringify({ user: testUser }));
    }

    if (url.endsWith("/api/auth/check-email") && method === "POST") {
      return new Response(JSON.stringify({ exists: true }));
    }

    if (url.endsWith("/api/auth/login") && method === "POST") {
      isLoggedIn = true;
      return new Response(JSON.stringify({ user: testUser }));
    }

    if (url.endsWith("/api/sites") && method === "GET") {
      return new Response(JSON.stringify({ sites: [testSite] }));
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubSignupFetch() {
  let isLoggedIn = false;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/auth/me")) {
      if (!isLoggedIn) {
        return new Response(JSON.stringify({ error: "no" }), { status: 401 });
      }

      return new Response(JSON.stringify({ user: testUser }));
    }

    if (url.endsWith("/api/auth/check-email") && method === "POST") {
      return new Response(JSON.stringify({ exists: false }));
    }

    if (url.endsWith("/api/auth/signup") && method === "POST") {
      isLoggedIn = true;
      return new Response(JSON.stringify({ user: testUser }));
    }

    if (url.endsWith("/api/sites") && method === "GET") {
      return new Response(JSON.stringify({ sites: [testSite] }));
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubDashboardFetch(
  documentation: unknown | null,
  documentationAgent: unknown | null = null,
  generatedDocumentation: unknown | null = null,
  backendDocumentation: unknown | null = null,
  generatedBackendDocumentation: unknown | null = null,
  documentationGeneration: unknown | null = null
) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/auth/me")) {
      return new Response(JSON.stringify({ user: testUser }));
    }

    if (url.endsWith("/api/sites") && method === "GET") {
      return new Response(JSON.stringify({ sites: [testSite] }));
    }

    if (url.endsWith("/api/sites/site_1") && method === "GET") {
      return new Response(
        JSON.stringify({
          site: testSite,
          snippet: '<script async src="http://localhost:4000/widget.js" data-barkan-site="site_public_key_123456"></script>',
          apiKeys: [
            {
              id: "key_1",
              name: "CLI key",
              prefix: "ck_abcd123",
              createdAt: "2026-05-17T10:00:00.000Z",
              lastUsedAt: null
            }
          ],
          documentation,
          backendDocumentation,
          sourceContext: null,
          documentationAgent,
          documentationGeneration
        })
      );
    }

    if (url.endsWith("/api/sites/site_1/documentation-agent") && method === "GET") {
      return new Response(JSON.stringify({ documentationAgent }));
    }

    if (url.endsWith("/api/sites/site_1/documentation/generate") && method === "POST" && generatedDocumentation) {
      return new Response(createDocumentationGenerationStream(generatedDocumentation, generatedBackendDocumentation), {
        headers: { "content-type": "text/event-stream" }
      });
    }

    if (url.endsWith("/api/sites/site_1/api-keys") && method === "POST") {
      return new Response(
        JSON.stringify({
          apiKey: {
            id: "key_2",
            name: "CLI key",
            prefix: "ck_created",
            createdAt: "2026-05-17T10:05:00.000Z",
            lastUsedAt: null
          },
          secret: "ck_created_secret"
        })
      );
    }

    if (url.endsWith("/api/sites/site_1") && method === "DELETE") {
      return new Response(JSON.stringify({ ok: true }));
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function stubOnboardingFetch(
  generatedDocumentation: unknown,
  options: { documentationAgent?: unknown; streamDelayMs?: number } = {}
) {
  const generatedBackendDocumentation = createBackendDocumentation("proj_new");
  const documentationAgent = options.documentationAgent ?? createDocumentationAgent();
  const streamDelayMs = options.streamDelayMs ?? 80;
  const newSite = {
    id: "site_new",
    name: "New site",
    domain: "new.example.com",
    publicSiteKey: "site_new_key",
    createdAt: "2026-05-18T00:00:00.000Z",
    updatedAt: "2026-05-18T00:00:00.000Z"
  };
  let didGenerateDocumentation = false;

  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";

    if (url.endsWith("/api/auth/me")) {
      return new Response(JSON.stringify({ user: testUser }));
    }

    if (url.endsWith("/api/sites") && method === "GET") {
      return new Response(JSON.stringify({ sites: didGenerateDocumentation ? [newSite, testSite] : [testSite] }));
    }

    if (url.endsWith("/api/site-setups") && method === "POST") {
      return new Response(
        JSON.stringify({
          setup: {
            projectId: "proj_new",
            name: "New site",
            domain: "new.example.com",
            createdAt: "2026-05-18T00:00:00.000Z",
            updatedAt: "2026-05-18T00:00:00.000Z"
          },
          apiKey: {
            id: "key_new",
            name: "CLI key",
            prefix: "ck_onboard",
            createdAt: "2026-05-18T00:01:00.000Z",
            lastUsedAt: null
          },
          secret: "ck_onboarding_secret"
        }),
        { status: 201 }
      );
    }

    if (url.endsWith("/api/site-setups/proj_new") && method === "GET") {
      return new Response(
        JSON.stringify({
          setup: {
            projectId: "proj_new",
            name: "New site",
            domain: "new.example.com",
            createdAt: "2026-05-18T00:00:00.000Z",
            updatedAt: "2026-05-18T00:00:00.000Z"
          },
          apiKeys: [
            {
              id: "key_new",
              name: "CLI key",
              prefix: "ck_onboard",
              createdAt: "2026-05-18T00:01:00.000Z",
              lastUsedAt: null
            }
          ],
          documentation: didGenerateDocumentation ? generatedDocumentation : null,
          backendDocumentation: didGenerateDocumentation ? generatedBackendDocumentation : null,
          documentationAgent
        })
      );
    }

    if (url.endsWith("/api/site-setups/proj_new/documentation/generate") && method === "POST") {
      didGenerateDocumentation = true;
      return new Response(createDocumentationGenerationStream(generatedDocumentation, generatedBackendDocumentation, streamDelayMs), {
        headers: { "content-type": "text/event-stream" }
      });
    }

    if (url.endsWith("/api/site-setups/proj_new/complete") && method === "POST") {
      return new Response(
        JSON.stringify({
          site: newSite,
          snippet: '<script async src="http://localhost:4000/widget.js" data-barkan-site="site_new_key"></script>',
          apiKeys: [
            {
              id: "key_new",
              name: "CLI key",
              prefix: "ck_onboard",
              createdAt: "2026-05-18T00:01:00.000Z",
              lastUsedAt: null
            }
          ],
          documentation: didGenerateDocumentation ? generatedDocumentation : null,
          backendDocumentation: didGenerateDocumentation ? generatedBackendDocumentation : null,
          sourceContext: null,
          documentationAgent
        })
      );
    }

    return new Response(JSON.stringify({ error: "unexpected" }), { status: 404 });
  });

  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function createDocumentationGenerationStream(
  documentation: unknown,
  backendDocumentation: unknown | null = null,
  delayMs = 5
) {
  const encoder = new TextEncoder();
  const chunks = [
    "event: step_started\ndata: {\"step\":\"files_selection\",\"total\":2}\n\n",
    "event: step_progress\ndata: {\"step\":\"files_selection\",\"current\":1,\"total\":2,\"label\":\"1/2 batches\"}\n\n",
    "event: step_completed\ndata: {\"step\":\"files_selection\",\"current\":2,\"total\":2}\n\n",
    "event: step_started\ndata: {\"step\":\"frontend_documentation\",\"total\":2}\n\n",
    "event: step_progress\ndata: {\"step\":\"frontend_documentation\",\"current\":1,\"total\":2,\"label\":\"1/2 files\"}\n\n",
    "event: step_completed\ndata: {\"step\":\"frontend_documentation\",\"current\":2,\"total\":2}\n\n",
    "event: step_started\ndata: {\"step\":\"backend_documentation\"}\n\n",
    "event: step_completed\ndata: {\"step\":\"backend_documentation\"}\n\n",
    `event: completed\ndata: ${JSON.stringify({ documentation, backendDocumentation })}\n\n`
  ];

  return new ReadableStream({
    start(controller) {
      let index = 0;
      const push = () => {
        if (index >= chunks.length) {
          controller.close();
          return;
        }

        controller.enqueue(encoder.encode(chunks[index]));
        index += 1;
        window.setTimeout(push, delayMs);
      };

      push();
    }
  });
}
