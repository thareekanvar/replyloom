// Shared by apps/web (composer + broadcast dialog, resolving against one
// contact) and apps/worker (resolving per-recipient right before a
// broadcast send) -- one implementation so "what counts as a variable"
// and "what a contact's {{name}} resolves to" can't drift between them.
export type TemplateVariables = Record<string, string | undefined>;

const VARIABLE_RE = /\{\{\s*([a-zA-Z0-9_]+)\s*\}\}/g;

/** Every distinct {{variable}} name referenced in a template body, in first-seen order. */
export function extractTemplateVariables(body: string | null | undefined): string[] {
  if (!body) return [];
  const found: string[] = [];
  const seen = new Set<string>();
  for (const m of body.matchAll(VARIABLE_RE)) {
    const name = m[1];
    if (!seen.has(name)) {
      seen.add(name);
      found.push(name);
    }
  }
  return found;
}

/**
 * Replaces every {{variable}} with its value. A variable with no value (or
 * an empty one) is left in place rather than collapsed to "" -- silently
 * sending "Hi ," instead of "Hi {{name}}," is the wrong failure mode here,
 * since a blank name is far easier to miss before hitting send.
 */
export function resolveTemplate(body: string | null | undefined, vars: TemplateVariables): string {
  if (!body) return "";
  return body.replace(VARIABLE_RE, (match, name: string) => {
    const value = vars[name];
    return value && value.trim() ? value : match;
  });
}

/** The standard variable set built from a contact row -- same shape apps/web's Conversation and apps/worker's `contacts` select both already carry. */
export function contactTemplateVariables(contact: {
  name?: string | null;
  phoneNumber?: string | null;
  lifecycleStage?: string | null;
} | null | undefined): TemplateVariables {
  const name = (contact?.name || contact?.phoneNumber || "").trim();
  return {
    name,
    firstName: name.split(/\s+/)[0] || name,
    phone: contact?.phoneNumber ?? "",
    lifecycleStage: contact?.lifecycleStage ?? "",
  };
}
