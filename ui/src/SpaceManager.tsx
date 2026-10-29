import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, sessionGeneration, type Space } from "./api";
import "./spaceManager.css";
import { trapFocus } from "./readerControls";

/** Explain a refused change; the server's own message names a rule it enforces. */
function failure(error: unknown): string {
  const { status, response } = (error ?? {}) as {
    status?: number;
    response?: { message?: unknown };
  };
  if (status === 409)
    return "This changed elsewhere. The list now shows the latest details; please try again.";
  if (status === 404) return "This space no longer exists.";
  if (status === 403) return "Restore this archived space before changing it.";
  if (
    status === 400 &&
    typeof response?.message === "string" &&
    response.message
  )
    return response.message;
  return "Could not save the change. Please try again.";
}

export default function SpaceManager({
  selected,
  onChanged,
}: {
  selected?: string;
  onChanged: (destination?: string) => Promise<void>;
}) {
  const [open, setOpen] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  return (
    <>
      <button
        ref={trigger}
        className="space-manage-button"
        onClick={() => setOpen(true)}
      >
        Manage spaces
      </button>
      {open &&
        createPortal(
          <SpaceDialog
            selected={selected}
            onChanged={onChanged}
            onClose={() => {
              setOpen(false);
              requestAnimationFrame(() => trigger.current?.focus());
            }}
          />,
          document.body,
        )}
    </>
  );
}

