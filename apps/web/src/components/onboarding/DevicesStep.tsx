import { HardDrivesIcon, LaptopIcon } from "@phosphor-icons/react";

export default function DevicesStep() {
  return (
    <>
      <div className="ob-card-title">Execution environments</div>
      <div className="ob-option-list">
        <div className="ob-option is-selected">
          <span className="ob-tile">
            <LaptopIcon size={20} />
          </span>
          <span className="ob-option-text">
            <span className="ob-option-name">This computer</span>
            <span className="ob-option-detail">
              Run agents and tools on your local development machine.
            </span>
          </span>
          <span className="ob-selected-tag">● Selected</span>
        </div>

        <div className="ob-option">
          <span className="ob-tile">
            <HardDrivesIcon size={20} />
          </span>
          <span className="ob-option-text">
            <span className="ob-option-name">Add a remote device</span>
            <span className="ob-option-detail">
              Connect another machine or remote environment later.
            </span>
          </span>
          <span className="ob-option-trail">
            <button type="button" className="link" disabled>
              + Add
            </button>
            <span className="badge">Coming soon</span>
          </span>
        </div>
      </div>

      <div className="ob-info">
        <div className="ob-info-title">Connection and permissions</div>
        <div className="ob-info-body">
          Patchwork will ask before accessing protected resources or running sensitive actions.
        </div>
      </div>
    </>
  );
}
