/**
 * Render the shipped CI workflow.
 *
 * The template carries four placeholders so the same bytes serve an adopter's
 * workflow and this repository's dogfood instance. Rendering is deliberately
 * strict: an unknown placeholder is an error, not a literal that ships.
 */
export interface WorkflowParams {
  /** How the job makes the `invariant` binary available (may include a build). */
  cliSetup: string;
  /** The command prefix that runs the CLI (`npx --no-install invariant`, a node path, ...). */
  invariantCmd: string;
  /** The CLI version named in the header and available to `cliSetup` callers. */
  invariantVersion: string;
  /** Recorded in the header; the CLI's config remains the source of truth. */
  protectedPaths: string[];
}

const PLACEHOLDERS = {
  __CLI_SETUP__: (params: WorkflowParams) => params.cliSetup,
  __INVARIANT_CMD__: (params: WorkflowParams) => params.invariantCmd,
  __INVARIANT_VERSION__: (params: WorkflowParams) => params.invariantVersion,
  __PROTECTED_PATHS__: (params: WorkflowParams) => params.protectedPaths.join(", "),
} as const;

export function renderWorkflow(template: string, params: WorkflowParams): string {
  let rendered = template;
  for (const [placeholder, value] of Object.entries(PLACEHOLDERS)) {
    // A function replacement keeps `$&` and friends in a parameter literal.
    rendered = rendered.replaceAll(placeholder, () => value(params));
  }

  const left = [...rendered.matchAll(/__[A-Z0-9_]+__/g)].map((match) => match[0]);
  if (left.length > 0) {
    throw new Error(`workflow template has unrendered placeholders: ${[...new Set(left)].join(", ")}`);
  }
  return rendered;
}
