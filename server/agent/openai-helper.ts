/**
 * OpenAI API helper — uses fetch directly (no SDK dependency)
 */

const OPENAI_API_URL = "https://api.openai.com/v1";

function getApiKey(): string {
  return process.env.OPENAI_API_KEY || "";
}

export async function chatCompletion(
  messages: { role: string; content: any }[],
  options: { model?: string; max_tokens?: number; temperature?: number } = {},
): Promise<string> {
  const { model = "gpt-4o-mini", max_tokens = 500, temperature = 0.1 } = options;
  const r = await fetch(`${OPENAI_API_URL}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${getApiKey()}`,
    },
    body: JSON.stringify({ model, messages, max_tokens, temperature }),
  });
  if (!r.ok) throw new Error(`OpenAI API error: ${r.status} ${await r.text()}`);
  const data = await r.json() as any;
  return data.choices?.[0]?.message?.content || "";
}

export async function visionCompletion(
  imageBase64: string,
  prompt: string,
  options: { model?: string; max_tokens?: number } = {},
): Promise<string> {
  const { model = "gpt-4o", max_tokens = 800 } = options;
  const messages = [
    {
      role: "user",
      content: [
        { type: "text", text: prompt },
        { type: "image_url", image_url: { url: `data:image/jpeg;base64,${imageBase64}` } },
      ],
    },
  ];
  return chatCompletion(messages, { model, max_tokens });
}

export async function whisperTranscribe(audioBuffer: Buffer): Promise<string> {
  const formData = new FormData();
  formData.append("file", new Blob([audioBuffer], { type: "audio/ogg" }), "audio.ogg");
  formData.append("model", "whisper-1");
  formData.append("language", "es");

  const r = await fetch(`${OPENAI_API_URL}/audio/transcriptions`, {
    method: "POST",
    headers: { Authorization: `Bearer ${getApiKey()}` },
    body: formData,
  });
  if (!r.ok) throw new Error(`Whisper API error: ${r.status}`);
  const data = await r.json() as any;
  return data.text || "";
}
