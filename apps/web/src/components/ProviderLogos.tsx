import type { ImportSource } from "~/api";
import claudeIcon from "../../../../assets/claude-color.svg";
import geminiIcon from "../../../../assets/gemini-color.svg";
import openaiIcon from "../../../../assets/openai.svg";
import t3Icon from "../../../../assets/t3.svg";

const LOGOS: Record<ImportSource, string> = { claude: claudeIcon, codex: openaiIcon, gemini: geminiIcon, t3: t3Icon };

/** Brand-ish marks for the supported agents (and T3 Code, an import source). */
export default function ProviderLogos({ kind, size = 20 }: { kind: ImportSource; size?: number }) {
  return <img src={LOGOS[kind]} width={size} height={size} alt="" aria-hidden="true" />;
}
