import type { LlmProvider } from "./chain.js";

type Env = Record<string, string | undefined>;

async function chatCompletion(
  url: string,
  headers: Record<string, string>,
  model: string,
  system: string,
  user: string,
  signal: AbortSignal,
): Promise<string> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      messages: [
        { role: "system", content: system },
        { role: "user", content: user },
      ],
    }),
    signal,
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const data = (await response.json()) as { choices?: { message?: { content?: string } }[] };
  const content = data.choices?.[0]?.message?.content;
  if (!content) throw new Error("empty reply");
  return content;
}

export function createProviders(env: Env): LlmProvider[] {
  if (env.LLM_ENABLED === "false") return [];
  const providers: LlmProvider[] = [];

  if (env.GROQ_API_KEY) {
    const key = env.GROQ_API_KEY;
    const model = env.GROQ_MODEL ?? "openai/gpt-oss-20b";
    providers.push({
      id: "groq",
      complete: (system, user, signal) =>
        chatCompletion(
          "https://api.groq.com/openai/v1/chat/completions",
          { authorization: `Bearer ${key}` },
          model,
          system,
          user,
          signal,
        ),
    });
  }

  if (env.GEMINI_API_KEY) {
    const key = env.GEMINI_API_KEY;
    const model = env.GEMINI_MODEL ?? "gemini-2.5-flash";
    providers.push({
      id: "gemini",
      complete: async (system, user, signal) => {
        const response = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
          {
            method: "POST",
            headers: { "content-type": "application/json", "x-goog-api-key": key },
            body: JSON.stringify({
              systemInstruction: { parts: [{ text: system }] },
              contents: [{ role: "user", parts: [{ text: user }] }],
              generationConfig: { temperature: 0.2 },
            }),
            signal,
          },
        );
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = (await response.json()) as {
          candidates?: { content?: { parts?: { text?: string }[] } }[];
        };
        const text = data.candidates?.[0]?.content?.parts?.map((part) => part.text ?? "").join("");
        if (!text) throw new Error("empty reply");
        return text;
      },
    });
  }

  if (env.OPENROUTER_API_KEY) {
    const key = env.OPENROUTER_API_KEY;
    const model = env.OPENROUTER_MODEL ?? "meta-llama/llama-3.3-70b-instruct:free";
    providers.push({
      id: "openrouter",
      complete: (system, user, signal) =>
        chatCompletion(
          "https://openrouter.ai/api/v1/chat/completions",
          { authorization: `Bearer ${key}`, "x-title": "NightShift" },
          model,
          system,
          user,
          signal,
        ),
    });
  }

  return providers;
}
