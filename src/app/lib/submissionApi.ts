import type { SubmissionRequest } from "../../../shared/submissions.ts";
import { API_URL } from "./api.ts";

export async function submitProject(input: SubmissionRequest): Promise<void> {
  const response = await fetch(`${API_URL}/submissions`, {
    method: "POST", cache: "no-store", headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input), signal: AbortSignal.timeout(15_000),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value?.error?.message ?? "Please try again in a moment.");
  if (response.status !== 201 || typeof value?.id !== "string") throw new Error("Unexpected response from the submission service.");
}
