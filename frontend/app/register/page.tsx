"use client";

import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { AuthLink, AuthShell } from "@/components/auth-shell";
import { FormError, FormField } from "@/components/form-field";
import { Button } from "@/components/ui/button";
import { ApiError } from "@/lib/api";
import { useAuth } from "@/lib/auth-context";

export default function RegisterPage() {
  const { status, register } = useAuth();
  const router = useRouter();

  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (status === "authed") router.replace("/");
  }, [status, router]);

  async function onSubmit(event: React.FormEvent) {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      // Registering signs you in: the backend sets the cookie on its 201, so
      // there is no second call to make and no second failure mode to handle.
      await register(name, email, password);
      router.replace("/");
    } catch (caught) {
      setError(caught instanceof ApiError ? caught.message : "Could not reach the server.");
      setSubmitting(false);
    }
  }

  return (
    <AuthShell
      title="Create an account"
      intro="Link a judge afterwards and your solve history fills in the rest."
      footer={
        <>
          Already have an account? <AuthLink href="/login">Sign in</AuthLink>
        </>
      }
    >
      <form onSubmit={onSubmit} className="grid gap-4" noValidate>
        <FormError message={error} />

        <FormField
          id="name"
          label="Name"
          value={name}
          onChange={setName}
          autoComplete="name"
          disabled={submitting}
        />
        <FormField
          id="email"
          label="Email"
          type="email"
          value={email}
          onChange={setEmail}
          autoComplete="email"
          disabled={submitting}
        />
        {/* NO CLIENT-SIDE LENGTH CHECK, DELIBERATELY. The backend rejects
            anything under 8 characters with a specific message, and duplicating
            that rule here would create two places for it to live and one of
            them to fall out of date. The hint states the rule up front so the
            user is not surprised by it; the server remains the authority. */}
        <FormField
          id="password"
          label="Password"
          type="password"
          value={password}
          onChange={setPassword}
          autoComplete="new-password"
          hint="At least 8 characters."
          disabled={submitting}
        />

        <Button type="submit" disabled={submitting} className="mt-2 h-9 rounded-[2px]">
          {submitting ? "Creating account…" : "Create account"}
        </Button>
      </form>
    </AuthShell>
  );
}
