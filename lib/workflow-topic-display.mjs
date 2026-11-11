export function splitWorkflowTopicTranslation(value = "") {
  const text = String(value ?? "").trim();
  if (!text) return { title: "", translation: "" };

  const match = text.match(/^([\s\S]*?)(?:\s*[|｜]\s*|\s*\n+\s*)中文\s*[:：]\s*([\s\S]+)$/i);
  const title = String(match?.[1] || "").trim();
  const translation = String(match?.[2] || "").trim();
  if (!title || !translation) return { title: text, translation: "" };

  return { title, translation };
}
