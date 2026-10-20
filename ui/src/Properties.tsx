import { groupsFor, ownedBy } from "./ownership";
import { useState } from "react";
import { pageHref } from "./Markdown";
import type { PageDetail, PageSummary, PropertyValue } from "./types";

export const relationshipKeys = new Set([
  "documents",
  "destinations",
  "members",
  "accountable_owners",
  "backup_owners",
  "deployment_profiles",
  "applications",
  "resources",
  "credentials",
  "consumers",
  "replaces",
  "replaced_by",
]);
export function propertyLabel(key: string): string {
  return key
    .replaceAll("_", " ")
    .replace(/^./, (letter) => letter.toUpperCase());
}
export function propertyText(value: PropertyValue | undefined): string {
  if (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && !value.length)
  )
    return "Needs verification";
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return Array.isArray(value) ? value.join(", ") : String(value);
}
export function PropertyDisplay({
  name,
  value,
  pages,
  publication,
}: {
  name: string;
  value: PropertyValue | undefined;
  pages: PageSummary[];
  publication?: string;
}) {
  if (relationshipKeys.has(name) && Array.isArray(value) && value.length) {
    return (
      <span className="property-links">
        {value.map((id) => {
          const target = pages.find((page) => page.page === id);
          return target ? (
            <a key={id} href={pageHref(target.slug, publication)}>
              {target.title}
            </a>
          ) : (
            <span key={id}>Unavailable in this publication</span>
          );
        })}
      </span>
    );
  }
  if (
    name === "crm_url" &&
    typeof value === "string" &&
    /^https?:\/\//i.test(value)
  )
    return (
      <a href={value} target="_blank" rel="noopener noreferrer">
        CRM record
      </a>
    );
  const text = propertyText(value);
  // Display dates in their recorded precision; never infer an observation time.
  return typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}(T.*)?$/.test(value) ? (
    <time dateTime={value}>{text}</time>
  ) : (
    <span>{text}</span>
  );
}
const prominent = [
  "catalog_type",
  "document_type",
  "output_mode",
  "documents",
  "destinations",
  "github_repository",
  "github_branch",
  "github_path",
  "sync_status",
  "checked_at",
  "resource_type",
  "provider",
  "lifecycle_status",
  "accountable_owner",
  "accountable_owners",
  "backup_owners",
  "members",
  "role",
  "organization",
  "purpose",
  "crm_url",
  "provider_observed_at",
];
export default function PropertiesPanel({
  page,
  pages,
  publication,
  onCitation,
}: {
  page: PageDetail;
  pages: PageSummary[];
  publication?: string;
  onCitation: (marker: number) => void;
}) {
  const properties = page.properties || {};
  const [copied, setCopied] = useState("");
  const keys = Object.keys(properties);
  if (!keys.length) return null;
  const main = prominent.filter((key) => Object.hasOwn(properties, key));
  const rest = keys.filter((key) => !main.includes(key)).sort();
  const fields = (names: string[]) => (
    <dl className="property-grid">
      {names.map((name) => (
        <div key={name}>
          <dt>{propertyLabel(name)}</dt>
          <dd>
            <PropertyDisplay
              name={name}
              value={properties[name]}
              pages={pages}
              publication={publication}
            />
            {name === "provider_id" && typeof properties[name] === "string" && (
              <button
                className="property-copy"
                aria-label="Copy provider ID"
                onClick={() => {
                  void navigator.clipboard
                    .writeText(String(properties[name]))
                    .then(
                      () => setCopied("Provider ID copied"),
                      () => setCopied("Unable to copy provider ID"),
                    );
                }}
              >
                Copy
              </button>
            )}
            {!page.property_evidence?.[name]?.length &&
              properties[name] != null &&
              properties[name] !== "" && (
                <small className="property-unverified">No cited evidence</small>
              )}
            {(page.property_evidence?.[name] || []).map((marker) => (
              <button
                key={marker}
                className="property-evidence"
                aria-label={`Evidence for ${propertyLabel(name)}: citation ${marker}`}
                onClick={() => onCitation(Number(marker))}
              >
                [{marker}]
              </button>
            ))}
          </dd>
        </div>
      ))}
    </dl>
  );
  return (
    <section className="properties-panel" aria-label="Page properties">
      <h2>Properties</h2>
      {main.length > 0 && fields(main)}
      {rest.length > 0 && (
        <details>
          <summary>
            All properties <span>({keys.length})</span>
          </summary>
          {fields(rest)}
        </details>
      )}
      {(properties.catalog_type === "person" ||
        properties.catalog_type === "group") && (
        <div className="ownership-details">
          {properties.catalog_type === "person" && (
            <>
              <h3>Groups</h3>
              <PropertyDisplay
                name="members"
                value={groupsFor(page, pages).map((group) => group.page)}
                pages={pages}
                publication={publication}
              />
            </>
          )}
          <h3>
            {properties.catalog_type === "person"
              ? "Responsibilities through groups"
              : "Responsibilities"}
          </h3>
          {["accountable_owners", "backup_owners"].map((role) => {
            const items = ownedBy(
              properties.catalog_type === "group"
                ? [page.page]
                : groupsFor(page, pages).map((group) => group.page),
              pages,
              role,
            );
            return (
              <div key={role}>
                <h4>
                  {role === "accountable_owners"
                    ? "Accountable for"
                    : "Backups for"}
                </h4>
                {items.length ? (
                  <PropertyDisplay
                    name="resources"
                    value={items.map((item) => item.page)}
                    pages={pages}
                    publication={publication}
                  />
                ) : (
                  <p>None recorded in this publication.</p>
                )}
              </div>
            );
          })}
        </div>
      )}
      {copied && <p role="status">{copied}</p>}
    </section>
  );
}