function SpaceDialog({
  selected,
  onChanged,
  onClose,
}: {
  selected?: string;
  onChanged: (destination?: string) => Promise<void>;
  onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const alive = useRef(true);
  const identity = useRef(sessionGeneration);
  const [spaces, setSpaces] = useState<Space[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [name, setName] = useState("");
  const [editing, setEditing] = useState("");
  const [newName, setNewName] = useState("");
  const [archive, setArchive] = useState<Space | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const active = () => alive.current && identity.current === sessionGeneration;
  const reload = async () => {
    const rows = await api.listSpaces();
    if (active()) setSpaces(rows);
  };
  useEffect(() => {
    alive.current = true;
    dialog.current?.showModal();
    dialog.current?.querySelector("input")?.focus();
    void reload()
      .catch(() => {
        if (active()) setError("Could not load spaces. Close and try again.");
      })
      .finally(() => {
        if (active()) setLoading(false);
      });
    return () => {
      alive.current = false;
    };
  }, []);
  const run = async (
    operation: () => Promise<{ id: string }>,
    success: string,
    navigate = false,
  ) => {
    if (busy) return;
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const result = await operation();
      if (!active()) return;
      await reload();
      if (!active()) return;
      await onChanged(navigate ? result.id : undefined);
      if (!active()) return;
      setName("");
      setEditing("");
      setArchive(null);
      setNotice(success);
    } catch (e) {
      if (!active()) return;
      setError(failure(e));
      // A conflict or refusal means the list is stale: show the current state.
      try {
        await reload();
      } catch {
        /* Keep the original failure visible. */
      }
      if (active()) {
        setArchive(null);
        setEditing("");
      }
    } finally {
      if (active()) setBusy(false);
    }
  };
  return (
    <dialog
      ref={dialog}
      className="space-manager"
      aria-labelledby="spaces-title"
      onCancel={onClose}
      onKeyDown={trapFocus}
      onClick={(event) => {
        if (event.target !== event.currentTarget) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        if (
          event.clientX < bounds.left ||
          event.clientX > bounds.right ||
          event.clientY < bounds.top ||
          event.clientY > bounds.bottom
        ) {
          onClose();
        }
      }}
    >
      <header>
        <h2 id="spaces-title">Manage spaces</h2>
        <button
          className="icon-button"
          aria-label="Close space manager"
          onClick={onClose}
        >
          ×
        </button>
      </header>
      <p>
        Spaces keep separate sets of sources and pages apart. The default space
        opens whenever a link does not name one.
      </p>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void run(() => api.createSpace(name.trim()), "Space created.", true);
        }}
        className="space-create-form"
      >
        <label>
          New space name
          <input
            autoFocus
            required
            maxLength={200}
            value={name}
            onChange={(e) => setName(e.target.value)}
            disabled={busy}
          />
        </label>
        <button
          className="secondary-button"
          disabled={busy || loading || !name.trim()}
        >
          Create space
        </button>
      </form>
      {error && <p role="alert">{error}</p>}
      <p role="status" aria-live="polite">
        {busy ? "Saving…" : notice}
      </p>
      <label className="space-archive-toggle">
        <input
          type="checkbox"
          checked={showArchived}
          onChange={(e) => setShowArchived(e.target.checked)}
        />{" "}
        Show archived spaces
      </label>
      {loading ? (
        <p>Loading spaces…</p>
      ) : (
        <ul className="space-manager-list" aria-label="Spaces">
          {spaces
            .filter((space) => showArchived || !space.archived)
            .map((space) => (
              <li key={space.id}>
                <div className="space-manager-row">
                  <div>
                    <strong>{space.name}</strong>
                    <span className="space-badges">
                      {space.is_default && (
                        <span className="space-badge is-default">Default</span>
                      )}
                      {space.archived && (
                        <span className="space-badge">Archived</span>
                      )}
                      {space.id === selected && (
                        <span className="space-badge">Open now</span>
                      )}
                    </span>
                  </div>
                  <div className="space-manager-actions">
                    {space.id !== selected && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          void onChanged(space.id)
                            .then(onClose)
                            .catch(() =>
                              setError("Could not open this space."),
                            );
                        }}
                      >
                        Open
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        setEditing(space.id);
                        setNewName(space.name);
                        setArchive(null);
                      }}
                    >
                      Rename
                    </button>
                    {!space.is_default && !space.archived && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void run(
                            () => api.setDefaultSpace(space),
                            `“${space.name}” is now the default space.`,
                          )
                        }
                      >
                        Make default
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={busy || space.is_default}
                      aria-describedby={
                        space.is_default ? "space-default-rule" : undefined
                      }
                      title={
                        space.is_default
                          ? "Make another space the default before archiving this one."
                          : undefined
                      }
                      onClick={() => {
                        if (space.archived)
                          void run(
                            () => api.updateSpace(space, { archived: false }),
                            "Space restored.",
                          );
                        else {
                          setArchive(space);
                          setEditing("");
                        }
                      }}
                    >
                      {space.archived ? "Restore" : "Archive"}
                    </button>
                  </div>
                </div>
                {editing === space.id && (
                  <form
                    className="space-rename-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      void run(
                        () => api.updateSpace(space, { name: newName.trim() }),
                        "Space renamed.",
                      );
                    }}
                  >
                    <label>
                      Space name
                      <input
                        autoFocus
                        required
                        maxLength={200}
                        disabled={busy}
                        value={newName}
                        onChange={(e) => setNewName(e.target.value)}
                      />
                    </label>
                    <button disabled={busy || !newName.trim()}>
                      Save name
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setEditing("")}
                    >
                      Cancel
                    </button>
                  </form>
                )}
                {archive?.id === space.id && (
                  <div className="space-archive-confirm">
                    <p>
                      Archive “{space.name}”? It leaves the space selector and
                      becomes read-only. Its sources, pages and links stay
                      readable; restore it here to make changes again.
                    </p>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() =>
                        void run(
                          () => api.updateSpace(space, { archived: true }),
                          "Space archived. You can restore it using Show archived spaces.",
                        )
                      }
                    >
                      Confirm archive
                    </button>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => setArchive(null)}
                    >
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}
      <p className="space-manager-hint" id="space-default-rule">
        The default space cannot be archived; make another space the default
        first. Archived spaces must be restored before they can become the
        default. Archiving keeps every source, page and publication.
      </p>
    </dialog>
  );
}
