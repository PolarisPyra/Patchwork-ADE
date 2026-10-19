import { cx } from "~/components/onboarding/classNames";

interface StepperProps {
  labels: string[];
  current: number;
  /** Highest step index the user has reached; later steps are not clickable. */
  reached: number;
  onSelect: (index: number) => void;
}

export default function Stepper({ labels, current, reached, onSelect }: StepperProps) {
  return (
    <nav aria-label="Setup steps">
      <ol className="ob-stepper">
        {labels.map((label, i) => {
          const isCurrent = i === current;
          const isFilled = i <= current;
          return (
            <li key={label} className="ob-step">
              {i > 0 && <span className={cx("ob-step-line", isFilled && "is-filled")} aria-hidden />}
              <button
                type="button"
                className={cx("ob-step-btn", isFilled && "is-filled", isCurrent && "is-current")}
                disabled={i > reached}
                aria-current={isCurrent ? "step" : undefined}
                onClick={() => onSelect(i)}
              >
                <span className="ob-step-num">{i + 1}</span>
                <span className="ob-step-label">{label}</span>
              </button>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
