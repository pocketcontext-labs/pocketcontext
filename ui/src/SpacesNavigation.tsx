import { useState, type ReactNode, type FormEvent } from "react";
import "./spacesNavigation.css";

export default function SpacesNavigation({
  space,
  spaces,
  onSpaceChange,
  onCreateSpace,
  spaceManagement,
  spaceList,
  setSpaceList,
}: {
  space?: string;
  spaces: { id: string; name: string; archived?: boolean }[];
  onSpaceChange: (id: string) => void;
  onCreateSpace: (name: string) => Promise<string>;
  spaceManagement: ReactNode;
  spaceList: boolean;
  setSpaceList: (visible: boolean) => void;
}) {
  const [creatingSpace, setCreatingSpace] = useState(false);
  const [spaceDraft, setSpaceDraft] = useState("");
  const [savingSpace, setSavingSpace] = useState(false);
  const [spaceError, setSpaceError] = useState("");
  async function createSpace(event: FormEvent) {
    event.preventDefault();
    if (!spaceDraft.trim() || savingSpace) return;
    setSavingSpace(true);
    setSpaceError("");
    try {
      const id = await onCreateSpace(spaceDraft.trim());
      onSpaceChange(id);
      setSpaceDraft("");
      setCreatingSpace(false);
      setSpaceList(false);
    } catch {
      setSpaceError("Could not create the space. Please try again.");
    } finally {
      setSavingSpace(false);
    }
  }
  return (
    <>
      <nav
        hidden={!spaceList}
        className="destination-strip"
        aria-label="Workspace navigation"
      >
        <button
          type="button"
          aria-pressed={spaceList}
          disabled={savingSpace}
          onClick={() => setSpaceList(true)}
        >
          Spaces
        </button>
        <button
          className="destination-add"
          type="button"
          aria-label="New space"
          title="New space"
          disabled={savingSpace}
          onClick={() => {
            setCreatingSpace(true);
            setSpaceError("");
          }}
        >
          ＋
        </button>
      </nav>
      <section
        className="spaces-index"
        data-visible={spaceList}
        inert={!spaceList}
        aria-label="Spaces list"
      >
        <div className="spaces-list-heading">
          <h2>Spaces</h2>
          {spaceManagement}
        </div>
        {creatingSpace && (
          <form onSubmit={createSpace}>
            <label>
              Space name
              <input
                autoFocus
                value={spaceDraft}
                onChange={(e) => setSpaceDraft(e.target.value)}
                disabled={savingSpace}
              />
            </label>
            <button disabled={!spaceDraft.trim() || savingSpace}>
              Create space
            </button>
            <button
              type="button"
              disabled={savingSpace}
              onClick={() => setCreatingSpace(false)}
            >
              Cancel
            </button>
            {spaceError && <p role="alert">{spaceError}</p>}
          </form>
        )}
        {spaces
          .filter((item) => !item.archived || item.id === space)
          .map((item) => (
            <button
              className="space-list-row"
              key={item.id}
              aria-current={item.id === space ? "page" : undefined}
              disabled={savingSpace}
              onClick={() => {
                onSpaceChange(item.id);
                setSpaceList(false);
                setCreatingSpace(false);
              }}
            >
              <svg
                aria-hidden="true"
                width="21"
                height="21"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.7"
                strokeLinecap="round"
                strokeLinejoin="round"
              >
                <path d="M3 7V5h6l2 2h10v12H3z" />
              </svg>
              <strong>{item.name}</strong>
              <span aria-hidden="true">›</span>
            </button>
          ))}
      </section>
    </>
  );
}
