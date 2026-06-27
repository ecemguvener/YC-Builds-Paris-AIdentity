import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";
import type { AppConfig } from "./config.js";
import type { Collections, SiteDocument } from "./db.js";
import { requireAuth } from "./auth.js";
import { buildTrustedDashboardCorsHeaders } from "./cors.js";
import { buildOpenAIEndpointUrl } from "./openai.js";
import { createPurchaseFromPrompt, formatPurchaseAmount, PaymentError, provisionPaymentIdentity } from "./payments.js";
import { EmailError, sendSiteEmailFromText } from "./email.js";

const DASHBOARD_CHAT_MODEL = "gpt-5.4-mini-2026-03-17";
const dashboardChatMessageSchema = z.object({
  role: z.enum(["user", "assistant"]),
  content: z.string().min(1).max(8000)
});

const dashboardChatRequestSchema = z.object({
  messages: z.array(dashboardChatMessageSchema).min(1).max(24)
});

const dashboardChatInstructions = `
You are Barkan, an AI assistant inside the Barkan dashboard.

Style:
- Be direct, calm, and useful.
- Keep answers concise unless the user asks for detail.
- Format responses with GitHub-flavored Markdown. The dashboard supports paragraphs, headings, bold, italic, links, inline code, fenced code blocks, ordered and unordered lists, task lists, blockquotes, tables, strikethrough, and autolinks.
- Use lists, code fences, and tables when they make the answer easier to scan. Do not use markdown tables unless they clearly help.
- When the user asks for a table, output a real GitHub-flavored Markdown table directly in the response. Do not wrap markdown tables in fenced code blocks.
- For markdown tables, include one valid separator row directly after the header row, with exactly one separator cell per header cell, for example: | --- | --- | --- |
- Use fenced code blocks only for source code, shell commands, JSON, config, or other literal code/file content.
- Keep markdown syntax valid: put blank lines around lists, headings, blockquotes, tables, and code fences.
- Do not claim to have changed settings or performed actions unless the dashboard API context explicitly says so.

You can help with:
- Creating sites
- Installing the widget snippet
- CLI connection with npx barkan connect
- Documentation generation and regeneration
- API keys
- Understanding dashboard flows

If the user asks something outside Barkan, still answer normally as a helpful AI assistant.
`.trim();

