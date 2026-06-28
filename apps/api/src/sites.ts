import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ApiKeyDocument, AtlasProjectDocument, Collections, SiteDocument } from "./db.js";
import { requireAuth } from "./auth.js";
import {
  createAtlasProjectId,
  createAidentityApiKey,
  createPublicSiteKey,
  createSitePreviewImage,
  hashApiKey,
  isAtlasProjectId,
  serializeSite
} from "./security.js";

const updateSiteSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  domain: z.string().min(1).max(255).optional()
});

const createSiteApiKeySchema = z.object({
  name: z.string().min(1).max(80).optional()
});

const siteSetupSchema = z.object({
  name: z.string().min(1).max(80),
  domain: z.string().min(1).max(255)
});

export function registerSiteRoutes(
  app: FastifyInstance,
  collections: Collections,
  config: AppConfig
) {
  app.get("/api/sites", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const sites = await collections.sites
      .find({ ownerUserId: authContext.user._id })
      .sort({ createdAt: -1 })
      .toArray();

    return { sites: sites.map(serializeSite) };
  });

  app.post("/api/sites", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    return reply.code(409).send({
      error: "Create an agent identity setup before creating the identity."
    });
  });

  app.post("/api/site-setups", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const payload = siteSetupSchema.parse(request.body);
    const now = new Date();
    const project: AtlasProjectDocument = {
      _id: new ObjectId(),
      ownerUserId: authContext.user._id,
      projectId: createAtlasProjectId(),
      name: payload.name.trim(),
      pendingSiteDomain: normalizeDomain(payload.domain),
      createdAt: now,
      updatedAt: now
    } as AtlasProjectDocument;
    const apiKey = createAidentityApiKey();
    const apiKeyDocument: ApiKeyDocument = {
      _id: new ObjectId(),
      userId: authContext.user._id,
      projectId: project.projectId,
      keyHash: hashApiKey(apiKey),
      prefix: apiKey.slice(0, 10),
      name: `${project.name} link token`,
      createdAt: now
    } as ApiKeyDocument;

    await collections.atlasProjects.insertOne(project);
    await collections.apiKeys.insertOne(apiKeyDocument);

    return reply.code(201).send({
      setup: serializeSiteSetup(project),
      apiKey: serializeApiKey(apiKeyDocument),
      secret: apiKey
    });
  });

  app.get("/api/site-setups/:projectId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const project = await findOwnedAtlasProject(collections, authContext.user._id, (request.params as { projectId: string }).projectId);
    if (!project) {
      return reply.code(404).send({ error: "site setup not found" });
    }

    return buildSiteSetupState(collections, authContext.user._id, project);
  });

  app.post("/api/site-setups/:projectId/complete", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const project = await findOwnedAtlasProject(collections, authContext.user._id, (request.params as { projectId: string }).projectId);
    if (!project) {
      return reply.code(404).send({ error: "site setup not found" });
    }

    const existingSite = project.siteId
      ? await collections.sites.findOne({ _id: project.siteId, ownerUserId: authContext.user._id })
      : null;
    const site = existingSite ?? await createSiteFromSetup(collections, authContext.user._id, project);
    await collections.atlasProjects.updateOne(
      { _id: project._id },
      { $set: { siteId: site._id, updatedAt: new Date() } }
    );
    await collections.apiKeys.updateMany(
      { userId: authContext.user._id, projectId: project.projectId },
      { $set: { siteId: site._id } }
    );

    const apiKeys = await collections.apiKeys
      .find({ userId: authContext.user._id, siteId: site._id })
      .sort({ createdAt: -1 })
      .toArray();

    return serializeSiteDetail(site, apiKeys);
  });

  app.get("/api/sites/:siteId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const site = await findOwnedSite(collections, authContext.user._id, (request.params as { siteId: string }).siteId);
    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    const apiKeys = await collections.apiKeys
      .find({ userId: authContext.user._id, siteId: site._id })
      .sort({ createdAt: -1 })
      .toArray();

    return serializeSiteDetail(site, apiKeys);
  });

  app.patch("/api/sites/:siteId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      return reply.code(404).send({ error: "site not found" });
    }

    const payload = updateSiteSchema.parse(request.body);
    const update: Record<string, unknown> = { updatedAt: new Date() };

    if (payload.name) {
      update.name = payload.name.trim();
    }

    if (payload.domain) {
      update.domain = normalizeDomain(payload.domain);
    }

    const result = await collections.sites.findOneAndUpdate(
      { _id: siteId, ownerUserId: authContext.user._id },
      { $set: update },
      { returnDocument: "after" }
    );

    if (!result) {
      return reply.code(404).send({ error: "site not found" });
    }

    return { site: serializeSite(result) };
  });

  app.delete("/api/sites/:siteId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const site = await findOwnedSite(collections, authContext.user._id, (request.params as { siteId: string }).siteId);
    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    const deleteResult = await collections.sites.deleteOne({
      _id: site._id,
      ownerUserId: authContext.user._id
    });

    if (deleteResult.deletedCount === 0) {
      return reply.code(404).send({ error: "site not found" });
    }

    await Promise.all([
      collections.apiKeys.deleteMany({ userId: authContext.user._id, siteId: site._id }),
      collections.atlasProjects.deleteMany({ ownerUserId: authContext.user._id, siteId: site._id }),
      collections.interactionLogs.deleteMany({ siteId: site._id })
    ]);

    return { ok: true };
  });

  app.post("/api/sites/:siteId/api-keys", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const site = await findOwnedSite(collections, authContext.user._id, (request.params as { siteId: string }).siteId);
    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    const payload = createSiteApiKeySchema.parse(request.body ?? {});
    const atlasProject = await findOrCreateSiteAtlasProject(collections, site);
    const apiKey = createAidentityApiKey();
    const now = new Date();
    const name = payload.name?.trim() || `${site.name} link token`;
    const insertResult = await collections.apiKeys.insertOne({
      _id: new ObjectId(),
      userId: authContext.user._id,
      siteId: site._id,
      projectId: atlasProject.projectId,
      keyHash: hashApiKey(apiKey),
      prefix: apiKey.slice(0, 10),
      name,
      createdAt: now
    });

    return reply.code(201).send({
      apiKey: {
        id: String(insertResult.insertedId),
        name,
        prefix: apiKey.slice(0, 10),
        createdAt: now.toISOString(),
        lastUsedAt: null
      },
      secret: apiKey
    });
  });

  app.delete("/api/sites/:siteId/api-keys/:apiKeyId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const { siteId: siteIdParam, apiKeyId: apiKeyIdParam } = request.params as {
      siteId: string;
      apiKeyId: string;
    };
    const siteId = parseObjectId(siteIdParam);
    const apiKeyId = parseObjectId(apiKeyIdParam);
    if (!siteId || !apiKeyId) {
      return reply.code(404).send({ error: "link token not found" });
    }

    const deleteResult = await collections.apiKeys.deleteOne({
      _id: apiKeyId,
      userId: authContext.user._id,
      siteId
    });

    if (deleteResult.deletedCount === 0) {
      return reply.code(404).send({ error: "link token not found" });
    }

    return { ok: true };
  });
}

