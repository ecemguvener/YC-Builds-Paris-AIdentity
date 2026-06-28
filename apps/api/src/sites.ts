import type { FastifyInstance } from "fastify";
import { ObjectId } from "mongodb";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { ApiKeyDocument, AtlasProjectDocument, Collections, SiteDocument } from "./db.js";
import { requireAuth } from "./auth.js";
import { parseObjectId, getErrorMessage } from "./shared/http.js";
import { buildTrustedDashboardCorsHeaders } from "./cors.js";
import {
  generateDocumentationWithAgent,
  getAtlasDocumentationGenerationStatus,
  getAtlasAgentStatus
} from "./atlas/agent-bridge.js";
import {
  createAtlasDocumentationObject,
  loadAtlasDocumentationParts,
  saveAtlasDocumentationObject
} from "./atlas/documentation.js";
import {
  createAtlasProjectId,
  createBarkanApiKey,
  createPublicSiteKey,
  createSitePreviewImage,
  hashApiKey,
  isAtlasProjectId,
  serializeSite
} from "./security.js";

const updateSiteSchema = z.object({
  name: z.string().min(1).max(80).optional(),
  domain: z.string().min(1).max(255).optional(),
  chatTheme: z.enum(["system", "light", "dark"]).optional()
});

const createSiteApiKeySchema = z.object({
  name: z.string().min(1).max(80).optional()
});

const siteSetupSchema = z.object({
  name: z.string().min(1).max(80),
  domain: z.string().min(1).max(255)
});

