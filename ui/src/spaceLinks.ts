/** Keep explicitly selected spaces in shareable reader links. The reader resolves implicit links through the server default before rendering. */
export function spaceLink(
  href: string,
  space = new URLSearchParams(location.hash.split("?")[1] || "").get("space") ||
    "",
): string {
  if (!/^[a-z0-9]{15}$/.test(space)) return href;
  const [path, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  params.set("space", space);
  return `${path}?${params}`;
}
