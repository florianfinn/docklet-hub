import * as z from "zod/mini";

// The requests of the compose surface (#272): the raw editor, stacks, the
// container definition and recreating. The rules of `requests.ts` apply: a
// schema checks the shape, the agent checks what depends on the host, and a
// check names its key in `error`.

const stringList = () => z._default(z.array(z.string()), []);

/**
 * `POST /containers/:id/compose-raw-preview`: the dry run (#85). The same text
 * as applying, without the confirmations — it decides nothing.
 */
export const composeRawPreviewRequestSchema = z.object({ content: z._default(z.string(), "") });
export type ComposeRawPreviewRequest = z.input<typeof composeRawPreviewRequestSchema>;

/** The answers to the three follow-up questions of applying. */
const composeConfirmations = {
  // The services that are new, and those that drop out, named back.
  confirmNew: stringList(),
  confirmRemoved: stringList(),
  // The images missing locally that may be pulled.
  acknowledgeImagePull: stringList(),
  // The hardening violations the operator accepts.
  acknowledgeHardening: stringList()
};

/**
 * `POST /containers/:id/compose-raw` and `…/compose-raw-stream`: apply a
 * compose file at the anchor of a stack.
 *
 * ⚠️ `expectedComposeHash` HAS NO "DON'T CARE": the hash of the file as last
 * read. A file changed in between is refused, not overwritten.
 *
 * `confirmName` is the typed confirmation, the directory name of the stack;
 * whether it matches is the agent's check.
 */
export const composeRawWriteRequestSchema = z.object({
  content: z._default(z.string(), ""),
  expectedComposeHash: z.pipe(
    z.string({ error: "compose-hash-missing" }),
    z.pipe(z.transform((value: string) => value.trim()), z.string().check(z.minLength(1, { error: "compose-hash-missing" })))
  ),
  confirmName: z.pipe(z._default(z.string(), ""), z.transform((value) => value.trim())),
  ...composeConfirmations
});
export type ComposeRawWriteRequest = z.input<typeof composeRawWriteRequestSchema>;

/** The four answers as the agent has them after parsing: always lists. */
export type ComposeConfirmations = Pick<
  z.output<typeof composeRawWriteRequestSchema>,
  "confirmNew" | "confirmRemoved" | "acknowledgeImagePull" | "acknowledgeHardening"
>;

/**
 * `POST /stacks/raw`: create a new stack from a compose file. `name` becomes
 * the directory and the compose project; whether it is usable is the agent's
 * check.
 */
export const stackRawRequestSchema = z.object({
  name: z.pipe(z._default(z.string(), ""), z.transform((value) => value.trim())),
  content: z._default(z.string(), ""),
  ...composeConfirmations
});
export type StackRawRequest = z.input<typeof stackRawRequestSchema>;

/** `POST /stacks/adopt`: read the compose context of a running container. */
export const stackAdoptRequestSchema = z.object({
  containerId: z.string({ error: "container-id-missing" }).check(z.minLength(1, { error: "container-id-missing" }))
});
export type StackAdoptRequest = z.input<typeof stackAdoptRequestSchema>;

/** One service of a stack as the caller last saw it. */
export const expectedStackServiceSchema = z.object({
  serviceName: z.string(),
  containerId: z.nullable(z.string())
});

/**
 * What the caller saw of a stack before acting on it. The agent refuses with
 * `409 stack-expectation-mismatch` when the stack looks different now.
 */
export const expectedStackSchema = z.object({
  projectName: z.string(),
  projectDir: z.string(),
  composeFileName: z.string(),
  services: z.array(expectedStackServiceSchema)
});
export type ExpectedStack = z.infer<typeof expectedStackSchema>;

/** `POST /stacks/:anchor/actions/:action`: start, stop, restart, apply, down. */
export const stackActionRequestSchema = z.object({
  expectedStack: expectedStackSchema,
  // `down` only: the project name, typed again.
  confirmation: z.optional(z.string()),
  // `start` only: bring up services that have no container yet.
  allowFallbackUp: z._default(z.boolean(), false),
  // `apply` only.
  forceRecreate: z._default(z.boolean(), false)
});
export type StackActionRequest = z.input<typeof stackActionRequestSchema>;

/** `PUT /containers/:id/compose-selection`: pick one of the offered files. */
export const composeSelectionRequestSchema = z.object({ filePath: z.string() });
export type ComposeSelectionRequest = z.input<typeof composeSelectionRequestSchema>;

/**
 * `POST /containers/:id/recreate`: recreate on the image the allowlist names.
 *
 * `acknowledgeImageId` confirms the image the caller saw in the preview; the
 * compose path also needs the file's hash. Both are compared by the agent.
 */
export const recreateRequestSchema = z.object({
  acknowledgeImageId: z._default(z.string(), ""),
  expectedComposeHash: z._default(z.string(), ""),
  rollbackOnUnhealthy: z._default(z.boolean(), false)
});
export type RecreateRequest = z.input<typeof recreateRequestSchema>;

/**
 * `POST /containers` (create) and `POST /containers/:id/apply-spec`.
 *
 * ⚠️ `spec` IS CHECKED APART, against `containerSpecSchema` in `spec.ts`, so
 * that the agent can answer with every failing field at once
 * (`invalid-spec` with `errors`) and add the checks that need its base path.
 */
export const containerCreateRequestSchema = z.object({
  spec: z.unknown(),
  // Class "secured" (stage 5e). On create it can only tighten.
  secured: z._default(z.boolean(), false)
});
export type ContainerCreateRequest = z.input<typeof containerCreateRequestSchema>;

export const applySpecRequestSchema = z.object({
  spec: z.unknown(),
  expectedComposeHash: z.string({ error: "compose-hash-missing" }).check(z.minLength(1, { error: "compose-hash-missing" }))
});
export type ApplySpecRequest = z.input<typeof applySpecRequestSchema>;
