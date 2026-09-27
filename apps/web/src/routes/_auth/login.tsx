import { createFileRoute, useNavigate, useSearch } from "@tanstack/react-router"
import { useForm } from "react-hook-form"
import { zodResolver } from "@hookform/resolvers/zod"
import { toast } from "sonner"
import { login } from "@/lib/auth"
import { loginSchema } from "@/lib/schemas"
import type { LoginInput } from "@/lib/schemas"
import { Button } from "@workspace/ui/components/button"
import { Input } from "@workspace/ui/components/input"
import {
  Form,
  FormControl,
  FormField,
  FormItem,
  FormLabel,
  FormMessage,
} from "@workspace/ui/components/form"
import { GoogleIcon } from "@/components/google-icon"

export const Route = createFileRoute("/_auth/login")({
  component: LoginPage,
  validateSearch: (search: Record<string, unknown>): { inviteId?: string } => ({
    inviteId: typeof search.inviteId === "string" ? search.inviteId : undefined,
  }),
})

function LoginPage() {
  const navigate = useNavigate()
  const { inviteId } = useSearch({ from: "/_auth/login" })

  const form = useForm<LoginInput>({
    resolver: zodResolver(loginSchema),
    defaultValues: { email: "", password: "" },
  })

  async function onSubmit(data: LoginInput) {
    try {
      await login({ data: { ...data, inviteId } })
      navigate({ to: "/inbox" })
    } catch (err: any) {
      toast.error(err?.message ?? "Login failed")
    }
  }

  return (
    <div>
      <div className="mb-6 text-center">
        <h1 className="mb-1 text-3xl font-semibold tracking-tight text-foreground md:text-4xl">
          Welcome back
        </h1>
        <p className="text-sm text-muted-foreground">
          Sign in to your Replyloom workspace
        </p>
      </div>

      <Button
        type="button"
        variant="outline"
        disabled
        title="Google sign-in is coming soon"
        className="mb-4 w-full gap-3 rounded-full"
      >
        <GoogleIcon className="text-lg" />
        Continue with Google
      </Button>

      <div className="relative mb-6 flex items-center">
        <div className="grow border-t border-border" />
        <span className="px-4 text-sm text-muted-foreground">or</span>
        <div className="grow border-t border-border" />
      </div>

      <Form {...form}>
        <form onSubmit={form.handleSubmit(onSubmit)} className="flex flex-col gap-4">
          <FormField
            control={form.control}
            name="email"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Email</FormLabel>
                <FormControl>
                  <Input
                    id="email"
                    type="email"
                    placeholder="you@example.com"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />
          <FormField
            control={form.control}
            name="password"
            render={({ field }) => (
              <FormItem>
                <FormLabel>Password</FormLabel>
                <FormControl>
                  <Input
                    id="password"
                    type="password"
                    placeholder="••••••••"
                    {...field}
                  />
                </FormControl>
                <FormMessage />
              </FormItem>
            )}
          />

          <Button
            type="submit"
            disabled={form.formState.isSubmitting}
            className="mt-1 w-full rounded-full bg-gradient-to-b from-primary to-primary/80 py-3.5 shadow-sm hover:opacity-90 active:scale-[0.98]"
          >
            {form.formState.isSubmitting ? "Signing in..." : "Sign in"}
          </Button>

          <p className="mt-1 text-center text-sm text-muted-foreground">
            Don&apos;t have an account?{" "}
            <a
              href={inviteId ? `/signup?inviteId=${inviteId}` : "/signup"}
              className="font-semibold text-foreground hover:underline"
            >
              Sign up
            </a>
          </p>
        </form>
      </Form>
    </div>
  )
}
