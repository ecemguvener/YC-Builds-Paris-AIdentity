import { describe, expect, it, vi } from "vitest";
import { ObjectId } from "mongodb";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { ApiKeyDocument, AtlasProjectDocument, Collections, SessionDocument, SiteDocument, UserDocument } from "./db.js";
import { createSessionExpiry, createSessionToken, hashPassword, hashSessionToken } from "./security.js";

const config: AppConfig = {
  NODE_ENV: "test",
  API_PORT: 0,
  PUBLIC_APP_URL: "http://localhost:4888",
  PUBLIC_API_URL: "http://localhost:4001",
  MONGODB_URI: "mongodb://127.0.0.1:27017/aidentity-test",
  SESSION_COOKIE_NAME: "aidentity_session",
  SESSION_SECRET: "test-aidentity-session-secret",
  ELEVENLABS_API_KEY: undefined,
  ELEVENLABS_AGENT_ID: undefined,
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: undefined,
  ELEVENLABS_VOICE_ID: "voice",
  OPENAI_API_KEY: undefined,
  OPENAI_DASHBOARD_CHAT_MODEL: "gpt-5.4-2026-03-05",
  RESEND_API_KEY: undefined,
  EMAIL_FROM_DOMAIN: "example.test",
  EMAIL_WEBHOOK_SECRET: undefined,
  EMAIL_SANDBOX_REDIRECT_TO: undefined
};

describe("site identity routes", () => {
  it("creates and completes an agent identity setup", async () => {
    const user = await createUser();
    const sessionToken = createSessionToken();
    const session: SessionDocument = {
      _id: new ObjectId(),
      userId: user._id,
      tokenHash: hashSessionToken(sessionToken, config.SESSION_SECRET),
      expiresAt: createSessionExpiry(),
      createdAt: new Date()
    } as SessionDocument;
    const collections = createCollections(user, session);
    const app = await buildApp(config, collections);

    const setupResponse = await app.inject({
      method: "POST",
      url: "/api/site-setups",
      cookies: { [config.SESSION_COOKIE_NAME]: sessionToken },
      payload: { name: "Ava", domain: "https://openclaw.example.com/runtime" }
    });

    expect(setupResponse.statusCode).toBe(201);
    const setupBody = setupResponse.json();
    expect(setupBody.setup).toMatchObject({
      name: "Ava",
      domain: "openclaw.example.com"
    });
    expect(setupBody.secret).toMatch(/^ck_/);

    const completeResponse = await app.inject({
      method: "POST",
      url: `/api/site-setups/${setupBody.setup.projectId}/complete`,
      cookies: { [config.SESSION_COOKIE_NAME]: sessionToken }
    });

    expect(completeResponse.statusCode).toBe(200);
    expect(completeResponse.json()).toMatchObject({
      site: {
        name: "Ava",
        domain: "openclaw.example.com"
      }
    });

    await app.close();
  });

  it("does not register removed widget and Atlas agent routes", async () => {
    const user = await createUser();
    const session: SessionDocument = {
      _id: new ObjectId(),
      userId: user._id,
      tokenHash: "unused",
      expiresAt: createSessionExpiry(),
      createdAt: new Date()
    } as SessionDocument;
    const app = await buildApp(config, createCollections(user, session));

    await expectRouteNotFound(app, "GET", "/widget.js");
    await expectRouteNotFound(app, "GET", "/api/widget/config?siteKey=site_test");
    await expectRouteNotFound(app, "POST", "/api/widget/action");
    await expectRouteNotFound(app, "POST", "/api/atlas/connect");
    await expectRouteNotFound(app, "POST", "/api/atlas/agent/select-files");

    await app.close();
  });
});

async function createUser(): Promise<UserDocument> {
  return {
    _id: new ObjectId(),
    email: "user@example.com",
    displayName: "User",
    passwordHash: await hashPassword("password123"),
    createdAt: new Date()
  } as UserDocument;
}

async function expectRouteNotFound(app: Awaited<ReturnType<typeof buildApp>>, method: string, url: string) {
  const response = await app.inject({ method, url });
  expect(response.statusCode).toBe(404);
}