const completeSiteSetupSchema = z.object({
  skipDocumentation: z.boolean().optional()
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
      error: "Create a site setup and complete documentation before creating the site."
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
    const apiKey = createBarkanApiKey();
    const apiKeyDocument: ApiKeyDocument = {
      _id: new ObjectId(),
      userId: authContext.user._id,
      projectId: project.projectId,
      keyHash: hashApiKey(apiKey),
      prefix: apiKey.slice(0, 10),
      name: `${project.name} CLI key`,
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

  app.post("/api/site-setups/:projectId/documentation/generate", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const project = await findOwnedAtlasProject(collections, authContext.user._id, (request.params as { projectId: string }).projectId);
    if (!project) {
      return reply.code(404).send({ error: "site setup not found" });
    }

    if (!getAtlasAgentStatus(project.projectId).connected) {
      return reply.code(409).send({ error: "Run npx barkan connect from the client codebase before generating documentation." });
    }

    if (!config.OPENAI_API_KEY) {
      return reply.code(503).send({ error: "Atlas AI route map generation is not configured" });
    }

    const corsHeaders = buildTrustedDashboardCorsHeaders(request.headers.origin, config);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...corsHeaders
    });

    const sendEvent = (event: string, data: Record<string, unknown>) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const documentationBundle = await generateDocumentationWithAgent({
        projectId: project.projectId,
        onEvent: (event) => sendEvent(event.type, event)
      });

      await saveAtlasDocumentationBundle(collections, authContext.user._id, project.projectId, documentationBundle);
      sendEvent("completed", {
        documentation: documentationBundle.routeMap,
        backendDocumentation: documentationBundle.backendInventory
      });
    } catch (error) {
      request.log.error({ error }, "Atlas documentation generation failed");
      sendEvent("error", { error: `Atlas documentation generation failed: ${getErrorMessage(error)}` });
    } finally {
      reply.raw.end();
    }
  });

  app.post("/api/site-setups/:projectId/complete", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const payload = completeSiteSetupSchema.parse(request.body ?? {});
    const project = await findOwnedAtlasProject(collections, authContext.user._id, (request.params as { projectId: string }).projectId);
    if (!project) {
      return reply.code(404).send({ error: "site setup not found" });
    }

    const existingDocumentation = await loadAtlasDocumentationParts(collections, authContext.user._id, project.projectId);
    if (!payload.skipDocumentation && !existingDocumentation.documentation) {
      return reply.code(409).send({ error: "Generate documentation before creating the site." });
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

    return serializeSiteDetail(
      site,
      buildSnippet(config.PUBLIC_API_URL, site.publicSiteKey),
      await collections.apiKeys
        .find({ userId: authContext.user._id, siteId: site._id })
        .sort({ createdAt: -1 })
        .toArray(),
      await loadSiteDocumentationState(collections, authContext.user._id, site._id)
    );
  });

  app.get("/api/sites/:siteId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      return reply.code(404).send({ error: "site not found" });
    }

    const site = await collections.sites.findOne({
      _id: siteId,
      ownerUserId: authContext.user._id
    });

    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    const apiKeys = await collections.apiKeys
      .find({ userId: authContext.user._id, siteId: site._id })
      .sort({ createdAt: -1 })
      .toArray();
    const documentationState = await loadSiteDocumentationState(collections, authContext.user._id, site._id);

    return {
      site: serializeSite(site),
      snippet: buildSnippet(config.PUBLIC_API_URL, site.publicSiteKey),
      apiKeys: apiKeys.map(serializeApiKey),
      documentation: documentationState.documentation,
      backendDocumentation: documentationState.backendDocumentation,
      sourceContext: null,
      documentationAgent: documentationState.documentationAgent,
      documentationGeneration: documentationState.documentationGeneration
    };
  });

  app.get("/api/sites/:siteId/documentation-agent", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      return reply.code(404).send({ error: "site not found" });
    }

    const site = await collections.sites.findOne({
      _id: siteId,
      ownerUserId: authContext.user._id
    });
    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    return {
      documentationAgent: await loadSiteDocumentationAgent(collections, authContext.user._id, site._id)
    };
  });

  app.get("/api/atlas/projects/:projectId/documentation", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const projectId = (request.params as { projectId: string }).projectId;
    const atlasProject = await collections.atlasProjects.findOne({
      ownerUserId: authContext.user._id,
      projectId
    });

    if (!atlasProject) {
      return reply.code(404).send({ error: "Atlas project not found" });
    }

    const [site, documentationState] = await Promise.all([
      atlasProject.siteId
        ? collections.sites.findOne({
            _id: atlasProject.siteId,
            ownerUserId: authContext.user._id
          })
        : Promise.resolve(null),
      loadAtlasDocumentationParts(collections, authContext.user._id, atlasProject.projectId)
    ]);

    return {
      project: serializeAtlasProject(atlasProject),
      site: site ? serializeSite(site) : null,
      documentation: documentationState.documentation,
      backendDocumentation: documentationState.backendDocumentation
    };
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

    if (payload.chatTheme) {
      update.chatTheme = payload.chatTheme;
    }

    const result = await collections.sites.findOneAndUpdate(
      { _id: siteId, ownerUserId: authContext.user._id },
      { $set: update },
      { returnDocument: "after" }
    );

    if (!result) {
      return reply.code(404).send({ error: "site not found" });
    }

    return { site: serializeSite(result), snippet: buildSnippet(config.PUBLIC_API_URL, result.publicSiteKey) };
  });

  app.post("/api/sites/:siteId/documentation/generate", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      return reply.code(404).send({ error: "site not found" });
    }

    const site = await collections.sites.findOne({
      _id: siteId,
      ownerUserId: authContext.user._id
    });
    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    const atlasProject = await collections.atlasProjects.findOne({
      ownerUserId: authContext.user._id,
      siteId: site._id
    });
    if (!atlasProject) {
      return reply.code(409).send({ error: "Connect to your codebase with npx barkan connect before generating documentation." });
    }

    if (!getAtlasAgentStatus(atlasProject.projectId).connected) {
      return reply.code(409).send({ error: "Run npx barkan connect from the client codebase before generating documentation." });
    }

    if (!config.OPENAI_API_KEY) {
      return reply.code(503).send({ error: "Atlas AI route map generation is not configured" });
    }

    const corsHeaders = buildTrustedDashboardCorsHeaders(request.headers.origin, config);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      ...corsHeaders
    });

    const sendEvent = (event: string, data: Record<string, unknown>) => {
      reply.raw.write(`event: ${event}\n`);
      reply.raw.write(`data: ${JSON.stringify(data)}\n\n`);
    };

    try {
      const documentationBundle = await generateDocumentationWithAgent({
        projectId: atlasProject.projectId,
        onEvent: (event) => sendEvent(event.type, event)
      });

      await saveAtlasDocumentationBundle(collections, authContext.user._id, atlasProject.projectId, documentationBundle);

      sendEvent("completed", {
        documentation: documentationBundle.routeMap,
        backendDocumentation: documentationBundle.backendInventory
      });
    } catch (error) {
      request.log.error({ error }, "Atlas documentation generation failed");
      sendEvent("error", { error: `Atlas documentation generation failed: ${getErrorMessage(error)}` });
    } finally {
      reply.raw.end();
    }
  });

  app.delete("/api/sites/:siteId", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      return reply.code(404).send({ error: "site not found" });
    }

    const site = await collections.sites.findOne({
      _id: siteId,
      ownerUserId: authContext.user._id
    });

    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    const atlasProjects = await collections.atlasProjects
      .find({ ownerUserId: authContext.user._id, siteId: site._id })
      .toArray();
    const atlasProjectIds = atlasProjects.map((project) => project.projectId);

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
      collections.interactionLogs.deleteMany({ siteId: site._id }),
      atlasProjectIds.length > 0
        ? collections.atlasDocuments.deleteMany({
            ownerUserId: authContext.user._id,
            projectId: { $in: atlasProjectIds }
          })
        : Promise.resolve()
    ]);

    return { ok: true };
  });

  app.post("/api/sites/:siteId/api-keys", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    const siteId = parseObjectId((request.params as { siteId: string }).siteId);
    if (!siteId) {
      return reply.code(404).send({ error: "site not found" });
    }

    const site = await collections.sites.findOne({
      _id: siteId,
      ownerUserId: authContext.user._id
    });

    if (!site) {
      return reply.code(404).send({ error: "site not found" });
    }

    const payload = createSiteApiKeySchema.parse(request.body ?? {});
    const atlasProject = await findOrCreateSiteAtlasProject(collections, site);
    const apiKey = createBarkanApiKey();
    const now = new Date();
    const insertResult = await collections.apiKeys.insertOne({
      _id: new ObjectId(),
      userId: authContext.user._id,
      siteId: site._id,
      projectId: atlasProject.projectId,
      keyHash: hashApiKey(apiKey),
      prefix: apiKey.slice(0, 10),
      name: payload.name?.trim() || `${site.name} CLI key`,
      createdAt: now
    });

    return reply.code(201).send({
      apiKey: {
        id: String(insertResult.insertedId),
        name: payload.name?.trim() || `${site.name} CLI key`,
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
      return reply.code(404).send({ error: "API key not found" });
    }

    const deleteResult = await collections.apiKeys.deleteOne({
      _id: apiKeyId,
      userId: authContext.user._id,
      siteId
    });

    if (deleteResult.deletedCount === 0) {
      return reply.code(404).send({ error: "API key not found" });
    }

    return { ok: true };
  });
}

