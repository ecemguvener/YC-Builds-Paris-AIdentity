import { MongoClient, type Collection, type Db, type Document, ObjectId } from "mongodb";
import type { AppConfig } from "./config.js";

export interface UserDocument extends Document {
  _id: ObjectId;
  email: string;
  displayName?: string;
  avatarUrl?: string | null;
  notificationPreferences?: {
    productEmails: boolean;
    identityEmails?: boolean;
    securityEmails: boolean;
  };
  passwordHash: string;
  createdAt: Date;
  updatedAt?: Date;
}

export interface SessionDocument extends Document {
  _id: ObjectId;
  userId: ObjectId;
  tokenHash: string;
  expiresAt: Date;
  createdAt: Date;
}

export interface SiteDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  name: string;
  domain: string;
  publicSiteKey: string;
  previewImage?: string;
  chatTheme?: "system" | "light" | "dark";
  interactionEngine?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface ApiKeyDocument extends Document {
  _id: ObjectId;
  userId: ObjectId;
  siteId?: ObjectId;
  projectId?: string;
  keyHash: string;
  prefix: string;
  name: string;
  createdAt: Date;
  lastUsedAt?: Date;
}

export interface AtlasProjectDocument extends Document {
  _id: ObjectId;
  ownerUserId: ObjectId;
  siteId?: ObjectId;
  projectId: string;
  name: string;
  pendingSiteDomain?: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface InteractionLogDocument extends Document {
  _id: ObjectId;
  siteId: ObjectId;
  origin: string | null;
  status: "ok" | "error";
  durationMs?: number;
  error?: string;
  createdAt: Date;
}

export interface Collections {
  users: Collection<UserDocument>;
  sessions: Collection<SessionDocument>;
  sites: Collection<SiteDocument>;
  apiKeys: Collection<ApiKeyDocument>;
  atlasProjects: Collection<AtlasProjectDocument>;
  interactionLogs: Collection<InteractionLogDocument>;
}

export interface Database {
  client: MongoClient;
  db: Db;
  collections: Collections;
}

export async function connectDatabase(config: AppConfig): Promise<Database> {
  const client = new MongoClient(config.MONGODB_URI);
  await client.connect();
  const db = client.db();
  const collections: Collections = {
    users: db.collection<UserDocument>("users"),
    sessions: db.collection<SessionDocument>("sessions"),
    sites: db.collection<SiteDocument>("sites"),
    apiKeys: db.collection<ApiKeyDocument>("apiKeys"),
    atlasProjects: db.collection<AtlasProjectDocument>("atlasProjects"),
    interactionLogs: db.collection<InteractionLogDocument>("interactionLogs")
  };

  await Promise.all([
    collections.users.createIndex({ email: 1 }, { unique: true }),
    collections.sessions.createIndex({ tokenHash: 1 }, { unique: true }),
    collections.sessions.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    collections.sites.createIndex({ ownerUserId: 1 }),
    collections.sites.createIndex({ publicSiteKey: 1 }, { unique: true }),
    collections.apiKeys.createIndex({ keyHash: 1 }, { unique: true }),
    collections.apiKeys.createIndex({ userId: 1 }),
    collections.apiKeys.createIndex({ userId: 1, siteId: 1, createdAt: -1 }),
    collections.apiKeys.createIndex({ userId: 1, projectId: 1, createdAt: -1 }),
    collections.atlasProjects.createIndex({ projectId: 1 }, { unique: true }),
    collections.atlasProjects.createIndex({ ownerUserId: 1 }),
    collections.interactionLogs.createIndex({ siteId: 1, createdAt: -1 })
  ]);

  return { client, db, collections };
}
