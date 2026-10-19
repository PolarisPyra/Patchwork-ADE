import { Check, Circle, LoaderCircle, X } from "lucide-react";
import type { Message, StepStatus } from "../../api";

function StepIcon({ status }: { status: StepStatus }) {
  switch (status) {
    case "done":
      return <Check size={14} className="cv-step-icon cv-step-done" />;
    case "running":
      return <LoaderCircle size={14} className="cv-step-icon cv-step-running spin" />;
    case "error":
      return <X size={14} className="cv-step-icon cv-step-error" />;
    case "pending":
      return <Circle size={14} className="cv-step-icon cv-step-pending" />;
  }
}

export default function PlanView({ message }: { message: Message | null }) {
  const steps = message?.plan ?? [];
  const files = message?.files ?? [];

  return (
    <div className="cv-plan">
      {steps.length === 0 ? (
        <div className="cv-center cv-muted">The agent hasn't shared a plan for this task.</div>
      ) : (
        <ol className="cv-steps">
          {steps.map((step, i) => (
            <li className="cv-step" key={i}>
              <StepIcon status={step.status} />
              <span className="cv-step-text">{step.text}</span>
            </li>
          ))}
        </ol>
      )}

      {files.length > 0 && (
        <>
          <div className="cv-section-title">Files changed</div>
          <ul className="cv-file-list">
            {files.map((file) => (
              <li className="cv-file-row" key={file} title={file}>
                {file}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
