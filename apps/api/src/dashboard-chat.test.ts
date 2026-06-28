import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { Collections, SiteDocument, UserDocument } from "./db.js";
import { hashSessionToken } from "./security.js";

const baseConfig: AppConfig = {
  NODE_ENV: "test",
  API_PORT: 4000,
  PUBLIC_APP_URL: "http://localhost:5173",
  PUBLIC_API_URL: "http://localhost:4000",
  MONGODB_URI: "mongodb://127.0.0.1:27017/barkan-web-test",
  SESSION_COOKIE_NAME: "barkan_session",
  SESSION_SECRET: "test-barkan-session-secret",
  ELEVENLABS_VOICE_ID: "voice_test",
  OPENAI_API_KEY: "openai",
  OPENAI_WIDGET_MODEL: "gpt-5.4-2026-03-05",
  OPENAI_ACTION_MODEL: "gpt-5.4-2026-03-05",
  OPENAI_ATLAS_MODEL: "gpt-5.4-2026-03-05"
};

describe("dashboard chat", () => {
  it("streams chat events with CORS headers for credentialed dashboard requests", async () => {
    const sessionToken = "session_test";
    const user = createUser();
    const fetchMock = vi.fn<typeof fetch>().mockResolvedValueOnce(
      Response.json({ output_text: "Hello from Barkan." }, {
        status: 200,
        headers: { "content-type": "application/json" }
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildApp(
      baseConfig,
      createCollections({
        sessionToken,
        user,
        sites: [createSite(user._id)]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/dashboard/chat",
      headers: {
        origin: "http://localhost:5173"
      },
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toContain("text/event-stream");
    expect(response.headers["access-control-allow-origin"]).toBe("http://localhost:5173");
    expect(response.headers["access-control-allow-credentials"]).toBe("true");
    expect(response.payload).toContain("data: {\"type\":\"ready\"");
    expect(response.payload).toContain("data: {\"type\":\"delta\",\"text\":\"Hello from Barkan.\"}");
    expect(response.payload).toContain("data: {\"type\":\"done\"}");

    vi.unstubAllGlobals();
    await app.close();
  });

  it("blocks credentialed dashboard chat from untrusted origins", async () => {
    const sessionToken = "session_test";
    const user = createUser();
    const fetchMock = vi.fn<typeof fetch>();
    vi.stubGlobal("fetch", fetchMock);

    const app = await buildApp(
      baseConfig,
      createCollections({
        sessionToken,
        user,
        sites: [createSite(user._id)]
      })
    );

    const response = await app.inject({
      method: "POST",
      url: "/api/dashboard/chat",
      headers: {
        origin: "https://evil.example"
      },
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        messages: [{ role: "user", content: "Hi" }]
      }
    });

    expect(response.statusCode).toBe(403);
    expect(response.headers["access-control-allow-origin"]).toBeUndefined();
    expect(response.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(fetchMock).not.toHaveBeenCalled();

    vi.unstubAllGlobals();
    await app.close();
  });
});

function openAIStreamText(text: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      controller.enqueue(
        encoder.encode(`data: ${JSON.stringify({ type: "response.output_text.delta", delta: text })}\n\n`)
      );
      controller.enqueue(encoder.encode("data: [DONE]\n\n"));
      controller.close();
    }
  });
}

function createCollections({
  sessionToken,
  user,
  sites
}: {
  sessionToken: string;
  user: UserDocument;
  sites: SiteDocument[];
}): Collections {
  return {
    sessions: {
      findOne: vi.fn().mockImplementation(({ tokenHash }: { tokenHash: string }) =>
        tokenHash === hashSessionToken(sessionToken, baseConfig.SESSION_SECRET)
          ? Promise.resolve({ _id: new ObjectId(), userId: user._id, tokenHash })
          : Promise.resolve(null)
      )
    },
    users: {
      findOne: vi.fn().mockResolvedValue(user)
    },
    sites: {
      find: vi.fn().mockImplementation(({ ownerUserId }: { ownerUserId: ObjectId }) => ({
        sort: vi.fn().mockReturnValue({
          limit: vi.fn().mockReturnValue({
            toArray: vi.fn().mockResolvedValue(sites.filter((site) => site.ownerUserId.equals(ownerUserId)))
          })
        })
      }))
    }
  } as unknown as Collections;
}

function createUser(): UserDocument {
  return {
    _id: new ObjectId(),
    email: "dev@barkan.test",
    displayName: "Dev Barkan",
    phoneNumber: "+14155550198",
    passwordHash: "unused",
    createdAt: new Date()
  } as UserDocument;
}

function createSite(ownerUserId: ObjectId): SiteDocument {
  return {
    _id: new ObjectId(),
    ownerUserId,
    name: "Test site",
    domain: "example.com",
    publicSiteKey: "site_test",
    createdAt: new Date("2026-05-26T10:00:00.000Z"),
    updatedAt: new Date("2026-05-26T10:00:00.000Z")
  } as SiteDocument;
}
