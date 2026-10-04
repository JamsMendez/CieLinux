// Configuration: the defaults, a defensive deep merge for user overrides,
// and the rule lookup that turns an agent type or tool name into a scene.
// Pure: no `$`, no I/O.

export type SceneTarget = { scene: string; priority: number }

export type SceneRule = {
  kind: 'agent' | 'tool'
  /** A glob (`*` is any run of characters, case-sensitive) or a list of them. */
  match: string | string[]
  /** The scene to show, or null to ignore the activity. */
  scene: string | null
  priority: number
}

export type ScenesConfig = {
  turn: SceneTarget
  idle: { scene: string }
  inheritAgentScene: boolean
  rules: SceneRule[]
}

export type WarningConfig = {
  enabled: boolean
  /** Hold the warning until the question is answered (needs `/v1/alerts/clear`). */
  hold: boolean
  duration: number
  cooldownMs: number
  /** Tool names (globs) and the special name `PermissionRequest`. */
  on: string[]
}

export type FailedConfig = {
  enabled: boolean
  duration: number
  batchMs: number
  tools: string[]
  ignoreInterrupted: boolean
}

export type AlertsConfig = { warning: WarningConfig; failed: FailedConfig }

export type TimingConfig = { settleMs: number; minHoldMs: number; idleDelayMs: number }

export type ServerConfig = {
  baseUrl: string
  sceneRoute: string
  alertsRoute: string
  token: string
  tokenFile: string
}

export type Config = {
  enabled: boolean
  server: ServerConfig
  timing: TimingConfig
  scenes: ScenesConfig
  alerts: AlertsConfig
}

const ANALYSIS = 40
const HANDS_ON = 30
const GENERIC_AGENT = 25
const EXPLORING = 20

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  server: {
    baseUrl: 'http://127.0.0.1:43811',
    sceneRoute: '/v1/wallpaper/scene',
    alertsRoute: '/v1/alerts',
    token: '',
    tokenFile: '~/.local/state/cielinux/http.token',
  },
  timing: { settleMs: 1500, minHoldMs: 4000, idleDelayMs: 8000 },
  scenes: {
    turn: { scene: 'raphael', priority: 5 },
    idle: { scene: 'idle' },
    inheritAgentScene: true,
    rules: [
      {
        kind: 'agent',
        match: ['review-*', 'jd-judge-*', 'sdd-propose', 'sdd-spec', 'sdd-design', 'sdd-tasks', 'sdd-verify', 'Plan'],
        scene: 'raphael',
        priority: ANALYSIS,
      },
      {
        kind: 'agent',
        match: ['jd-fix-agent', 'sdd-apply', 'sdd-archive', 'sdd-init', 'sdd-onboard', 'statusline-setup'],
        scene: 'processing',
        priority: HANDS_ON,
      },
      {
        kind: 'agent',
        match: ['Explore', 'sdd-explore', 'sdd-research', 'claude-code-guide'],
        scene: 'explorer',
        priority: EXPLORING,
      },
      { kind: 'agent', match: ['general-purpose', 'claude', '*'], scene: 'processing', priority: GENERIC_AGENT },
      {
        kind: 'tool',
        match: ['Agent', 'Task', 'AskUserQuestion', 'Skill', 'TodoWrite', 'mcp__*engram*', 'mcp__*mem_*'],
        scene: null,
        priority: 0,
      },
      {
        kind: 'tool',
        match: ['Bash', 'BashOutput', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit', 'PowerShell'],
        scene: 'processing',
        priority: HANDS_ON,
      },
      {
        kind: 'tool',
        match: ['Read', 'Grep', 'Glob', 'LS', 'WebSearch', 'WebFetch', 'ToolSearch', 'mcp__codegraph__*', 'mcp__context7__*'],
        scene: 'explorer',
        priority: EXPLORING,
      },
    ],
  },
  alerts: {
    warning: { enabled: true, hold: false, duration: 5, cooldownMs: 10000, on: ['AskUserQuestion', 'PermissionRequest'] },
    failed: { enabled: true, duration: 8, batchMs: 3000, tools: ['Bash'], ignoreInterrupted: true },
  },
}

/** `*` matches any run of characters (including none); everything else is literal. */
export const globMatch = (pattern: string, name: string): boolean => {
  const escaped = pattern.split('*').map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
  return new RegExp(`^${escaped.join('.*')}$`).test(name)
}

export const matchesAny = (patterns: string | readonly string[], name: string): boolean =>
  (typeof patterns === 'string' ? [patterns] : patterns).some(pattern => globMatch(pattern, name))

/** First matching rule wins; no rule or a null scene means "ignore". */
export const resolveActivity = (
  scenes: ScenesConfig,
  kind: SceneRule['kind'],
  name: string,
): SceneTarget | undefined => {
  const rule = scenes.rules.find(candidate => candidate.kind === kind && matchesAny(candidate.match, name))
  if (rule === undefined || rule.scene === null) return undefined
  return { scene: rule.scene, priority: rule.priority }
}

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)

const isRule = (value: unknown): value is SceneRule => {
  if (!isPlainObject(value)) return false
  const { kind, match, scene, priority } = value
  const isMatch =
    typeof match === 'string' || (Array.isArray(match) && match.every(item => typeof item === 'string'))
  return (
    (kind === 'agent' || kind === 'tool') &&
    isMatch &&
    (scene === null || typeof scene === 'string') &&
    typeof priority === 'number'
  )
}

/**
 * Deep-merges `override` onto `base`, keeping only values whose type matches
 * the base: objects merge, arrays and scalars replace, a mistyped value keeps
 * the base's. `scenes.rules` keeps only well-formed rules.
 */
export const mergeConfig = (base: Config, override: unknown): Config =>
  mergeValue(base, override, 'root') as Config

const mergeValue = (base: unknown, override: unknown, key: string): unknown => {
  if (override === undefined) return base
  if (isPlainObject(base)) {
    if (!isPlainObject(override)) return base
    const merged: Record<string, unknown> = {}
    for (const [name, value] of Object.entries(base)) merged[name] = mergeValue(value, override[name], name)
    return merged
  }
  if (Array.isArray(base)) {
    if (!Array.isArray(override)) return base
    if (key === 'rules') return override.filter(isRule)
    const sample = base[0]
    return sample === undefined ? override : override.filter(item => typeof item === typeof sample)
  }
  if (typeof base === typeof override) return override
  return base
}