export function registerDashboardChatRoutes(app: FastifyInstance, collections: Collections, config: AppConfig) {
  app.post("/api/dashboard/chat", async (request, reply) => {
    const authContext = await requireAuth(request, reply, collections, config);
    if (!authContext) {
      return;
    }

    if (!config.OPENAI_API_KEY) {
      return reply.code(503).send({ error: "OpenAI is not configured" });
    }

    const payload = dashboardChatRequestSchema.parse(request.body);
    const sites = await collections.sites
      .find({ ownerUserId: authContext.user._id })
      .sort({ createdAt: -1 })
      .limit(50)
      .toArray();

    // If the latest message is a shopping instruction, drive the payment tool
    // directly and stream a confirmation instead of a normal chat reply.
    const latestUserMessage = [...payload.messages].reverse().find((message) => message.role === "user");
    if (latestUserMessage && isPurchaseIntent(latestUserMessage.content)) {
      const message = await runChatPurchase(latestUserMessage.content, sites, config);
      streamChatMessage(request, reply, config, message);
      return;
    }

    // If the latest message is an email instruction, drive the email tool and
    // stream a confirmation instead of a normal chat reply.
    if (latestUserMessage && isEmailIntent(latestUserMessage.content)) {
      const message = await runChatEmail(latestUserMessage.content, sites, config);
      streamChatMessage(request, reply, config, message);
      return;
    }

    const upstreamResponse = await fetch(buildOpenAIEndpointUrl(), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${config.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: DASHBOARD_CHAT_MODEL,
        instructions: dashboardChatInstructions,
        input: [
          {
            role: "user",
            content: [
              {
                type: "input_text",
                text: buildDashboardChatPrompt(payload.messages, sites)
              }
            ]
          }
        ],
        reasoning: { effort: "none" },
        text: { verbosity: "low" },
        max_output_tokens: 700,
        stream: true
      })
    });

    if (!upstreamResponse.ok) {
      const responseText = await upstreamResponse.text();
      request.log.error({ status: upstreamResponse.status, body: responseText }, "dashboard chat OpenAI request failed");
      return reply.code(502).send({ error: "AI response failed" });
    }

    if (!upstreamResponse.body) {
      request.log.error("dashboard chat OpenAI response did not include a stream body");
      return reply.code(502).send({ error: "AI response was empty" });
    }

    const corsHeaders = buildTrustedDashboardCorsHeaders(request.headers.origin, config);
    reply.hijack();
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
      ...corsHeaders
    });

    writeDashboardChatEvent(reply, { type: "ready", model: DASHBOARD_CHAT_MODEL });

    const reader = upstreamResponse.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let emittedTextChunkCount = 0;

    try {
      while (true) {
        const { done, value } = await reader.read();
        buffer += decoder.decode(value ?? new Uint8Array(), { stream: !done });
        const drained = drainOpenAISseEvents(buffer);
        buffer = drained.remainingBuffer;

        for (const eventData of drained.events) {
          const delta = extractOpenAITextDelta(eventData);
          if (delta) {
            writeDashboardChatEvent(reply, { type: "delta", text: delta });
            emittedTextChunkCount++;
          }
        }

        if (done) {
          break;
        }
      }

      const finalDrained = drainOpenAISseEvents(`${buffer}\n\n`);
      for (const eventData of finalDrained.events) {
        const delta = extractOpenAITextDelta(eventData);
        if (delta) {
          writeDashboardChatEvent(reply, { type: "delta", text: delta });
          emittedTextChunkCount++;
        }
      }

      if (emittedTextChunkCount === 0) {
        writeDashboardChatEvent(reply, { type: "error", error: "AI response was empty" });
      }

      writeDashboardChatEvent(reply, { type: "done" });
    } catch (error) {
      request.log.error({ error }, "dashboard chat OpenAI stream failed");
      writeDashboardChatEvent(reply, { type: "error", error: "AI response failed" });
    } finally {
      reply.raw.end();
    }
  });
}

function buildDashboardChatPrompt(
  messages: Array<z.infer<typeof dashboardChatMessageSchema>>,
  sites: SiteDocument[]
): string {
  return `dashboard context:
${JSON.stringify({
  sites: sites.map((site) => ({
    name: site.name,
    domain: site.domain,
    createdAt: site.createdAt,
    updatedAt: site.updatedAt
  }))
})}

conversation:
${messages.map((message) => `${message.role}: ${message.content}`).join("\n")}`;
}

function isPurchaseIntent(text: string): boolean {
  return /\b(buy|purchase|order|pay for|top up|grab me|get me|buy me)\b/i.test(text);
}

function resolvePurchaseSite(text: string, sites: SiteDocument[]): SiteDocument | null {
  const lowered = text.toLowerCase();
  return sites.find((site) => site.name && lowered.includes(site.name.toLowerCase())) ?? sites[0] ?? null;
}

