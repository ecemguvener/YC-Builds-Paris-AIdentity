/**
 * Extract the concatenated output text from an OpenAI Responses API JSON body.
 *
 * The Responses API nests generated text inside
 * `output[].content[] -> { type: "output_text", text }`. This helper parses the
 * raw response text once and returns the joined result.
 */
export function readOpenAIOutputText(responseText: string): string {
  const response = JSON.parse(responseText) as { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
  return (
    response.output
      ?.flatMap((item) => item.content ?? [])
      .filter((content): content is { type: string; text: string } => content.type === "output_text" && typeof content.text === "string")
      .map((content) => content.text)
      .join("") ?? ""
  );
}

/**
 * Strip leading/trailing markdown code fences that some models wrap around JSON
 * output (e.g. ` ```json ... ``` `).
 */
export function cleanJsonFences(text: string): string {
  return text.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
}
