// The door of the package: named re-exports only, no `export *`.
export {
  AREA_TONES,
  BASE_HUE,
  CHART_STEPS,
  CHROMA_FACTORS,
  CHROMA_STEPS,
  DEFAULT_GLOBAL_THEME,
  DEFAULT_HOST_THEME,
  DEFAULT_MARK_THEME,
  DEFAULT_STACK_DISPLAY,
  DENSITY_STEPS,
  FOCUS_STEPS,
  FONT_STEPS,
  HUE_TONES,
  INDENT_STEPS,
  INK_STEPS,
  MARK_STYLE_STEPS,
  RADIUS_STEPS,
  SCHEME_STEPS,
  TERMINAL_SCHEME_STEPS,
  TERMINAL_SCROLLBACK_STEPS,
  TERMINAL_SIZE_STEPS,
  TERMINAL_SURFACE_STEPS,
  THEME_KNOBS
} from "./presets.js";
export type {
  AreaName,
  ChartName,
  ChromaName,
  DensityName,
  FocusName,
  FontName,
  GlobalThemePreset,
  HostThemePreset,
  HueName,
  HueTone,
  IndentName,
  InkName,
  KnobScope,
  MarkStyleName,
  MarkThemePreset,
  RadiusName,
  SchemeName,
  StackDisplayPreset,
  TerminalSchemeName,
  TerminalScrollbackName,
  TerminalSizeName,
  TerminalSurfaceName,
  ThemeKnobName
} from "./presets.js";
export { MARK_IDS_MAX, MARK_NAME_MAX } from "./marks.js";
export { HOST_NAME_MAX, hasControlOrLineSeparator, hostNameProblem } from "./host-input.js";
export type { HostNameProblem } from "./host-input.js";
export { quoteShellArgument } from "./shell.js";
export { markViewSchema } from "./api/marks.js";
export type { MarkView } from "./api/marks.js";
export {
  agentHealthSchema,
  agentUpdateOfferSchema,
  agentUpdateStateSchema,
  hostDisplaySchema,
  hostKindSchema,
  hostListSchema,
  hostResponseSchema,
  hostStateSchema,
  hostStatusSchema,
  hostViewSchema
} from "./api/hosts.js";
export type {
  AgentHealth,
  AgentUpdateOffer,
  AgentUpdateState,
  HostKind,
  HostList,
  HostResponse,
  HostState,
  HostStatus,
  HostView
} from "./api/hosts.js";
export {
  containerEntrySchema,
  containerStateSchema,
  containerStatsResponseSchema,
  containerStatsSampleSchema,
  containerStatsSchema,
  externalManagementSchema,
  hostContainersSchema,
  hostLoadSchema,
  hostOverviewSchema,
  loadPointSchema,
  overviewContainerSchema,
  overviewSchema,
  stackViewSchema
} from "./api/containers.js";
export type {
  ContainerEntry,
  ContainerState,
  ContainerStats,
  ContainerStatsResponse,
  ContainerStatsSample,
  ExternalManagement,
  HostContainers,
  HostLoad,
  HostOverview,
  LoadPoint,
  Overview,
  OverviewContainer,
  StackView
} from "./api/containers.js";
export {
  containerViewSettingsResponseSchema,
  containerViewSettingsSchema,
  globalThemeSchema,
  hubNetworkResponseSchema,
  hubNetworkViewSchema,
  LOG_TAIL_LINE_OPTIONS,
  logSettingsResponseSchema,
  logSettingsSchema,
  settingsSchema,
  themeResponseSchema
} from "./api/settings.js";
export type {
  ContainerViewSettings,
  HubNetworkView,
  LogSettings,
  LogTailLines,
  Settings
} from "./api/settings.js";
export {
  containerShareLookupSchema,
  containerShareResponseSchema,
  containerShareSchema,
  fileActionDoneSchema,
  fileActionResponseSchema,
  fileCommandActionSchema,
  fileCommandSchema,
  fileListingResponseSchema,
  fileListingSchema,
  fileTextResponseSchema,
  fileTextSavedSchema,
  fileTextSchema,
  fileUploadedSchema,
  fileUploadResponseSchema,
  shareCandidateSchema,
  shareCandidatesSchema,
  shareDiagnosticsSchema,
  webftpEntrySchema
} from "./api/files.js";
export type {
  ContainerShare,
  FileActionDone,
  FileCommand,
  FileCommandAction,
  FileListing,
  FileText,
  FileUploaded,
  ShareCandidate,
  ShareDiagnostics,
  WebftpEntry
} from "./api/files.js";
export { WEBFTP_ENTRY_KINDS } from "./webftp.js";
export type { WebftpEntryKind } from "./webftp.js";
export { isAbort, NDJSON_MAX_BUFFERED_CHARS, NDJSON_MAX_LINE_CHARS, readNdjson } from "./stream/ndjson.js";
export {
  HUB_COMPOSE_STREAM_REASONS,
  HUB_LOG_STREAM_REASONS,
  HUB_PERMISSION_REVOKED,
  HUB_SESSION_CLOSED,
  HUB_SHELL_STREAM_REASONS,
  HUB_STREAM_BROKEN
} from "./stream/hub-stream-reasons.js";
export type {
  NdjsonAbortSignal,
  NdjsonByteReader,
  NdjsonByteStream,
  NdjsonEvent,
  NdjsonReadOptions
} from "./stream/ndjson.js";

