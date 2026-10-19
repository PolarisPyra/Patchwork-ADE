import type { Settings } from "../api";
import type { UpdateSettings } from "../App";

export interface OnboardingProps {
  settings: Settings;
  updateSettings: UpdateSettings;
  resolvedTheme: "light" | "dark";
  toggleTheme: () => void;
}

// STUB — to be implemented.
export default function Onboarding(_props: OnboardingProps) {
  return <div>Onboarding</div>;
}
