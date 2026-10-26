export interface SubmissionRequest {
  projectName: string;
  firstContribution: "yes" | "no";
  description: string;
  githubRepo: string;
  demoLink: string;
  contactInfo: string;
}

export type SubmissionErrors = Partial<Record<keyof SubmissionRequest | "form", string>>;

export const SUBMISSION_LIMITS = {
  projectName: 120,
  description: 5000,
  githubRepo: 2048,
  demoLink: 2048,
  contactInfo: 500,
} as const;
// Includes JSON escaping and UTF-8 overhead at the field limits.
export const SUBMISSION_MAX_BODY_BYTES = 64 * 1024;

export function validateSubmission(value: unknown):
  { data: SubmissionRequest; errors?: never } | { data?: never; errors: SubmissionErrors } {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { errors: { form: "Invalid submission." } };
  }
  const input = value as Record<string, unknown>;
  const errors: SubmissionErrors = {};
  if (Object.keys(input).some((key) => key !== "firstContribution" && !Object.hasOwn(SUBMISSION_LIMITS, key))) {
    errors.form = "Unknown submission field.";
  }
  const required = {
    projectName: "Give your project a name.",
    description: "Tell us what you built.",
    githubRepo: "Add a link to the code.",
    demoLink: "",
    contactInfo: "Add a way to reach you if you win.",
  };
  const fields = {} as Record<keyof typeof SUBMISSION_LIMITS, string>;
  for (const name of Object.keys(SUBMISSION_LIMITS) as (keyof typeof SUBMISSION_LIMITS)[]) {
    const raw = input[name] === undefined && name === "demoLink" ? "" : input[name];
    fields[name] = typeof raw === "string" ? raw.trim() : "";
    if (typeof raw !== "string") errors[name] = required[name] || "Enter a link or leave this empty.";
    else if (raw.length > SUBMISSION_LIMITS[name]) errors[name] = `Use at most ${SUBMISSION_LIMITS[name]} characters.`;
    else if (!fields[name] && required[name]) errors[name] = required[name];
  }
  if (input.firstContribution !== "yes" && input.firstContribution !== "no") errors.firstContribution = "Pick yes or no.";
  for (const name of ["githubRepo", "demoLink"] as const) {
    if (!fields[name] || errors[name]) continue;
    try {
      const url = new URL(fields[name]);
      if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) throw new Error("Invalid URL");
    } catch {
      errors[name] = "That doesn't look like a link. It should start with https://";
    }
  }
  if (Object.keys(errors).length) return { errors };
  return { data: { ...fields, firstContribution: input.firstContribution as "yes" | "no" } };
}
