import { env } from "cloudflare:workers"

/**
 * Minimal Resend client — a single `fetch` to their REST API instead of
 * the `resend` npm package, so sending a transactional email (invites,
 * later maybe digest emails) doesn't need a new dependency installed.
 * https://resend.com/docs/api-reference/emails/send-email
 *
 * Needs `RESEND_API_KEY` (secret — set via `wrangler secret put
 * RESEND_API_KEY`, or in apps/web/.dev.vars locally) and `RESEND_FROM_EMAIL`
 * (plain var, already in wrangler.jsonc — change it to a domain you've
 * verified with Resend before sending in production).
 */
export async function sendEmail({
  to,
  subject,
  html,
}: {
  to: string
  subject: string
  html: string
}) {
  const apiKey = (env as any).RESEND_API_KEY as string | undefined
  const from = (env as any).RESEND_FROM_EMAIL as string | undefined

  if (!apiKey) {
    // Don't hard-fail invites just because email isn't configured yet —
    // log it server-side so a developer notices, but let the invitation
    // itself still get created (it can be shared as a link manually).
    console.warn(
      `[resend] RESEND_API_KEY not set — skipped sending "${subject}" to ${to}`
    )
    return { skipped: true as const }
  }

  // Warn if using Resend's sandbox address — emails will fail silently
  // in production (only deliverable to the account owner's email).
  const resolvedFrom = from || "onboarding@resend.dev"
  if (resolvedFrom === "onboarding@resend.dev") {
    console.warn(
      `[resend] RESEND_FROM_EMAIL is "onboarding@resend.dev" (sandbox mode). ` +
      `Emails will not be delivered to recipients. Set a verified domain address.`
    )
  }

  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: resolvedFrom,
      to: [to],
      subject,
      html,
    }),
  })

  if (!res.ok) {
    const body = await res.text().catch(() => "")
    console.error(`[resend] send failed: ${res.status} ${body}`)
    throw new Error("Couldn't send the invitation email.")
  }

  return { skipped: false as const, id: (await res.json<{ id: string }>()).id }
}
