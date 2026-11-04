import { useEffect, useRef, useState } from "react";
export type PromptImage = { mimeType: string; data: string };
export function ImagePreview({
  image,
  alt,
}: {
  image: PromptImage;
  alt: string;
}) {
  const [url, setUrl] = useState("");
  useEffect(() => {
    const bytes = Uint8Array.from(atob(image.data), (c) => c.charCodeAt(0));
    const url = URL.createObjectURL(
      new Blob([bytes], { type: image.mimeType }),
    );
    setUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [image.data, image.mimeType]);
  return url ? (
    <img className="chat-image-preview" src={url} alt={alt} />
  ) : null;
}
export type ModelState = {
  currentModelId: string;
  availableModels: { modelId: string; name: string }[];
};
type Recognition = {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult:
    | ((event: {
        resultIndex: number;
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>;
      }) => void)
    | null;
  onerror: ((event: { error: string }) => void) | null;
  onend: (() => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
};
export function ComposerTools({
  images,
  onImages,
  canAttach,
  models,
  model,
  onModel,
  onText,
  onError,
  disabled,
  permission,
  currentMode,
  modePending,
  allowWorkspace,
  allowFullAccess,
  onMode,
}: {
  images: PromptImage[];
  onImages: (value: PromptImage[]) => void;
  canAttach: boolean;
  models?: ModelState;
  model: string;
  onModel: (value: string) => void;
  onText: (value: string) => void;
  onError: (value: string) => void;
  disabled: boolean;
  permission: string;
  currentMode: string;
  modePending: boolean;
  allowWorkspace: boolean;
  allowFullAccess: boolean;
  onMode: (mode: string) => void;
}) {
  const picker = useRef<HTMLInputElement>(null);
  const recording = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  useEffect(
    () => () => {
      const r = recording.current;
      if (r) {
        r.onresult = null;
        r.onerror = null;
        r.onend = null;
        r.abort();
      }
    },
    [],
  );
  async function attach(files: FileList | null) {
    if (!files) return;
    try {
      const added = await Promise.all(
        Array.from(files, async (file) => {
          if (
            !["image/png", "image/jpeg"].includes(file.type) ||
            file.size > 384 * 1024
          )
            throw Error("Choose PNG or JPEG images up to 384 KB each.");
          const data = await new Promise<string>((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result).split(",")[1]);
            reader.onerror = () => reject(Error("Could not read image."));
            reader.readAsDataURL(file);
          });
          return { mimeType: file.type, data };
        }),
      );
      if (images.length + added.length > 3)
        throw Error("Attach up to three images per message.");
      onImages([...images, ...added]);
    } catch (e) {
      onError(e instanceof Error ? e.message : "Could not attach image.");
    }
  }
  function dictate() {
    if (recording.current) {
      recording.current.stop();
      return;
    }
    const api = window as Window & {
      SpeechRecognition?: new () => Recognition;
      webkitSpeechRecognition?: new () => Recognition;
    };
    const Constructor = api.SpeechRecognition || api.webkitSpeechRecognition;
    if (!Constructor) {
      onError(
        "Voice dictation is unavailable in this browser. Try Chrome or use keyboard dictation.",
      );
      return;
    }
    const r = new Constructor();
    r.lang = navigator.language;
    r.continuous = false;
    r.interimResults = false;
    r.onresult = (e) => {
      for (let i = e.resultIndex; i < e.results.length; i++)
        if (e.results[i].isFinal) onText(e.results[i][0].transcript);
    };
    r.onerror = (e) => onError("Dictation stopped (" + e.error + ").");
    r.onend = () => {
      recording.current = null;
      setListening(false);
    };
    try {
      r.start();
      recording.current = r;
      setListening(true);
    } catch {
      onError(
        "Could not start the microphone. Check browser microphone permissions.",
      );
    }
  }
  return (
    <>
      <input
        hidden
        ref={picker}
        type="file"
        multiple
        accept="image/png,image/jpeg"
        onChange={(e) => {
          void attach(e.target.files);
          e.target.value = "";
        }}
      />
      <button
        type="button"
        aria-label="Attach images"
        title={
          canAttach
            ? "Attach PNG or JPEG images"
            : "Image attachments unavailable for this session"
        }
        disabled={disabled || !canAttach || images.length >= 3}
        onClick={() => picker.current?.click()}
      >
        ＋
      </button>
      <div className="composer-permissions">
        <button
          type="button"
          popoverTarget="composer-permissions-menu"
          title="Chat permissions"
          aria-label="Chat permissions"
          className="composer-shield"
        >
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M12 2.5 20 6v6.5c0 4.6-3 7.5-8 9-5-1.5-8-4.4-8-9V6zM12 7.5v5m0 3v.3" />
          </svg>
        </button>
        <div
          popover="auto"
          id="composer-permissions-menu"
          className="composer-permissions-menu"
        >
          <strong>Chat permissions</strong>
          <p>This conversation · {permission}</p>
          <fieldset>
            <legend>Permissions for this chat</legend>
            {[
              {
                id: "read-only",
                label: "Read-only",
                detail: "Ask before editing files or accessing the network.",
              },
              ...(allowWorkspace
                ? [
                    {
                      id: "workspace-write",
                      label: "Workspace access",
                      detail:
                        "Edit the scratch workspace and ask before broader access.",
                    },
                  ]
                : []),
              ...(allowFullAccess
                ? [
                    {
                      id: "agent-full-access",
                      label: "Full access (YOLO)",
                      detail:
                        "Applies immediately, including pending command approvals. Run commands without approval, with access to the network and any file your host account can access.",
                    },
                  ]
                : []),
            ].map((option) => (
              <label key={option.id}>
                <input
                  type="radio"
                  name="composer-default-mode"
                  disabled={
                    modePending ||
                    (disabled && option.id !== "agent-full-access")
                  }
                  checked={currentMode === option.id}
                  onChange={() => onMode(option.id)}
                />
                <span>
                  <b>{option.label}</b>
                  <small>{option.detail}</small>
                </span>
              </label>
            ))}
          </fieldset>
        </div>
      </div>
      {models?.availableModels.length ? (
        <label className="composer-model" title="Choose model">
          <svg
            aria-hidden="true"
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.6"
          >
            <path d="M3 7h9m4 0h5M3 17h3m4 0h11" />
            <circle cx="14" cy="7" r="2" />
            <circle cx="8" cy="17" r="2" />
          </svg>
          <select
            aria-label="Model"
            value={model || models.currentModelId}
            disabled={disabled}
            onChange={(e) => onModel(e.target.value)}
          >
            {models.availableModels.map((m) => (
              <option key={m.modelId} value={m.modelId}>
                {m.name}
              </option>
            ))}
          </select>
        </label>
      ) : (
        <small>Codex</small>
      )}
      <button
        type="button"
        aria-label={listening ? "Stop dictation" : "Dictate message"}
        aria-pressed={listening}
        disabled={disabled}
        title="Dictate message"
        onClick={dictate}
      >
        <svg
          width="19"
          height="19"
          viewBox="0 0 24 24"
          stroke="currentColor"
          strokeWidth="1.8"
          fill="none"
        >
          <rect x="9" y="2" width="6" height="13" rx="3" />
          <path d="M5 11a7 7 0 0 0 14 0M12 18v4" />
        </svg>
      </button>
    </>
  );
}
