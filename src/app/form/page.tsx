"use client";

import { submitProject } from "../lib/submissionApi";
import Link from "next/link";
import { FormEvent, ReactNode, useRef, useState } from "react";
import CircularText from "../components/CircularText";
import PacketPage, {
  field,
  fieldError,
  fieldHint,
  fieldLabel,
  primaryButton,
  secondaryButton,
  textLink,
} from "../components/PacketPage";
import { DEADLINE_LABEL, usePhase } from "../lib/hackathon";
import { SUBMISSION_LIMITS, validateSubmission, type SubmissionErrors as Errors } from "../../../shared/submissions.ts";

const shareText = "I just submitted my project to Nut November. https://nutnovember.org/ #NutNovember";
const shareUrl = `https://twitter.com/intent/tweet?text=${encodeURIComponent(shareText)}`;

function Field({
  id,
  label,
  hint,
  error,
  children,
}: {
  id: string;
  label: ReactNode;
  hint?: ReactNode;
  error?: string;
  children: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-2">
      <label htmlFor={id} className={fieldLabel}>
        {label}
      </label>
      {hint && (
        <p id={`${id}-hint`} className={fieldHint}>
          {hint}
        </p>
      )}
      {children}
      {error && (
        <p id={`${id}-error`} className={fieldError}>
          {error}
        </p>
      )}
    </div>
  );
}

const describedBy = (id: keyof Errors, errors: Errors, hint = false) =>
  [hint ? `${id}-hint` : null, errors[id] ? `${id}-error` : null].filter(Boolean).join(" ") || undefined;

function Closed({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-8 text-center">
      <p className="max-w-[40ch] text-lg text-bark-dark text-balance">{children}</p>
      <div className="flex flex-col items-center gap-4 sm:flex-row">
        <Link href="/#prizes" className={primaryButton}>
          See the prizes
        </Link>
        <Link href="/donate" className={secondaryButton}>
          Donate sats
        </Link>
      </div>
    </div>
  );
}

