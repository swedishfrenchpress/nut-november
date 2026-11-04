import { DEADLINE_LABEL } from "../../../shared/hackathon.ts";

const rules: { title: string; body: string }[] = [
  {
    title: "Build it in November.",
    body: "Everything you submit must be made between Nov 1 and the deadline. Code, design and docs all count.",
  },
  {
    title: "Existing projects are welcome.",
    body: "If you're building on something that already existed, use the Notes section of the submission form to tell us what was there before Nov 1 and what you added. We judge only the November work, and we may disqualify a project if we can't tell what's new.",
  },
  {
    title: `Submit by ${DEADLINE_LABEL}.`,
    body: "Commits after the deadline don't count. You can resubmit before then to update your entry, and we judge your latest submission.",
  },
  {
    title: "Teams are welcome.",
    body: "Build alone or with friends. We send the prize to whoever submits, and the team splits it.",
  },
  {
    title: "Coding agents are encouraged.",
    body: "Use any AI tools you like. You're responsible for what you ship, so make sure it works.",
  },
  {
    title: "Open source, built on Cashu.",
    body: "Your code must be public under an open-source license, and the project must use or improve Cashu.",
  },
  {
    title: "One prize per project.",
    body: "Every project is considered for every category but can win only one. Judges can't win prizes. Anyone else can.",
  },
];

export default function Rules() {
  return (
    <section id="rules" className="bg-cream px-6 pt-4 pb-24">
      <div className="mx-auto max-w-6xl">
        <h2
          className="text-5xl sm:text-6xl leading-[0.95] text-bark"
          style={{ fontFamily: "var(--font-sauce-tm)" }}
        >
          Rules
        </h2>

        {/* One ruled list, like the FAQ below it. Each row is numeral | title
            | body on wide screens, with the body under the title on narrow ones. */}
        <ol className="mt-12 border-b border-bark/40">
          {rules.map((rule, i) => (
            <li
              key={rule.title}
              className="grid grid-cols-[2.25rem_minmax(0,1fr)] items-baseline gap-x-4 border-t border-bark/40 py-6 lg:grid-cols-[2.5rem_minmax(0,20rem)_minmax(0,1fr)] lg:gap-x-8"
            >
              <span
                aria-hidden
                className="text-4xl leading-none text-pumpkin lg:text-5xl"
                style={{ fontFamily: "var(--font-sauce-tm)" }}
              >
                {i + 1}
              </span>
              <h3 className="text-xl font-semibold text-bark-dark">{rule.title}</h3>
              <p className="col-start-2 mt-2 max-w-[60ch] leading-relaxed text-bark-dark/85 lg:col-start-3 lg:mt-0">
                {rule.body}
              </p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
