import { afterEach, describe, expect, it, vi } from "vitest";
import { PhoneCallError, placeAgentPhoneCall, waitForPhoneCallCompletion } from "./phone.js";
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
      callerName: "Maxence",
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
      callerName: "Maxence",
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
      callerName: "Maxence",
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
    expect(dynamicVariables?.call_opening).toBe(
      "Hi, I'm calling on behalf of Maxence. I'd like to book a barber appointment for tomorrow afternoon."
    );
    expect(dynamicVariables?.call_opening).not.toContain("AI assistant");
    expect(dynamicVariables?.call_opening).not.toContain("client");
    expect(dynamicVariables?.call_guidance).toContain("Be concise and direct");
    expect(dynamicVariables?.context).toContain("Ask for the first available haircut slot after 3pm.");
    expect(dynamicVariables?.context).toContain("only confirm the final details that affect the outcome");
    expect(dynamicVariables?.task).toContain("Book a barber appointment");
    expect(dynamicVariables?.recipient_name).toBe("Barber shop");
  });

  it("turns question-style tasks into natural call openings", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ conversation_id: "conv_test", status: "started" }), { status: 200 })
    );

    await placeAgentPhoneCall({
      toNumber: "+33771594992",
      task: "Can we move the appointment to tomorrow morning?",
      callerName: "Maxence",
      agentIdentityName: "Maxence AI Caller"
    }, {
      ...baseConfig,
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_AGENT_ID: "agent_test",
      ELEVENLABS_AGENT_PHONE_NUMBER_ID: "phnum_test"
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      conversation_initiation_client_data?: {
        dynamic_variables?: Record<string, string>;
      };
    };

    expect(requestBody.conversation_initiation_client_data?.dynamic_variables?.call_opening).toBe(
      "Hi, I'm calling on behalf of Maxence. I wanted to check if we can move the appointment to tomorrow morning."
    );
  });

  it("treats the called person as the direct recipient of the request", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ conversation_id: "conv_test", status: "started" }), { status: 200 })
    );

    await placeAgentPhoneCall({
      toNumber: "+33771594992",
      task: "Call Alex and propose a picnic this Sunday.",
      callerName: "Maxence",
      agentIdentityName: "Maxence AI Caller",
      recipientName: "Alex"
    }, {
      ...baseConfig,
      ELEVENLABS_API_KEY: "test-key",
      ELEVENLABS_AGENT_ID: "agent_test",
      ELEVENLABS_AGENT_PHONE_NUMBER_ID: "phnum_test"
    });

    const requestBody = JSON.parse(String(fetchMock.mock.calls[0]?.[1]?.body)) as {
      conversation_initiation_client_data?: {
        dynamic_variables?: Record<string, string>;
      };
    };

    const callOpening = requestBody.conversation_initiation_client_data?.dynamic_variables?.call_opening;
    expect(callOpening).toBe(
      "Hi, I'm calling on behalf of Maxence. I'd like to propose a picnic this Sunday."
    );
    expect(callOpening).not.toContain("ask Alex to call");
    expect(callOpening).not.toContain("calling about call Alex");
  });

  it("polls ElevenLabs conversation details until transcript completion", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ status: "processing", transcript: [] }), { status: 200 })
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "done",
            metadata: { call_duration_secs: 42 },
            transcript: [
              { role: "agent", message: "Hello, I am calling about the appointment.", time_in_call_secs: 1 },
              { role: "user", message: "Yes, 11am works.", time_in_call_secs: 12 }
            ]
          }),
          { status: 200 }
        )
      );

    const completion = await waitForPhoneCallCompletion(
      {
        ok: true,
        provider: "elevenlabs",
        simulated: false,
        callId: "conv_test",
        toNumber: "+33757509222",
        agentIdentityName: "Maxence AI Caller",
        task: "Book a barber appointment.",
        status: "started",
        detail: "started"
      },
      {
        ...baseConfig,
        ELEVENLABS_API_KEY: "test-key"
      },
      {
        intervalMs: 1,
        maxWaitMs: 50
      }
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "https://api.elevenlabs.io/v1/convai/conversations/conv_test",
      expect.objectContaining({
        method: "GET",
        headers: { "xi-api-key": "test-key" }
      })
    );
    expect(completion).toEqual({
      status: "done",
      durationSecs: 42,
      transcript: [
        { role: "agent", message: "Hello, I am calling about the appointment.", timeInCallSecs: 1 },
        { role: "user", message: "Yes, 11am works.", timeInCallSecs: 12 }
      ]
    });
  });
});
