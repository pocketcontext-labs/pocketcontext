import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { api, sessionGeneration, type Space } from "./api";
import "./spaceManager.css";
import { trapFocus } from "./readerControls";

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
      const status = (e as { status?: number }).status;
      setError(
        status === 409
          ? "This space changed elsewhere. Review the latest details and try again."
          : status === 403 || status === 404
            ? "You no longer have permission to manage this space."
            : "Could not save the change. Please try again.",
      );
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
        Organize your knowledge in separate spaces. New spaces are visible only
        to you.
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
        <ul className="space-manager-list">
          {spaces
            .filter((space) => showArchived || !space.archived)
            .map((space) => (
              <li key={space.id}>
                <div className="space-manager-row">
                  <div>
                    <strong>{space.name}</strong>
                    <small>
                      {[
                        space.archived && "Archived",
                        space.is_default && "Default",
                        space.id === selected && "Current space",
                      ]
                        .filter(Boolean)
                        .join(" · ")}
                    </small>
                  </div>
                  <div className="space-manager-actions">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        void onChanged(space.id)
                          .then(onClose)
                          .catch(() => setError("Could not open this space."));
                      }}
                    >
                      Open
                    </button>
                    {
                      <>
                        <button
                          disabled={busy}
                          onClick={() => {
                            setEditing(space.id);
                            setNewName(space.name);
                            setArchive(null);
                          }}
                        >
                          Rename
                        </button>
                        {!space.is_default && (
                          <button
                            disabled={busy}
                            onClick={() => {
                              if (space.archived)
                                void run(
                                  () =>
                                    api.updateSpace(space, {
                                      archived: false,
                                    }),
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
                        )}
                      </>
                    }
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
                      Archive “{space.name}”? It will leave the space selector.
                      Existing links and evidence stay readable; restore it here
                      to make changes again.
                    </p>
                    <button
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
                    <button disabled={busy} onClick={() => setArchive(null)}>
                      Cancel
                    </button>
                  </div>
                )}
              </li>
            ))}
        </ul>
      )}
      <p className="space-manager-hint">
        The default space cannot be archived. Archiving preserves all sources
        and history.
      </p>
    </dialog>
  );
}