export function buildSnippet(publicApiUrl: string, publicSiteKey: string): string {
  return `<script async src="${publicApiUrl.replace(/\/$/, "")}/widget.js" data-barkan-site="${publicSiteKey}"></script>`;
}

function serializeSiteDetail(
  site: SiteDocument,
  snippet: string,
  apiKeys: ApiKeyDocument[],
  documentationState: {
    documentation: unknown | null;
    backendDocumentation: unknown | null;
    documentationAgent: {
      projectId: string;
      connected: boolean;
      connectedAt: string | null;
    } | null;
    documentationGeneration: ReturnType<typeof getAtlasDocumentationGenerationStatus>;
  }
) {
  return {
    site: serializeSite(site),
    snippet,
    apiKeys: apiKeys.map(serializeApiKey),
    documentation: documentationState.documentation,
    backendDocumentation: documentationState.backendDocumentation,
    sourceContext: null,
    documentationAgent: documentationState.documentationAgent,
    documentationGeneration: documentationState.documentationGeneration
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
  const [documentationState, apiKeys] = await Promise.all([
    loadAtlasDocumentationParts(collections, ownerUserId, project.projectId),
    collections.apiKeys
      .find({ userId: ownerUserId, projectId: project.projectId })
      .sort({ createdAt: -1 })
      .toArray()
  ]);
  const agentStatus = getAtlasAgentStatus(project.projectId);

  return {
    setup: serializeSiteSetup(project),
    apiKeys: apiKeys.map(serializeApiKey),
    documentation: documentationState.documentation,
    backendDocumentation: documentationState.backendDocumentation,
    documentationAgent: {
      projectId: project.projectId,
      connected: agentStatus.connected,
      connectedAt: agentStatus.connectedAt
    },
    documentationGeneration: getAtlasDocumentationGenerationStatus(project.projectId)
  };
}

async function createSiteFromSetup(
  collections: Collections,
  ownerUserId: ObjectId,
  project: AtlasProjectDocument
): Promise<SiteDocument> {
  if (!project.pendingSiteDomain) {
    throw new Error("Site setup is missing a domain.");
  }

  const now = new Date();
  const insertResult = await collections.sites.insertOne({
    _id: new ObjectId(),
    ownerUserId,
    name: project.name,
    domain: project.pendingSiteDomain,
    publicSiteKey: createPublicSiteKey(),
    previewImage: createSitePreviewImage(),
    chatTheme: "system",
    createdAt: now,
    updatedAt: now
  });
  const site = await collections.sites.findOne({ _id: insertResult.insertedId, ownerUserId });
  if (!site) {
    throw new Error("could not create site");
  }

  return site;
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

async function saveAtlasDocumentationBundle(
  collections: Collections,
  ownerUserId: ObjectId,
  projectId: string,
  documentation: {
    routeMap: unknown;
    backendInventory: unknown;
  }
) {
  await saveAtlasDocumentationObject(
    collections,
    ownerUserId,
    projectId,
    createAtlasDocumentationObject(documentation)
  );
}

function normalizeDomain(domain: string): string {
  return domain
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}



async function loadSiteDocumentationState(
  collections: Collections,
  ownerUserId: ObjectId,
  siteId: ObjectId
): Promise<{
  documentation: unknown | null;
  backendDocumentation: unknown | null;
  documentationAgent: {
    projectId: string;
    connected: boolean;
    connectedAt: string | null;
  } | null;
  documentationGeneration: ReturnType<typeof getAtlasDocumentationGenerationStatus>;
}> {
  const atlasProject = await collections.atlasProjects.findOne({
    ownerUserId,
    siteId
  });

  if (!atlasProject) {
    return { documentation: null, backendDocumentation: null, documentationAgent: null, documentationGeneration: null };
  }

  const documentationState = await loadAtlasDocumentationParts(collections, ownerUserId, atlasProject.projectId);

  return {
    documentation: documentationState.documentation,
    backendDocumentation: documentationState.backendDocumentation,
    documentationAgent: serializeDocumentationAgentStatus(atlasProject.projectId),
    documentationGeneration: getAtlasDocumentationGenerationStatus(atlasProject.projectId)
  };
}

async function loadSiteDocumentationAgent(
  collections: Collections,
  ownerUserId: ObjectId,
  siteId: ObjectId
): Promise<{
  projectId: string;
  connected: boolean;
  connectedAt: string | null;
} | null> {
  const atlasProject = await collections.atlasProjects.findOne({
    ownerUserId,
    siteId
  });

  return atlasProject ? serializeDocumentationAgentStatus(atlasProject.projectId) : null;
}

function serializeDocumentationAgentStatus(projectId: string) {
  const agentStatus = getAtlasAgentStatus(projectId);
  return {
    projectId,
    connected: agentStatus.connected,
    connectedAt: agentStatus.connectedAt
  };
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

function serializeAtlasProject(project: AtlasProjectDocument) {
  return {
    id: project.projectId,
    name: project.name,
    createdAt: project.createdAt.toISOString(),
    updatedAt: project.updatedAt.toISOString()
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


