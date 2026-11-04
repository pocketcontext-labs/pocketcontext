import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
import type { ModelState } from "./ComposerTools";

const effortOrder = [
  "none",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
];
const label = (value: string) =>
  value ? value[0].toUpperCase() + value.slice(1) : "Model default";

// Codex ACP's legacy model list encodes effort in the exact model ID. Other
// adapters may use opaque IDs; never guess an effort from their display names.
export function modelChoices(models: ModelState) {
  return models.availableModels.map((model) => {
    const match = /^(.*)\[([^\[\]]+)\]$/.exec(model.modelId);
    const effort = match && effortOrder.includes(match[2]) ? match[2] : "";
    return {
      ...model,
      base: effort ? match![1] : model.modelId,
      effort,
      title: effort
        ? model.name.replace(new RegExp(`\\s*\\(${effort}\\)$`, "i"), "")
        : model.name,
    };
  });
}

export default function ModelPicker({
  models,
  model,
  onModel,
  disabled,
}: {
  models: ModelState;
  model: string;
  onModel: (id: string) => void;
  disabled: boolean;
}) {
  const panelId = useId();
  const [open, setOpen] = useState(false);
  const [step, setStep] = useState<"effort" | "model">("effort");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLDivElement>(null);
  const choices = modelChoices(models);
  const selected = choices.find(
    (option) => option.modelId === (model || models.currentModelId),
  );
  const defaultChoice = choices.find(
    (option) => option.modelId === models.defaultModelId,
  );
  const efforts = [...new Set(choices.map((option) => option.effort))].sort(
    (a, b) => effortOrder.indexOf(a) - effortOrder.indexOf(b),
  );
  const effort = selected?.effort ?? efforts[0] ?? "";
  const matching = choices.filter((option) => option.effort === effort);
  const effortIndex = Math.max(0, efforts.indexOf(effort));
  const chooseEffort = (value: string) => {
    const next =
      choices.find(
        (option) => option.effort === value && option.base === selected?.base,
      ) ||
      choices.find(
        (option) =>
          option.effort === value && option.base === defaultChoice?.base,
      ) ||
      choices.find((option) => option.effort === value);
    if (next) onModel(next.modelId);
  };
  const close = () => {
    setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open) return;
    const pointer = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", pointer);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("pointerdown", pointer);
      document.removeEventListener("keydown", key);
    };
  }, [open]);
  useEffect(() => {
    if (open) {
      panel.current?.focus({ preventScroll: true });
      const list = panel.current?.querySelector<HTMLElement>(".model-options");
      const checked =
        list?.querySelector<HTMLInputElement>("input:checked")?.parentElement;
      if (list && checked) {
        list.scrollTop = 0;
        const row = checked.getBoundingClientRect();
        const bounds = list.getBoundingClientRect();
        if (row.bottom > bounds.bottom)
          list.scrollTop = row.bottom - bounds.bottom;
      }
    }
  }, [open, step]);
  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);
  if (!choices.length) return <small>Model unavailable</small>;
  return (
    <div className="model-picker" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="model-picker-trigger"
        aria-label={`Select effort and model: ${selected ? `${label(selected.effort)}, ${selected.title}` : "Current model unavailable"}`}
        aria-expanded={open}
        aria-controls={open ? panelId : undefined}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setStep("effort");
          setOpen(!open);
        }}
      >
        <span>{selected ? label(selected.effort) : "Select effort"}</span>
        <small>{selected?.title || "Choose model"}</small>
      </button>
      {open && (
        <div
          id={panelId}
          className="model-picker-panel"
          data-step={step}
          ref={panel}
          tabIndex={-1}
          role="dialog"
          aria-label="Model settings"
        >
          <header className="model-picker-header">
            {step === "model" ? (
              <button
                type="button"
                className="model-back"
                aria-label="Back to reasoning effort"
                onClick={() => setStep("effort")}
              >
                ‹
              </button>
            ) : (
              <span className="model-header-spacer" aria-hidden="true" />
            )}
            {step === "effort" ? (
              <button
                type="button"
                className="model-next"
                aria-label={`Choose model: ${selected?.title || "Current model unavailable"}`}
                onClick={() => setStep("model")}
              >
                <strong>{selected?.title || "Choose model"}</strong>
                <span>{label(effort)}</span>
                <span aria-hidden="true">›</span>
              </button>
            ) : (
              <div className="model-picker-heading">
                <strong>Choose model</strong>
                <small>{label(effort)} effort</small>
              </div>
            )}
            <button
              type="button"
              className="model-reset"
              aria-label="Reset model and effort to session default"
              disabled={disabled || !defaultChoice}
              title={
                defaultChoice
                  ? `Reset to ${defaultChoice.title} · ${label(defaultChoice.effort)}`
                  : "The original default is unavailable for this conversation"
              }
              onClick={() => {
                if (defaultChoice) {
                  onModel(defaultChoice.modelId);
                  setStep("effort");
                }
              }}
            >
              <svg
                width="19"
                height="19"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 10a8 8 0 1 1 1 7M4 4v6h6" />
              </svg>
            </button>
          </header>
          {step === "effort" ? (
            <div className="effort-control">
              {efforts.length > 1 ? (
                <>
                  <div
                    className="effort-slider"
                    style={
                      {
                        "--effort-progress": `${(effortIndex / (efforts.length - 1)) * 100}%`,
                      } as CSSProperties
                    }
                  >
                    <div className="effort-ticks" aria-hidden="true">
                      {efforts.map((value, index) => (
                        <span key={value} data-filled={index <= effortIndex} />
                      ))}
                    </div>
                    <input
                      type="range"
                      min={0}
                      max={efforts.length - 1}
                      step={1}
                      value={effortIndex}
                      aria-label="Reasoning effort"
                      aria-valuetext={label(effort)}
                      onChange={(event) =>
                        chooseEffort(efforts[Number(event.target.value)])
                      }
                    />
                  </div>
                  <div className="effort-labels" aria-hidden="true">
                    {efforts.map((value) => (
                      <span key={value} data-selected={value === effort}>
                        {label(value)}
                      </span>
                    ))}
                  </div>
                </>
              ) : (
                <p className="model-single-effort">
                  {effort
                    ? `${label(effort)} is the available effort.`
                    : "This model uses its default reasoning effort."}
                </p>
              )}
            </div>
          ) : (
            <div
              className="model-options"
              role="group"
              aria-label={`Model for ${label(effort)} effort`}
            >
              {matching.map((option) => (
                <label key={option.modelId}>
                  <input
                    type="radio"
                    name={`${panelId}-model`}
                    checked={selected?.modelId === option.modelId}
                    onChange={() => onModel(option.modelId)}
                  />
                  <span>{option.title}</span>
                  <svg
                    className="model-choice-check"
                    width="18"
                    height="18"
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                    aria-hidden="true"
                  >
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                </label>
              ))}
            </div>
          )}
          <footer className="model-picker-footer">
            <p className="model-picker-note">For your next message</p>
            <button type="button" className="model-done" onClick={close}>
              Done
            </button>
          </footer>
        </div>
      )}
    </div>
  );
}