function createCollections(user: UserDocument, session: SessionDocument): Collections {
  let currentProject: AtlasProjectDocument | null = null;
  let currentSite: SiteDocument | null = null;
  const apiKeys: ApiKeyDocument[] = [];

  return {
    users: {
      findOne: vi.fn().mockImplementation((filter: Partial<UserDocument>) =>
        Promise.resolve(filter._id?.equals(user._id) || filter.email === user.email ? user : null)
      )
    },
    sessions: {
      findOne: vi.fn().mockImplementation((filter: Partial<SessionDocument>) =>
        Promise.resolve(filter.tokenHash === session.tokenHash ? session : null)
      ),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 }),
      insertOne: vi.fn()
    },
    sites: {
      find: vi.fn().mockReturnValue({
        sort: () => ({
          toArray: () => Promise.resolve(currentSite ? [currentSite] : [])
        })
      }),
      findOne: vi.fn().mockImplementation((filter: { _id?: ObjectId; ownerUserId?: ObjectId }) =>
        Promise.resolve(
          currentSite &&
            filter._id?.equals(currentSite._id) &&
            filter.ownerUserId?.equals(currentSite.ownerUserId)
            ? currentSite
            : null
        )
      ),
      insertOne: vi.fn().mockImplementation((site: SiteDocument) => {
        currentSite = site;
        return Promise.resolve({ insertedId: site._id });
      }),
      findOneAndUpdate: vi.fn(),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 })
    },
    apiKeys: {
      insertOne: vi.fn().mockImplementation((apiKey: ApiKeyDocument) => {
        apiKeys.push(apiKey);
        return Promise.resolve({ insertedId: apiKey._id });
      }),
      find: vi.fn().mockImplementation((filter: { userId?: ObjectId; siteId?: ObjectId; projectId?: string }) => ({
        sort: () => ({
          toArray: () =>
            Promise.resolve(
              apiKeys.filter((apiKey) => {
                if (filter.userId && !filter.userId.equals(apiKey.userId)) {
                  return false;
                }
                if (filter.siteId && !filter.siteId.equals(apiKey.siteId)) {
                  return false;
                }
                if (filter.projectId && filter.projectId !== apiKey.projectId) {
                  return false;
                }
                return true;
              })
            )
        })
      })),
      updateMany: vi.fn().mockImplementation((filter: { projectId?: string }, update: { $set?: Partial<ApiKeyDocument> }) => {
        for (const apiKey of apiKeys) {
          if (!filter.projectId || apiKey.projectId === filter.projectId) {
            Object.assign(apiKey, update.$set);
          }
        }
        return Promise.resolve({ modifiedCount: apiKeys.length });
      }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 }),
      deleteOne: vi.fn().mockResolvedValue({ deletedCount: 1 })
    },
    atlasProjects: {
      insertOne: vi.fn().mockImplementation((project: AtlasProjectDocument) => {
        currentProject = project;
        return Promise.resolve({ insertedId: project._id });
      }),
      findOne: vi.fn().mockImplementation((filter: { ownerUserId?: ObjectId; projectId?: string; siteId?: ObjectId }) =>
        Promise.resolve(
          currentProject &&
            (!filter.ownerUserId || filter.ownerUserId.equals(currentProject.ownerUserId)) &&
            (!filter.projectId || filter.projectId === currentProject.projectId) &&
            (!filter.siteId || filter.siteId.equals(currentProject.siteId))
            ? currentProject
            : null
        )
      ),
      updateOne: vi.fn().mockImplementation((_filter: unknown, update: { $set?: Partial<AtlasProjectDocument> }) => {
        if (currentProject && update.$set) {
          currentProject = { ...currentProject, ...update.$set };
        }
        return Promise.resolve({ matchedCount: currentProject ? 1 : 0 });
      }),
      find: vi.fn().mockReturnValue({ toArray: () => Promise.resolve(currentProject ? [currentProject] : []) }),
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 })
    },
    interactionLogs: {
      deleteMany: vi.fn().mockResolvedValue({ deletedCount: 0 })
    }
  } as unknown as Collections;
}