function Page() {
  const phase = usePhase();
  const [success, setSuccess] = useState(false);
  const [submissionError, setSubmissionError] = useState<string | null>(null);
  const [isPending, setIsPending] = useState(false);
  const submitting = useRef(false);
  const [errors, setErrors] = useState<Errors>({});
  const [projectName, setProjectName] = useState("");
  const formRef = useRef<HTMLFormElement>(null);

  async function handleSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting.current) return;
    const parsed = validateSubmission(Object.fromEntries(new FormData(e.currentTarget)));
    const found = parsed.errors ?? {};
    setErrors(found);
    if (parsed.errors) {
      const first = Object.keys(parsed.errors)[0];
      formRef.current?.querySelector<HTMLElement>(`[name="${first}"]`)?.focus();
      return;
    }
    submitting.current = true;
    setIsPending(true);
    setSubmissionError(null);
    setProjectName(parsed.data.projectName);
    try {
      await submitProject(parsed.data);
      setSuccess(true);
    } catch (error) {
      setSubmissionError(error instanceof Error ? error.message : "Please try again in a moment.");
    } finally {
      submitting.current = false;
      setIsPending(false);
    }
  }

  if (success) {
    return (
      <PacketPage title="Your nut is in!">
        <div role="status" className="flex flex-col items-center gap-8 text-center">
          <div className="sticker-lift rounded-full border-4 border-cream bg-bark p-1">
            <CircularText />
          </div>
          <p className="max-w-[40ch] text-xl text-bark-dark text-balance">
            We&apos;ve got <strong className="font-semibold">{projectName}</strong>. Keep building until{" "}
            {DEADLINE_LABEL}, and tell everyone with #NutNovember.
          </p>
          <div className="flex flex-col items-center gap-4 sm:flex-row">
            <a href={shareUrl} target="_blank" rel="noopener noreferrer" className={primaryButton}>
              Post on X
            </a>
            <Link href="/" className={secondaryButton}>
              Back to Nut November
            </Link>
          </div>
        </div>
      </PacketPage>
    );
  }

  const intro =
    phase?.kind === "upcoming" ? (
      `Submissions open on Nov 1.`
    ) : phase?.kind === "over" ? (
      "Submissions are closed."
    ) : (
      <>Due {DEADLINE_LABEL}. Unfinished is fine: send what you have.</>
    );

  return (
    <PacketPage title="Submit your project" intro={phase ? intro : null}>
      {phase === null ? (
        <div className="min-h-[40vh]" />
      ) : phase.kind === "upcoming" ? (
        <Closed>
          The hackathon starts in {phase.days} {phase.days === 1 ? "day" : "days"}. Come back then with your
          project, and pick a prize to aim for in the meantime.
        </Closed>
      ) : phase.kind === "over" ? (
        <Closed>Nut November 2026 is over. Thanks to everyone who built something. 🌰</Closed>
      ) : (
        <form ref={formRef} onSubmit={handleSubmit} noValidate className="mx-auto flex max-w-xl flex-col gap-8">
          <Field id="projectName" label="Project name" error={errors.projectName}>
            <input
              id="projectName"
              name="projectName"
              maxLength={SUBMISSION_LIMITS.projectName}
              type="text"
              autoComplete="off"
              aria-invalid={errors.projectName ? true : undefined}
              aria-describedby={describedBy("projectName", errors)}
              className={field}
            />
          </Field>

          <fieldset
            className="flex flex-col gap-3"
            aria-describedby={errors.firstContribution ? "firstContribution-error" : "firstContribution-hint"}
          >
            <legend className={fieldLabel}>Is this your first Cashu contribution?</legend>
            <p id="firstContribution-hint" className={`${fieldHint} -mt-1`}>
              First-timers are in the running for the Freshly Minted Nut.
            </p>
            <div className="flex gap-4">
              {["yes", "no"].map((v) => (
                <label
                  key={v}
                  className="flex cursor-pointer items-center gap-3 border-4 border-bark bg-cream px-5 py-3 text-lg font-semibold text-bark-dark has-[:checked]:bg-bark has-[:checked]:text-cream has-[:focus-visible]:outline has-[:focus-visible]:outline-[3px] has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-bark"
                >
                  <input type="radio" name="firstContribution" value={v} className="h-5 w-5 accent-pumpkin" />
                  {v === "yes" ? "Yes" : "No"}
                </label>
              ))}
            </div>
            {errors.firstContribution && (
              <p id="firstContribution-error" className={fieldError}>
                {errors.firstContribution}
              </p>
            )}
          </fieldset>

          <Field
            id="description"
            label="What did you build?"
            hint="What it does, what you made during Nut November, and which prize you're going for."
            error={errors.description}
          >
            <textarea
              id="description"
              name="description"
              maxLength={SUBMISSION_LIMITS.description}
              rows={6}
              aria-invalid={errors.description ? true : undefined}
              aria-describedby={describedBy("description", errors, true)}
              className={`${field} resize-y`}
            />
          </Field>

          <Field id="githubRepo" label="Code" hint="A GitHub repo, pull request or any public link." error={errors.githubRepo}>
            <input
              id="githubRepo"
              name="githubRepo"
              maxLength={SUBMISSION_LIMITS.githubRepo}
              type="url"
              inputMode="url"
              placeholder="https://github.com/you/project"
              aria-invalid={errors.githubRepo ? true : undefined}
              aria-describedby={describedBy("githubRepo", errors, true)}
              className={`${field} font-mono text-base`}
            />
          </Field>

          <Field
            id="demoLink"
            label={
              <>
                Demo <span className="font-normal text-bark/85">(optional)</span>
              </>
            }
            hint="A live site, video or screenshots."
            error={errors.demoLink}
          >
            <input
              id="demoLink"
              name="demoLink"
              maxLength={SUBMISSION_LIMITS.demoLink}
              type="url"
              inputMode="url"
              placeholder="https://"
              aria-invalid={errors.demoLink ? true : undefined}
              aria-describedby={describedBy("demoLink", errors, true)}
              className={`${field} font-mono text-base`}
            />
          </Field>

          <Field
            id="contactInfo"
            label="How can we reach you?"
            hint="Your Nostr npub, email or X handle, so we can send the sats if you win."
            error={errors.contactInfo}
          >
            <input
              id="contactInfo"
              name="contactInfo"
              maxLength={SUBMISSION_LIMITS.contactInfo}
              type="text"
              aria-invalid={errors.contactInfo ? true : undefined}
              aria-describedby={describedBy("contactInfo", errors, true)}
              className={field}
            />
          </Field>

          {submissionError && (
            <div role="alert" className="border-2 border-pumpkin-dark bg-pumpkin-wash p-5 text-bark-dark">
              <p className="font-semibold">We couldn&apos;t send your submission.</p>
              <p className="mt-1">Your answers are still here. {submissionError}</p>
            </div>
          )}

          <div className="mt-2 flex flex-col items-center gap-4">
            <button type="submit" disabled={isPending} className={primaryButton}>
              {isPending ? "Sending…" : "Submit project"}
            </button>
            <Link href="/#faq" className={`${textLink} text-base`}>
              Questions first?
            </Link>
          </div>
        </form>
      )}
    </PacketPage>
  );
}

export default Page;
