import type { PageSummary } from "./types";

export const WELCOME_TOPICS = [
  { id: "getting-started", title: "Getting started", description: "Onboarding, setup and guides for finding your way." },
  { id: "company-strategy", title: "Company & strategy", description: "Direction, plans and how the organization works." },
  { id: "apps-workflows", title: "Apps & workflows", description: "Applications, operating guides and everyday processes." },
  { id: "platform-security", title: "Platform & security", description: "Infrastructure, architecture, access and reliability." },
  { id: "people-relationships", title: "People & relationships", description: "Teams, customers, partners and other relationships." },
  { id: "research-proposals", title: "Research & proposals", description: "Investigations, ideas and decisions in development." },
  { id: "meetings-notes", title: "Meetings & source notes", description: "Discussions, transcripts and notes from source material." },
  { id: "handoffs-history", title: "Handoffs & history", description: "Release handoffs, changes and historical context." },
  { id: "other", title: "Other knowledge", description: "More published pages to explore." },
] as const;

export type WelcomeTopicId = typeof WELCOME_TOPICS[number]["id"];
export interface WelcomeGroup {
  id: WelcomeTopicId;
  title: string;
  description: string;
  pages: PageSummary[];
}

function words(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function identity(page: PageSummary): string {
  return words(`${page.kind} ${page.title} ${page.slug}`);
}

// These are navigation hints, not authoritative metadata. Unknown subjects stay
// visible in Other knowledge, and every selected publication page appears once.
export function classifyWelcomePage(page: PageSummary): WelcomeTopicId {
  if (["person", "group"].includes(String(page.properties?.catalog_type))) return "people-relationships";
  if (["resource", "credential", "deployment"].includes(String(page.properties?.catalog_type))) return "platform-security";
  const value = identity(page);
  if (/\b(handoff|handoffs|history|historical|changelog|release|releases|retrospective)\b/.test(value)) return "handoffs-history";
  if (/\b(meeting|meetings|transcript|transcripts|minutes|interview|interviews|source|note|notes)\b/.test(value)) return "meetings-notes";
  if (/\b(research|proposal|proposals|experiment|experiments|investigation|evaluation|comparison|discovery)\b/.test(value)) return "research-proposals";
  if (/\b(onboarding|welcome|getting started|quickstart|orientation|setup|installation|login|sign in|manual)\b/.test(value)) return "getting-started";
  if (/\b(security|platform|architecture|infrastructure|deployment|authentication|authorization|oauth|backup|recovery|server|hosting|network|database|privacy)\b/.test(value)) return "platform-security";
  if (/\b(people|team|teams|employee|employees|customer|customers|partner|partners|investor|investors|contact|contacts|relationship|relationships|hiring|personnel)\b/.test(value)) return "people-relationships";
  if (/\b(company|strategy|strategic|vision|mission|roadmap|business|organization|fundraising|pricing|market|marketing|positioning)\b/.test(value)) return "company-strategy";
  if (/\b(app|apps|application|applications|workflow|workflows|process|processes|operations|guide|guides|skill|skills|crm|expense|expenses|accounting|task|tasks|notification|notifications)\b/.test(value)) return "apps-workflows";
  return "other";
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function comparePages(a: PageSummary, b: PageSummary): number {
  return compareText(words(a.title), words(b.title)) || compareText(a.slug, b.slug) || compareText(a.page, b.page);
}

/** Local catalog filtering only; this does not replace full-text evidence search. */
export function filterWelcomePages(pages: readonly PageSummary[], query: string): PageSummary[] {
  const terms = words(query).split(" ").filter(Boolean);
  return pages.filter(page => {
    const value = words(`${page.title} ${page.slug} ${page.kind} ${page.summary}`);
    return terms.every(term => value.includes(term));
  }).sort(comparePages);
}

/** Input must be the complete nonarchived manifest selection from the API. */
export function groupWelcomePages(pages: readonly PageSummary[]): WelcomeGroup[] {
  const groups: WelcomeGroup[] = WELCOME_TOPICS.map(topic => ({ ...topic, pages: [] }));
  const byId = new Map(groups.map(group => [group.id, group]));
  for (const page of pages) byId.get(classifyWelcomePage(page))!.pages.push(page);
  for (const group of groups) group.pages.sort(comparePages);
  return groups;
}

function onboardingRank(page: PageSummary): number {
  const value = identity(page);
  if (/\b(onboarding|orientation|getting started|quickstart)\b/.test(value)) {
    // Give organization-wide entry points precedence over individual application
    // guides without relying on deployment-specific titles or reserved slugs.
    return /\b(employee|employees|colleague|colleagues|team|shared|company|organization|workspace|new joiner|new joiners)\b/.test(value) ? -1 : 0;
  }
  if (/\b(manual|welcome)\b/.test(value)) return 1;
  if (/\b(setup|installation|install)\b/.test(value)) return 2;
  if (/\b(login|sign in|authentication)\b/.test(value)) return 3;
  if (/\b(skill|skills)\b/.test(value)) return 4;
  return Infinity;
}

/** Suggest only existing guides; exclude historical/research/source references. */
export function onboardingPages(pages: readonly PageSummary[]): PageSummary[] {
  return pages.filter(page => {
    const topic = classifyWelcomePage(page);
    return !["handoffs-history", "meetings-notes", "research-proposals"].includes(topic) && Number.isFinite(onboardingRank(page));
  }).sort((a, b) => onboardingRank(a) - onboardingRank(b) || comparePages(a, b));
}
