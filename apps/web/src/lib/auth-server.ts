import { betterAuth } from "better-auth"
import { drizzleAdapter } from "better-auth/adapters/drizzle"
import { organization } from "better-auth/plugins"
import { tanstackStartCookies } from "better-auth/tanstack-start"
import { env } from "cloudflare:workers"
import { createDb } from "@workspace/db"
import * as schema from "@workspace/db/schema"
import { escapeHtml } from "@/lib/html"
import { sendEmail } from "@/lib/resend"

// Single Better Auth instance for the Worker. D1/R2/etc bindings are static
// per Worker deployment (not per-request), so it's safe to build this once
// at module scope — same pattern the rest of this app already uses for
// `env` from "cloudflare:workers".
if (
  env.BETTER_AUTH_URL.includes("localhost") ||
  env.BETTER_AUTH_URL.includes(".workers.dev")
) {
  // Not fatal — the default *.workers.dev URL works fine for trying this
  // out — but cookies/redirects will be wrong once a custom domain is
  // live, so make it impossible to miss in production logs.
  console.warn(
    `[auth] BETTER_AUTH_URL is still "${env.BETTER_AUTH_URL}" — set it to ` +
      `your production domain in apps/web/wrangler.jsonc before going live.`,
  )
}

export const auth = betterAuth({
  database: drizzleAdapter(createDb(env.DB), {
    provider: "sqlite",
    schema,
    // D1 doesn't support the interactive multi-statement transactions the
    // adapter would otherwise try to use.
    transaction: false,
  }),
  secret: env.BETTER_AUTH_SECRET,
  baseURL: env.BETTER_AUTH_URL,
  emailAndPassword: {
    enabled: true,
    minPasswordLength: 8,
    // Intentionally NOT requireEmailVerification: this app ships without a
    // mandatory verify-before-login gate, so nobody can be locked out when
    // RESEND_API_KEY isn't configured yet (sendEmail degrades to a log line).
    // Flip to true once email delivery is confirmed in production -- every
    // flow it needs (send below + /api/auth/verify-email) is already wired.
    requireEmailVerification: false,
  },
  emailVerification: {
    // Sent on sign-up so `user.emailVerified` becomes trustworthy for
    // features that care (invites already match on address).
    sendOnSignUp: true,
    autoSignInAfterVerification: true,
    sendVerificationEmail: async ({ user, url }) => {
      try {
        await sendEmail({
          to: user.email,
          subject: "Verify your email address",
          html: `
          <div style="font-family:sans-serif;max-width:480px;margin:0 auto">
            <h2>Confirm your email</h2>
            <p>Confirm ${escapeHtml(user.email)} to finish setting up your account.</p>
            <p><a href="${url}" style="display:inline-block;background:#16a34a;color:#fff;padding:10px 20px;border-radius:8px;text-decoration:none">Verify email</a></p>
            <p style="color:#666;font-size:13px">If you didn't sign up, you can safely ignore this email.</p>
          </div>`,
        })
      } catch (err) {
        // Never fail sign-up because mail delivery failed -- the account is
        // created either way (verification is advisory, see above).
        console.error("[auth] verification email failed", err)
      }
    },
  },
  session: {
    expiresIn: 60 * 60 * 24 * 30, // 30 days
    // Signed session cookie cache: getSession() verifies the cookie instead
    // of hitting D1 (session + user rows) on every server-function call.
    // Trade-off: a revoked session stays valid for up to maxAge.
    cookieCache: { enabled: true, maxAge: 5 * 60 },
  },
  // Adding Google/GitHub/etc later just means adding a `socialProviders`
  // block here plus a catch-all /api/auth/$ route for the OAuth redirect +
  // callback. Skipped for now — email/password only.
  plugins: [
    // Multi-tenancy: an "organization" here IS this app's "workspace" —
    // see packages/db/src/schema/tenancy.ts, which re-exports Better
    // Auth's own `organization`/`member` tables under our domain names so
    // the rest of the app never has to know Better Auth owns them.
    // Default roles (owner/admin/member) are used as-is — "member" is
    // this app's "agent" role.
    organization(),
    // Must stay last: makes every auth.api.* call below automatically set
    // its Set-Cookie via TanStack Start's setCookie(), instead of us having
    // to forward headers by hand.
    tanstackStartCookies(),
  ],
})