export {
  hostResourcesResponseSchema,
  hostResourcesViewSchema,
  imageResourceViewSchema,
  networkResourceViewSchema,
  volumeResourceViewSchema
} from "./api/resources.js";
export type {
  HostResourcesResponse,
  HostResourcesView,
  ImageResourceView,
  NetworkResourceView,
  VolumeResourceView
} from "./api/resources.js";

// The agent protocol (#272): one source for hub and agent.
export {
  hostResourcesSchema,
  imageResourceSchema,
  networkResourceSchema,
  RESOURCE_READ_FAILURES,
  resourceUserSchema,
  storageSummarySchema,
  storageUsageSchema,
  volumeResourceSchema
} from "./agent/resources.js";
export type {
  HostResources,
  ImageResource,
  NetworkResource,
  ResourceReadFailure,
  ResourceUser,
  StorageSummary,
  StorageUsage,
  VolumeResource
} from "./agent/resources.js";
export { CONTRACT_VERSION, contractSince, since } from "./agent/version.js";
export type { ContractSince } from "./agent/version.js";
export { ACTOR_HEADER, agentTierSchema, HUB_TIER, SECRET_HEADER, TIER_HEADER } from "./agent/headers.js";
export type { AgentTier } from "./agent/headers.js";
export {
  DEFAULT_TAIL,
  EXEC_DEFAULT_COLS,
  EXEC_DEFAULT_ROWS,
  EXEC_IDLE_MS,
  EXEC_MAX_COLS,
  EXEC_MAX_DURATION_MS,
  EXEC_MAX_INPUT_BASE64_CHARS,
  EXEC_MAX_ROWS,
  EXEC_MAX_SESSIONS,
  EXEC_MIN_COLS,
  EXEC_MIN_ROWS,
  EXEC_SHELL_CANDIDATES,
  MAX_COMPOSE_BYTES,
  MAX_ENTRIES,
  MAX_MONITOR_STREAMS,
  MAX_OPEN_STREAMS,
  MAX_TAIL,
  MAX_TEXT_BYTES,
  MAX_UPLOAD_BYTES,
  MIN_TAIL
} from "./agent/limits.js";
export {
  EXEC_REJECTION_KEYS,
  EXEC_SESSION_REJECTION_KEY,
  execRejectionKeySchema,
  LOG_FILE_FAILURE_REASONS,
  LOG_OPEN_FAILURE_REASONS,
  LOG_PATH_FAILURE_REASONS,
  logFileFailureReasonSchema,
  LOGS_STREAM_FAILURE_REASONS,
  logsStreamFailureReasonSchema,
  PULL_STREAM_FAILURE_REASONS,
  pullStreamFailureReasonSchema,
  REQUEST_REJECTION_REASONS,
  requestRejectionOf,
  requestRejectionReasonSchema,
  requestRejectionSchema,
  SHARED_HTTP_ERRORS
} from "./agent/reasons.js";
export type {
  ExecRejectionKey,
  LogFileFailureReason,
  LogOpenFailureReason,
  LogPathFailureReason,
  LogsStreamFailureReason,
  PullStreamFailureReason,
  RequestRejection,
  RequestRejectionReason
} from "./agent/reasons.js";
export {
  COMPOSE_RAW_APPLY_FAILURE_REASONS,
  COMPOSE_RAW_CHECK_FAILURE_REASONS,
  COMPOSE_RAW_FAILURE_REASONS,
  COMPOSE_RAW_FILE_FAILURE_REASONS,
  COMPOSE_RAW_GATE_FAILURE_REASONS,
  COMPOSE_RAW_PLAN_FAILURE_REASONS,
  COMPOSE_RAW_PREVIEW_FAILURE_REASONS,
  COMPOSE_RAW_STREAM_FAILURE_REASONS,
  composeRawFailureReasonSchema
} from "./agent/compose-reasons.js";
export type {
  ComposeRawApplyFailureReason,
  ComposeRawFailureReason,
  ComposeRawPlanFailureReason,
  ComposeRawPreviewFailureReason
} from "./agent/compose-reasons.js";
export {
  composeApplyStepSchema,
  composeApplyStreamLineSchema,
  execStreamLineSchema,
  imageMutabilitySchema,
  logFileStreamLineSchema,
  logLineStreamSchema,
  logsStreamLineSchema,
  monitorEventLineSchema,
  pullStreamLineSchema
} from "./agent/streams.js";
export type {
  ComposeApplyStep,
  ComposeApplyStreamLine,
  ExecStreamLine,
  ImageMutability,
  LogFileStreamLine,
  LogsStreamLine,
  MonitorEventLine,
  PullStreamLine
} from "./agent/streams.js";
export {
  auditDiscardRequestSchema,
  envQuerySchema,
  envWriteRequestSchema,
  execInputRequestSchema,
  fileActionRequestSchema,
  FILE_ACTIONS,
  fileActionSchema,
  fileTextWriteRequestSchema,
  fileUploadQuerySchema,
  logFileQuerySchema,
  logsSnapshotQuerySchema,
  logsStreamQuerySchema,
  monitorEntrySchema,
  monitorSyncRequestSchema,
  registryComposeSchema,
  registryEntrySchema,
  HUB_REGISTRY_ORIGIN,
  registryOriginSchema,
  registrySyncRequestSchema,
  selfUpdateRequestSchema,
  shareQuerySchema,
  terminalSizeSchema,
  utf8ByteLength
} from "./agent/requests.js";
export type {
  AuditDiscardRequest,
  EnvQuery,
  EnvWriteRequest,
  ExecInputRequest,
  FileAction,
  FileActionRequest,
  FileTextWriteRequest,
  FileUploadQuery,
  LogFileQuery,
  LogsSnapshotQuery,
  LogsStreamQuery,
  MonitorEntry,
  MonitorSyncRequest,
  RegistryCompose,
  RegistryEntry,
  RegistryOrigin,
  RegistrySyncRequest,
  SelfUpdateRequest,
  ShareQuery,
  TerminalSize,
  TerminalSizeRequest
} from "./agent/requests.js";
export {
  applySpecRequestSchema,
  composeRawPreviewRequestSchema,
  composeRawWriteRequestSchema,
  composeSelectionRequestSchema,
  containerCreateRequestSchema,
  expectedStackSchema,
  recreateRequestSchema,
  stackActionRequestSchema,
  stackAdoptRequestSchema,
  stackRawPreviewRequestSchema,
  stackRawRequestSchema
} from "./agent/compose-requests.js";
export type {
  ApplySpecRequest,
  ComposeConfirmations,
  ComposeRawPreviewRequest,
  ComposeRawWriteRequest,
  ComposeSelectionRequest,
  ContainerCreateRequest,
  ExpectedStack,
  RecreateRequest,
  StackActionRequest,
  StackAdoptRequest,
  StackRawPreviewRequest,
  StackRawRequest
} from "./agent/compose-requests.js";
export { MOUNT_SOURCE_KINDS, mountSourceSchema } from "./agent/projects.js";
export type { MountSource, MountSourceKind } from "./agent/projects.js";
export {
  CONTAINER_NAME_PATTERN,
  containerSpecSchema,
  hasControlCharacter,
  restartPolicySchema,
  specPortSchema,
  specResourcesSchema,
  specVolumeSchema
} from "./agent/spec.js";
export type { ContainerSpecInput, SpecPort, SpecVolume } from "./agent/spec.js";