async function runChatPurchase(
  text: string,
  sites: SiteDocument[],
  config: AppConfig
): Promise<string> {
  const site = resolvePurchaseSite(text, sites);
  if (!site) {
    return "You don't have an agent identity yet. Create one first, then I can shop on its behalf.";
  }

  const accountId = site._id.toHexString();
  provisionPaymentIdentity(accountId);

  try {
    const { purchase, parsed } = await createPurchaseFromPrompt(accountId, text, config);
    const merchant = parsed.merchantUrl ? `[${parsed.merchantName}](${parsed.merchantUrl})` : parsed.merchantName;
    const amount = formatPurchaseAmount(parsed.amount, parsed.currency);
    const estimated = parsed.priceEstimated ? " _(estimated)_" : "";
    const header = `🛒 **${merchant}** — ${amount}${estimated} for **${site.name}**`;

    if (purchase.status === "approved") {
      return `${header}\n\n✅ **Approved** automatically (${purchase.decisionReason}). Open the **Payments** tab on **${site.name}** and hit **Execute** to pay.`;
    }
    if (purchase.status === "requires_approval") {
      return `${header}\n\n⏳ **Needs your approval** — ${purchase.decisionReason}. Review it in the **Payments** tab on **${site.name}**.`;
    }
    if (purchase.status === "rejected") {
      return `${header}\n\n⛔ **Rejected** — ${purchase.decisionReason}.`;
    }
    return `${header}\n\nStatus: **${purchase.status}** — ${purchase.decisionReason}.`;
  } catch (error) {
    if (error instanceof PaymentError) {
      return `I couldn't complete that purchase: ${error.message}`;
    }
    throw error;
  }
}

function isEmailIntent(text: string): boolean {
  return /\be-?mail\b/i.test(text) && /\b(ask|tell|send|reply|write|invite|follow up|let .* know|about|to)\b/i.test(text);
}

async function runChatEmail(text: string, sites: SiteDocument[], config: AppConfig): Promise<string> {
  const site = resolvePurchaseSite(text, sites);
  if (!site) {
    return "You don't have an agent identity yet. Create one first, then I can send email on its behalf.";
  }

  const accountId = site._id.toHexString();
  try {
    const { message, parsed } = await sendSiteEmailFromText(accountId, site.name, text, config);
    const draftedBy = parsed?.parsedBy === "openai" ? "" : " _(templated draft)_";
    const quotedBody = message.body.split("\n").join("\n> ");
    const header = `✉️ **Email ${message.status === "sent" ? "sent" : "failed"}** from **${site.name}** (\`${message.fromEmail}\`)`;
    return `${header}\n\n**To:** ${message.toEmail}\n**Subject:** ${message.subject}${draftedBy}\n\n> ${quotedBody}\n\nSee the **Email** tab on **${site.name}** for the full activity log.`;
  } catch (error) {
    if (error instanceof EmailError) {
      return error.status === 422
        ? `I drafted that email but couldn't find a recipient address. Tell me who to send it to (include their email), e.g. "email sarah@acme.com and ask…".`
        : `I couldn't send that email: ${error.message}`;
    }
    throw error;
  }
}

function streamChatMessage(request: FastifyRequest, reply: FastifyReply, config: AppConfig, text: string) {
  const corsHeaders = buildTrustedDashboardCorsHeaders(request.headers.origin, config);
  reply.hijack();
  reply.raw.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
    ...corsHeaders
  });
  writeDashboardChatEvent(reply, { type: "ready", model: "barkan-payments" });
  writeDashboardChatEvent(reply, { type: "delta", text });
  writeDashboardChatEvent(reply, { type: "done" });
  reply.raw.end();
}

function writeDashboardChatEvent(reply: FastifyReply, payload: Record<string, unknown>) {
  reply.raw.write(`data: ${JSON.stringify(payload)}\n\n`);
}

function drainOpenAISseEvents(buffer: string): { events: Array<Record<string, unknown>>; remainingBuffer: string } {
  const blocks = buffer.split(/\n\n/);
  const remainingBuffer = blocks.pop() ?? "";
  const events: Array<Record<string, unknown>> = [];

  for (const block of blocks) {
    const dataLines = block
      .split(/\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice("data:".length).trim());

    for (const dataLine of dataLines) {
      if (!dataLine || dataLine === "[DONE]") {
        continue;
      }

      try {
        const parsed = JSON.parse(dataLine) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          events.push(parsed as Record<string, unknown>);
        }
      } catch {
        continue;
      }
    }
  }

  return { events, remainingBuffer };
}

function extractOpenAITextDelta(eventData: Record<string, unknown>): string {
  if (eventData.type === "response.output_text.delta" && typeof eventData.delta === "string") {
    return eventData.delta;
  }

  return "";
}
