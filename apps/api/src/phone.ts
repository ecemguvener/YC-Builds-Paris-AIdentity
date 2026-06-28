import type { AppConfig } from "./config.js";
import { readNonEmptyString } from "./shared/http.js";

export interface PhoneCallRequest {
  toNumber: string;
  task: string;
  agentIdentityName: string;
  recipientName?: string | null;
  context?: string | null;
  sourceUrl?: string | null;
}

export interface PhoneCallResult {
  ok: boolean;
  provider: "elevenlabs" | "mock-elevenlabs";
  simulated: boolean;
  callId: string;
  toNumber: string;
  agentIdentityName: string;
  task: string;
  status: string;
  detail: string;
}

export class PhoneCallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PhoneCallError";
  }
}

export async function placeAgentPhoneCall(request: PhoneCallRequest, config: AppConfig): Promise<PhoneCallResult> {
  const toNumber = normalizePhoneNumber(request.toNumber);
  if (!toNumber) {
    throw new PhoneCallError("The phone number must be an E.164-style number, for example +14155550198.");
  }

  const task = request.task.trim();
  if (!task) {
    throw new PhoneCallError("The call task cannot be empty.");
  }

  if (!config.ELEVENLABS_API_KEY || !config.ELEVENLABS_AGENT_ID || !config.ELEVENLABS_AGENT_PHONE_NUMBER_ID) {
    return {
      ok: true,
      provider: "mock-elevenlabs",
      simulated: true,
      callId: `mock_call_${Date.now().toString(36)}`,
      toNumber,
      agentIdentityName: request.agentIdentityName,
      task,
      status: "queued",
      detail:
        "Mock call queued. Set ELEVENLABS_API_KEY, ELEVENLABS_AGENT_ID, and ELEVENLABS_AGENT_PHONE_NUMBER_ID to place a real outbound ElevenLabs call."
    };
  }

  const callBrief = buildPersonalAssistantCallBrief(request, task);
  const upstreamResponse = await fetch("https://api.elevenlabs.io/v1/convai/twilio/outbound-call", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "xi-api-key": config.ELEVENLABS_API_KEY
    },
    body: JSON.stringify({
      agent_id: config.ELEVENLABS_AGENT_ID,
      agent_phone_number_id: config.ELEVENLABS_AGENT_PHONE_NUMBER_ID,
      to_number: toNumber,
      conversation_initiation_client_data: {
        type: "conversation_initiation_client_data",
        dynamic_variables: {
          agent_identity_name: request.agentIdentityName,
          recipient_name: request.recipientName?.trim() || "the person who answers",
          task,
          call_opening: callBrief.firstMessage,
          context: request.context?.trim() || "",
          source_url: request.sourceUrl?.trim() || ""
        }
      }
    })
  });

  const responseText = await upstreamResponse.text();
  let responseJson: Record<string, unknown> = {};
  try {
    responseJson = responseText ? JSON.parse(responseText) as Record<string, unknown> : {};
  } catch {
    responseJson = {};
  }

  if (!upstreamResponse.ok) {
    const detail = typeof responseJson.detail === "string"
      ? responseJson.detail
      : typeof responseJson.message === "string"
        ? responseJson.message
        : responseText.slice(0, 500) || "ElevenLabs outbound call failed.";
    throw new PhoneCallError(detail);
  }

  return {
    ok: true,
    provider: "elevenlabs",
    simulated: false,
    callId: readString(responseJson.conversation_id) || readString(responseJson.call_id) || `call_${Date.now().toString(36)}`,
    toNumber,
    agentIdentityName: request.agentIdentityName,
    task,
    status: readString(responseJson.status) || "started",
    detail: "ElevenLabs outbound call started."
  };
}

function buildPersonalAssistantCallBrief(
  request: PhoneCallRequest,
  task: string
): { firstMessage: string } {
  const recipientName = request.recipientName?.trim() || "the person who answers";
  const appointmentTask = /\b(book|booking|schedule|appointment|reservation|reserve)\b/i.test(task);
  const normalizedTask = task.endsWith(".") ? task : `${task}.`;

  const firstMessage = appointmentTask
    ? `Hi, I'm an AI assistant calling on behalf of a client. I'm calling to book an appointment with ${recipientName}. The request is: ${normalizedTask}`
    : `Hi, I'm an AI assistant calling on behalf of a client. I'm calling about this request: ${normalizedTask}`;

  return { firstMessage };
}

function normalizePhoneNumber(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed
    .replace(/^00/, "+")
    .replace(/[^\d+]/g, "")
    .replace(/(?!^)\+/g, "");

  if (/^\+\d{7,15}$/.test(normalized)) {
    return normalized;
  }

  if (/^\d{7,15}$/.test(normalized)) {
    return `+${normalized}`;
  }

  return null;
}

const readString = readNonEmptyString;