function serializeSiteDetail(site: SiteDocument, apiKeys: ApiKeyDocument[]) {
  return {
    site: serializeSite(site),
    apiKeys: apiKeys.map(serializeApiKey)
  };
}

function serializeSiteSetup(project: AtlasProjectDocument) {
  return {
    projectId: project.projectId,
    name: project.name,
    domain: project.pendingSiteDomain ?? "",
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
  };
}

async function buildSiteSetupState(
  collections: Collections,
  ownerUserId: ObjectId,
  project: AtlasProjectDocument
) {
  const apiKeys = await collections.apiKeys
    .find({ userId: ownerUserId, projectId: project.projectId })
    .sort({ createdAt: -1 })
    .toArray();

  return {
    setup: serializeSiteSetup(project),
    apiKeys: apiKeys.map(serializeApiKey)
  };
}

async function createSiteFromSetup(
  collections: Collections,
  ownerUserId: ObjectId,
  project: AtlasProjectDocument
): Promise<SiteDocument> {
  if (!project.pendingSiteDomain) {
    throw new Error("Agent identity setup is missing an OpenClaw endpoint.");
  }

  const now = new Date();
  const insertResult = await collections.sites.insertOne({
    _id: new ObjectId(),
    ownerUserId,
    name: project.name,
    domain: project.pendingSiteDomain,
    publicSiteKey: createPublicSiteKey(),
    previewImage: createSitePreviewImage(),
    createdAt: now,
    updatedAt: now
  });
  const site = await collections.sites.findOne({ _id: insertResult.insertedId, ownerUserId });
  if (!site) {
    throw new Error("could not create agent identity");
  }

  return site;
}

async function findOwnedSite(
  collections: Collections,
  ownerUserId: ObjectId,
  siteId: string
): Promise<SiteDocument | null> {
  const objectId = parseObjectId(siteId);
  if (!objectId) {
    return null;
  }

  return collections.sites.findOne({
    _id: objectId,
    ownerUserId
  });
}

async function findOwnedAtlasProject(
  collections: Collections,
  ownerUserId: ObjectId,
  projectId: string
): Promise<AtlasProjectDocument | null> {
  if (!isAtlasProjectId(projectId)) {
    return null;
  }

  return collections.atlasProjects.findOne({
    ownerUserId,
    projectId
  });
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

function parseObjectId(value: string): ObjectId | null {
  return ObjectId.isValid(value) ? new ObjectId(value) : null;
}

function serializeApiKey(apiKey: ApiKeyDocument) {
  return {
    id: String(apiKey._id),
    name: apiKey.name,
    prefix: apiKey.prefix,
    createdAt: apiKey.createdAt.toISOString(),
    lastUsedAt: apiKey.lastUsedAt ? apiKey.lastUsedAt.toISOString() : null
  };
}

async function findOrCreateSiteAtlasProject(
  collections: Collections,
  site: SiteDocument
): Promise<AtlasProjectDocument> {
  const existingProject = await collections.atlasProjects.findOne({
    ownerUserId: site.ownerUserId,
    siteId: site._id
  });
  if (existingProject) {
    if (!isAtlasProjectId(existingProject.projectId)) {
      return repairSiteAtlasProject(collections, existingProject);
    }

    return existingProject;
  }

  const now = new Date();
  const project: AtlasProjectDocument = {
    _id: new ObjectId(),
    ownerUserId: site.ownerUserId,
    siteId: site._id,
    projectId: createAtlasProjectId(),
    name: site.name,
    createdAt: now,
    updatedAt: now
  } as AtlasProjectDocument;

  await collections.atlasProjects.insertOne(project);
  return project;
}

async function repairSiteAtlasProject(
  collections: Collections,
  project: AtlasProjectDocument
): Promise<AtlasProjectDocument> {
  const repairedProject = {
    ...project,
    projectId: createAtlasProjectId(),
    updatedAt: new Date()
  };

  await collections.atlasProjects.updateOne(
    { _id: project._id },
    {
      $set: {
        projectId: repairedProject.projectId,
        updatedAt: repairedProject.updatedAt
      }
    }
  );

  return repairedProject;
}
