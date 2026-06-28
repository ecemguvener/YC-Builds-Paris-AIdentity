import { ObjectId } from "mongodb";
import { describe, expect, it, vi } from "vitest";
import { buildApp } from "./app.js";
import type { AppConfig } from "./config.js";
import type { Collections, UserDocument } from "./db.js";
import { hashPassword, hashSessionToken, verifyPassword } from "./security.js";

const baseConfig: AppConfig = {
  NODE_ENV: "test",
  API_PORT: 4000,
  PUBLIC_APP_URL: "http://localhost:5173",
  PUBLIC_API_URL: "http://localhost:4000",
  MONGODB_URI: "mongodb://127.0.0.1:27017/aidentity-web-test",
  SESSION_COOKIE_NAME: "aidentity_session",
  SESSION_SECRET: "test-aidentity-session-secret",
  ELEVENLABS_VOICE_ID: "voice_test",
  OPENAI_API_KEY: "openai",
};

describe("auth profile routes", () => {
  it("updates the signed-in user's profile", async () => {
    const sessionToken = "session_test";
    const user = await createUser();
    const app = await buildApp(baseConfig, createCollections({ sessionToken, user }));

    const response = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        displayName: "Max Aidentity",
        email: "MAX@Example.COM",
        avatarUrl: "data:image/png;base64,aGVsbG8="
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user).toMatchObject({
      id: String(user._id),
      displayName: "Max Aidentity",
      email: "max@example.com",
      avatarUrl: "data:image/png;base64,aGVsbG8="
    });

    await app.close();
  });

  it("removes the signed-in user's profile picture", async () => {
    const sessionToken = "session_test";
    const user = await createUser();
    user.avatarUrl = "data:image/png;base64,aGVsbG8=";
    const app = await buildApp(baseConfig, createCollections({ sessionToken, user }));

    const response = await app.inject({
      method: "PATCH",
      url: "/api/auth/me",
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        avatarUrl: null
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.avatarUrl).toBeNull();

    await app.close();
  });

  it("updates notification preferences", async () => {
    const sessionToken = "session_test";
    const user = await createUser();
    const app = await buildApp(baseConfig, createCollections({ sessionToken, user }));

    const response = await app.inject({
      method: "PATCH",
      url: "/api/auth/me/notifications",
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        productEmails: false,
        identityEmails: true,
        securityEmails: false
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().user.notificationPreferences).toEqual({
      productEmails: false,
      identityEmails: true,
      securityEmails: false
    });

    await app.close();
  });

  it("changes the signed-in user's password", async () => {
    const sessionToken = "session_test";
    const user = await createUser("old-password");
    const app = await buildApp(baseConfig, createCollections({ sessionToken, user }));

    const response = await app.inject({
      method: "POST",
      url: "/api/auth/me/password",
      cookies: {
        [baseConfig.SESSION_COOKIE_NAME]: sessionToken
      },
      payload: {
        currentPassword: "old-password",
        newPassword: "new-password"
      }
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({ ok: true });
    expect(await verifyPassword("new-password", user.passwordHash)).toBe(true);

    await app.close();
  });
});

function createCollections({
  sessionToken,
  user
}: {
  sessionToken: string;
  user: UserDocument;
}): Collections {
  return {
    sessions: {
      findOne: vi.fn().mockImplementation(({ tokenHash }: { tokenHash: string }) =>
        tokenHash === hashSessionToken(sessionToken, baseConfig.SESSION_SECRET)
          ? Promise.resolve({ _id: new ObjectId(), userId: user._id, tokenHash, expiresAt: new Date(Date.now() + 1000) })
          : Promise.resolve(null)
      )
    },
    users: {
      findOne: vi.fn().mockImplementation((filter: { _id?: ObjectId; email?: string } = {}) => {
        if (filter._id && !filter._id.equals(user._id)) {
          return Promise.resolve(null);
        }
        if (filter.email && filter.email !== user.email) {
          return Promise.resolve(null);
        }
        return Promise.resolve(user);
      }),
      findOneAndUpdate: vi.fn().mockImplementation((_filter: unknown, update: { $set?: Partial<UserDocument> }) => {
        Object.assign(user, update.$set ?? {});
        return Promise.resolve(user);
      }),
      updateOne: vi.fn().mockImplementation((_filter: unknown, update: { $set?: Partial<UserDocument> }) => {
        Object.assign(user, update.$set ?? {});
        return Promise.resolve({ matchedCount: 1, modifiedCount: 1 });
      })
    }
  } as unknown as Collections;
}

async function createUser(password = "password-test"): Promise<UserDocument> {
  return {
    _id: new ObjectId(),
    email: "dev@aidentity.test",
    displayName: "Dev",
    notificationPreferences: {
      productEmails: true,
      identityEmails: true,
      securityEmails: true
    },
    passwordHash: await hashPassword(password),
    createdAt: new Date("2026-05-26T10:00:00.000Z")
  } as UserDocument;
}
