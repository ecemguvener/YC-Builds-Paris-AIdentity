import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneCallError, placeAgentPhoneCall } from "./phone.js";
import type { AppConfig } from "./config.js";

const baseConfig = {
  ELEVENLABS_API_KEY: undefined,
  ELEVENLABS_AGENT_ID: undefined,
  ELEVENLABS_AGENT_PHONE_NUMBER_ID: undefined
} as AppConfig;

describe("placeAgentPhoneCall", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("queues a mock call when ElevenLabs outbound config is missing", async () => {
    const result = await placeAgentPhoneCall({
      toNumber: "(775) 618-0948",
      task: "Confirm a restaurant reservation.",
      agentIdentityName: "Maxence AI Caller",
      recipientName: "Restaurant",
      context: "Ask for a table for four tonight.",
      sourceUrl: ""
    }, baseConfig);

    expect(result).toMatchObject({
      ok: true,
      provider: "mock-elevenlabs",
      simulated: true,
      toNumber: "+7756180948",
      status: "queued"
    });
  });

  it("rejects invalid phone numbers before calling a provider", async () => {
    await expect(placeAgentPhoneCall({
      toNumber: "not a phone number",
      task: "Try to call.",
      agentIdentityName: "Maxence AI Caller"
    }, baseConfig)).rejects.toBeInstanceOf(PhoneCallError);
  });

  it("sends a personal-assistant booking prompt to ElevenLabs", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ conversation_id: "conv_test", status: "started" }), { status: 200 })
    );

    await placeAgentPhoneCall({
      toNumber: "+33771594992",
      task: "Book a barber appointment for tomorrow afternoon.",
      agentIdentityName: "Maxence AI Caller",
      recipientName: "Barber shop",
      context: "Ask for the first available haircut slot after 3pm.",
      sourceUrl: ""
    }, {
      ...baseConfig,
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_AGENT_ID: "agent_test",
      ELEVENLABS_AGENT_PHONE_NUMBER_ID: "phnum_test"
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      conversation_initiation_client_data?: {
        type?: string;
        dynamic_variables?: Record<string, string>;
      };
    };
    const clientData = requestBody.conversation_initiation_client_data;
    const dynamicVariables = clientData?.dynamic_variables;

    expect(clientData?.type).toBe("conversation_initiation_client_data");
    expect(dynamicVariables?.call_opening).toContain("calling on behalf of a client");
    expect(dynamicVariables?.call_opening).toContain("book an appointment");
    expect(dynamicVariables?.task).toContain("Book a barber appointment");
    expect(dynamicVariables?.recipient_name).toBe("Barber shop");
  });
});
