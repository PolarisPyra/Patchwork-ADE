/** Fence language an agent uses to offer a choice: a JSON array of option labels. */
export const CHOICES_LANG = "choices";

/** The options of the last `choices` block in a reply, or null if there is none. */
export function parseChoices(text: string): string[] | null {
  const fences = [...text.matchAll(/```choices[ \t]*\n([\s\S]*?)\n```/g)];
  const last = fences.at(-1);
  if (!last) return null;
  try {
    const parsed: unknown = JSON.parse(last[1]);
    if (!Array.isArray(parsed)) return null;
    const options = parsed.filter((o): o is string => typeof o === "string" && o.trim() !== "");
    return options.length > 0 ? options.slice(0, 9) : null;
  } catch {
    return null;
  }
}
