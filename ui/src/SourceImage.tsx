import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { imageSource, pb, sessionGeneration, sourceImage } from "./api";
import { spaceLink } from "./spaceLinks";

const subscribeAuth = (notify: () => void) => pb.authStore.onChange(notify);
const authSnapshot = () => `${sessionGeneration}:${pb.authStore.token}`;

/** Protected originals are fetched into short-lived, checksum-verified blob URLs. */
export function SourceImage({ id, alt, title }: { id: string; alt?: string; title?: string }) {
  const space = new URLSearchParams(location.hash.split("?")[1] || "").get("space") || "";
  const auth = useSyncExternalStore(subscribeAuth, authSnapshot);
  const [url, setURL] = useState("");
  const [error, setError] = useState("");
  const [name, setName] = useState("image");
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const abort = new AbortController();
    let objectURL = "";
    setURL("");
    setError("");
    const clear = () => {
      abort.abort();
      if (objectURL) URL.revokeObjectURL(objectURL);
      objectURL = "";
      setURL("");
      dialog.current?.close();
    };
    const token = pb.authStore.token;
    const unsubscribe = pb.authStore.onChange(() => {
      if (pb.authStore.token !== token) clear();
    });
    if (!pb.authStore.token || !pb.authStore.isValid) {
      setError("Sign in to view this image.");
      return () => { unsubscribe(); clear(); };
    }
    void (async () => {
      try {
        const source = await imageSource(id, space);
        abort.signal.throwIfAborted();
        const blob = await sourceImage(source, abort.signal);
        abort.signal.throwIfAborted();
        objectURL = URL.createObjectURL(blob);
        setName(source.original_name);
        setURL(objectURL);
      } catch (e) {
        if (!abort.signal.aborted) setError(e instanceof Error ? e.message : "Image unavailable.");
      }
    })();
    return () => { unsubscribe(); clear(); };
  }, [id, space, auth]);
  const size = /^size=(\d+)(?:x(\d+))?$/.exec(title || "");
  return <span className="source-image">
    {url ? <>
      <button type="button" className="source-image-open" onClick={() => dialog.current?.showModal()} aria-label={`Enlarge ${alt || name}`}>
        <img src={url} alt={alt || name} title={size ? undefined : title} width={size ? Math.min(Number(size[1]), 4096) : undefined} height={size?.[2] ? Math.min(Number(size[2]), 4096) : undefined} />
      </button>
      <dialog ref={dialog} className="source-image-dialog">
        <button type="button" onClick={() => dialog.current?.close()}>Close image</button>
        <img src={url} alt={alt || name} />
        <a href={spaceLink(`#/sources/${id}`, space)}>View source</a>{" · "}
        <a href={url} download={name}>Download original</a>
      </dialog>
    </> : <span role="status">{error || "Loading image…"}</span>}
    {title && !size && <span className="source-image-caption">{title}</span>}
    {!url && <>{" "}<a href={spaceLink(`#/sources/${id}`, space)}>View source</a></>}
  </span>;
}
