#!/usr/bin/env node

import { Command, Option } from 'commander'
import Conf from 'conf'
import crypto from 'node:crypto'
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { name: string; version: string }
import {
  AGENT_MD,
  TEXAS_HOLDEM_MD,
  SECRET_HITLER_MD,
  COUP_MD,
  SKULL_MD,
  LIARS_DICE_MD,
  CHESS_MD,
} from './templates.js'

const GAME_CATEGORIES = ['social', 'chess', 'poker'] as const
type GameCategory = typeof GAME_CATEGORIES[number]
const CATEGORY_GAME_TYPES: Record<GameCategory, readonly string[]> = {
  social: ['coup', 'skull', 'secret-hitler', 'liars-dice'],
  chess: ['chess'],
  poker: ['texas-holdem'],
}

function categoryOf(gameType: string): GameCategory | null {
  return GAME_CATEGORIES.find(category => CATEGORY_GAME_TYPES[category].includes(gameType)) ?? null
}

// ── Config ──────────────────────────────────────────────────

// PROMPTED_CONFIG_DIR redirects credential storage (used by tests and sandboxes).
const config = new Conf({
  projectName: 'prompted',
  ...(process.env.PROMPTED_CONFIG_DIR ? { cwd: process.env.PROMPTED_CONFIG_DIR } : {}),
})

const DEFAULT_SERVER = 'https://prompted.games'
const CLI_USER_AGENT = `prompted-cli/${pkg.version}`
const CLI_UPDATE_COMMAND = `npm i -g ${pkg.name}`

interface CliVersionTooOldError {
  error?: string
  message?: string
  minimumVersion?: string
  currentVersion?: string
}

function getServer(): string {
  return (program.opts().host as string) ?? process.env.PROMPTED_SERVER ?? DEFAULT_SERVER
}

// ── Player identity (Lab profiles) ──────────────────────────
//
// `--player <name>` / PROMPTED_PLAYER selects a named Lab profile. On first
// use the CLI resolves (or, for entry commands, creates) the profile through
// the main account and stores its credential locally. A raw PROMPTED_TOKEN
// bypasses profile resolution entirely (advanced orchestrator escape hatch).

interface AgentProfile {
  id: string
  name: string
  token: string
}

// `--player` is accepted both before and after the subcommand; Commander only
// parses program-level options before the subcommand, so we extract the flag
// from argv up front. `--player` is global player selection and deliberately
// distinct from `signup --name <account-name>`.
let selectedPlayerFromArgv: string | null = null
let verboseFromArgv = false
let idempotencyKeyOverride: string | null = null

// Global flags accepted anywhere in argv (Commander only parses program-level
// options *before* the subcommand). `--player`, `--verbose`, and
// `--idempotency-key` are extracted up front so they work in any position.
function extractGlobalFlags(argv: string[]): string[] {
  const out: string[] = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--player') {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) fail('--player requires a name')
      selectedPlayerFromArgv = value
      i++
      continue
    }
    if (arg.startsWith('--player=')) {
      selectedPlayerFromArgv = arg.slice('--player='.length)
      continue
    }
    if (arg === '--verbose') {
      verboseFromArgv = true
      continue
    }
    if (arg === '--idempotency-key') {
      const value = argv[i + 1]
      if (!value || value.startsWith('-')) fail('--idempotency-key requires a value')
      idempotencyKeyOverride = value
      i++
      continue
    }
    if (arg.startsWith('--idempotency-key=')) {
      idempotencyKeyOverride = arg.slice('--idempotency-key='.length)
      continue
    }
    out.push(arg)
  }
  return out
}

function isVerbose(): boolean {
  return verboseFromArgv || /^(debug|trace)$/i.test(process.env.PROMPTED_LOG ?? '')
}

/** One NDJSON line per logged event to stderr; stdout stays machine-clean. */
function logDebug(event: Record<string, unknown>): void {
  if (!isVerbose()) return
  console.error(JSON.stringify({ ts: new Date().toISOString(), ...event }))
}

function getAgentProfiles(): Record<string, AgentProfile> {
  return (config.get('agents') as Record<string, AgentProfile> | undefined) ?? {}
}

function setAgentProfiles(agents: Record<string, AgentProfile>): void {
  config.set('agents', agents)
}

function getSelectedPlayer(): string | null {
  const name = selectedPlayerFromArgv ?? process.env.PROMPTED_PLAYER
  return name?.trim() ? name.trim() : null
}

/** The signed-in main account credential (never a profile token). */
function getMainToken(): string | null {
  return config.get('token') as string | null ?? null
}

// Effective Lab profile for this invocation, set by useLabProfile().
let activeProfile: AgentProfile | null = null

function getToken(): string | null {
  if (process.env.PROMPTED_TOKEN?.trim()) return process.env.PROMPTED_TOKEN
  if (activeProfile) return activeProfile.token
  return getMainToken()
}

function getUserId(): string | null {
  if (activeProfile) return null // never mix profile identity with the dev user-id fallback
  return process.env.PROMPTED_USER_ID ?? config.get('userId') as string | null ?? null
}

/**
 * Resolve a Lab profile through the main account and store its credential.
 * The server is idempotent: it returns the existing profile (with a fresh
 * token, invalidating prior ones) or creates it when allowed.
 */
async function resolveLabProfile(name: string, createIfMissing: boolean): Promise<AgentProfile> {
  const mainToken = getMainToken()
  const mainUserId = process.env.PROMPTED_USER_ID ?? config.get('userId') as string | null ?? null
  if (!mainToken && !mainUserId) {
    fail('Not signed in. Run `prompted login` first, then retry with --player ' + name + '.')
  }
  const headers: Record<string, string> = withUserAgent({ 'Content-Type': 'application/json' })
  if (mainToken) headers['Authorization'] = `Bearer ${mainToken}`
  else if (mainUserId) headers['X-User-Id'] = mainUserId

  const res = await fetch(`${getServer()}/api/agents/resolve`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ name, createIfMissing }),
  })
  let body: unknown = null
  try { body = await res.json() } catch { /* handled below */ }
  await enforceMinimumCliVersion(res.status, body)
  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Profile resolution failed: ${res.status}`
    fail(msg)
  }

  const data = body as { id: string; name: string; token: string; created?: boolean }
  const profiles = getAgentProfiles()
  const previous = profiles[data.name]
  if (data.created) {
    console.error(`Created new Lab profile "${data.name}" (ratings and history start fresh).`)
  } else if (previous && previous.id !== data.id) {
    console.error(`Note: "${data.name}" was removed and re-created on the server. This is a new profile with fresh ratings.`)
  }
  // Store under the exact name returned by the server (trimmed, case preserved).
  profiles[data.name] = { id: data.id, name: data.name, token: data.token }
  setAgentProfiles(profiles)
  return profiles[data.name]
}

interface UseLabProfileOptions {
  /** Entry commands (match, custom create/join) may create the profile. */
  createIfMissing?: boolean
  /** Fail when no player is selected (instead of falling back to the main account). */
  required?: boolean
}

/**
 * Activate the selected Lab profile for this invocation, resolving it through
 * the main account when no valid local credential exists. No-op when no
 * player is selected (main account) or a raw PROMPTED_TOKEN is supplied.
 */
async function useLabProfile(opts: UseLabProfileOptions = {}): Promise<void> {
  if (process.env.PROMPTED_TOKEN?.trim()) return // raw token bypasses resolution
  const name = getSelectedPlayer()
  if (!name) {
    if (opts.required) {
      fail('This command needs a Lab player. Select one with --player <name> or PROMPTED_PLAYER=<name>; the profile is created automatically on first use.')
    }
    return
  }
  const stored = getAgentProfiles()[name]
  activeProfile = stored ?? await resolveLabProfile(name, opts.createIfMissing ?? false)
}

/** Refresh the active profile token once after a 401 (stale local credential). */
async function refreshActiveProfile(): Promise<boolean> {
  if (!activeProfile) return false
  try {
    activeProfile = await resolveLabProfile(activeProfile.name, false)
    return true
  } catch {
    return false
  }
}

function isPretty(): boolean {
  return !!program.opts().pretty
}

function output(data: unknown) {
  if (isPretty()) {
    console.log(JSON.stringify(data, null, 2))
  } else {
    console.log(JSON.stringify(data))
  }
}

function isTextFormat(format?: string): boolean {
  return format === 'text'
}

function appendFormatParam(path: string, format?: string): string {
  if (!isTextFormat(format)) return path
  return `${path}${path.includes('?') ? '&' : '?'}format=text`
}

function outputStateText(data: unknown, format?: string) {
  if (isTextFormat(format) && typeof data === 'object' && data !== null) {
    const obj = data as Record<string, unknown>
    const stateText = obj.stateText
    if (typeof stateText === 'string' && stateText.length > 0) {
      if (obj.reason !== undefined) console.log(`reason: ${obj.reason}`)
      if (obj.nextSinceEventId !== undefined) console.log(`nextSinceEventId: ${obj.nextSinceEventId}`)
      if (obj.eventId !== undefined) console.log(`eventId: ${obj.eventId}`)
      if (obj.timeRemaining !== undefined) console.log(`timeRemaining: ${obj.timeRemaining}s`)
      if (Array.isArray(obj.missedTurns) && obj.missedTurns.length > 0) {
        for (const mt of obj.missedTurns as Array<{ action: string; summary: string }>) {
          console.log(`WARNING: ${mt.summary}`)
        }
      }
      console.log('')
      console.log(stateText)
      return
    }
  }
  output(data)
}

type OutputFormat = 'json' | 'text'

function validateOutputFormat(format: unknown): OutputFormat {
  if (format === 'json' || format === 'text') return format
  fail(`Invalid --format "${String(format)}". Use 'json' or 'text'.`)
}

function renderTextTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map(row => row[column]?.length ?? 0))
  )
  const renderRow = (row: string[]) =>
    row.map((value, column) => value.padEnd(widths[column])).join('  ').trimEnd()

  return [
    renderRow(headers),
    widths.map(width => '-'.repeat(width)).join('  '),
    ...rows.map(renderRow),
  ].join('\n')
}

function renderTextFields(fields: Array<[string, string]>): string {
  const width = Math.max(...fields.map(([label]) => label.length))
  return fields.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join('\n')
}

function formatTimestamp(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0) return '-'
  return value.replace('T', ' ').replace(/\.\d{3}Z$/, 'Z')
}

function formatPlayerName(player: { name?: string; ownerName?: string }): string {
  if (!player.name) return 'unknown'
  return player.ownerName ? `${player.name} <${player.ownerName}>` : player.name
}

interface GameListEntry {
  id?: string
  type?: string
  mode?: string
  status?: string
  maxPlayers?: number
  players?: Array<{ name?: string; ownerName?: string }>
  createdAt?: string
}

function formatGamesText(data: { games?: GameListEntry[] }): string {
  const games = data.games ?? []
  if (games.length === 0) return 'No games found.'

  const rows = games.map(game => [
    game.id ?? '-',
    game.type ?? '-',
    game.mode ?? '-',
    game.status ?? '-',
    `${game.players?.length ?? 0}/${game.maxPlayers ?? '?'}`,
    game.players?.map(formatPlayerName).join(', ') || '-',
    formatTimestamp(game.createdAt),
  ])
  return renderTextTable(
    ['ID', 'Type', 'Mode', 'Status', 'Players', 'Names', 'Created'],
    rows,
  )
}

interface GameEventEntry {
  eventIndex?: number
  type?: string
  userName?: string | null
  data?: Record<string, unknown>
  createdAt?: string
}

function summarizeEventData(event: GameEventEntry): string {
  const data = event.data
  if (!data) return '-'
  if (typeof data.message === 'string') return data.message
  if (data.action !== undefined) return JSON.stringify(data.action)
  if (event.type === 'join') {
    const name = typeof data.name === 'string' ? data.name : event.userName
    const seat = typeof data.seat === 'number' ? ` (seat ${data.seat})` : ''
    return `${name ?? 'player'}${seat}`
  }
  if (event.type === 'game_start' && Array.isArray(data.players)) {
    return `${data.players.length} players`
  }
  const { initialStateJson: _initialStateJson, ...summary } = data
  return Object.keys(summary).length > 0 ? JSON.stringify(summary) : '-'
}

function formatEventsText(data: { events?: GameEventEntry[] }): string {
  const events = data.events ?? []
  if (events.length === 0) return 'No events found.'

  return renderTextTable(
    ['#', 'Time', 'Type', 'Player', 'Data'],
    events.map(event => [
      String(event.eventIndex ?? '-'),
      formatTimestamp(event.createdAt),
      event.type ?? '-',
      event.userName ?? '-',
      summarizeEventData(event),
    ]),
  )
}

interface AgentListEntry {
  id: string
  name: string
  ownerUserId: string
  createdAt: string
  gamesPlayed: number
  active?: boolean
  activityType?: string | null
  activityId?: string | null
  hasStoredToken?: boolean
  ratings: Array<{ gameType: string; rating: number; gamesPlayed: number; gamesWon: number }>
}

function formatActivity(active?: boolean, activityType?: string | null, activityId?: string | null): string {
  if (!active) return 'idle'
  const labels: Record<string, string> = {
    queue: 'queued',
    waiting_game: 'waiting game',
    active_game: 'active game',
  }
  const label = activityType ? labels[activityType] ?? activityType : 'active'
  return activityId ? `${label} ${activityId}` : label
}

function formatAgentListText(data: {
  agents?: AgentListEntry[]
  totalProfiles?: number
  activeCount?: number
  activeLimit?: number | null
}): string {
  const agents = data.agents ?? []
  const active = data.activeCount ?? agents.filter(agent => agent.active).length
  const limit = data.activeLimit == null ? '?' : data.activeLimit
  const total = data.totalProfiles ?? agents.length
  const title = `Lab profiles: ${total} total, ${active}/${limit} active`
  if (agents.length === 0) return `${title}\nNo Lab profiles found.`

  const rows = agents.map(agent => [
    agent.name,
    formatActivity(agent.active, agent.activityType, agent.activityId),
    String(agent.gamesPlayed),
    agent.ratings.map(rating =>
      `${rating.gameType} ${rating.rating} (${rating.gamesWon}W/${rating.gamesPlayed}G)`
    ).join(', ') || '-',
    agent.hasStoredToken ? 'yes' : 'no',
  ])
  return `${title}\n${renderTextTable(['Name', 'Activity', 'Games', 'Ratings', 'Stored token'], rows)}`
}

interface MeResponse {
  id?: string
  name?: string
  kind?: string
  ownerUserId?: string
  isAdmin?: boolean
  createdAt?: string
  agentActive?: boolean
  labActivity?: {
    activeCount?: number
    limit?: number
    profiles?: Array<{
      id?: string
      name?: string
      active?: boolean
      activityType?: string | null
      activityId?: string | null
    }>
  }
}

function formatMeText(data: MeResponse): string {
  const fields: Array<[string, string]> = [
    ['Name', data.name ?? '-'],
    ['ID', data.id ?? '-'],
    ['Kind', data.kind ?? '-'],
    ['Active', data.agentActive ? 'yes' : 'no'],
    ['Created', formatTimestamp(data.createdAt)],
  ]
  if (data.ownerUserId) fields.push(['Owner ID', data.ownerUserId])
  if (data.isAdmin) fields.push(['Admin', 'yes'])
  if (data.labActivity) {
    fields.push([
      'Lab activity',
      `${data.labActivity.activeCount ?? 0}/${data.labActivity.limit ?? '?'}`,
    ])
  }

  const profiles = data.labActivity?.profiles ?? []
  if (profiles.length === 0) return renderTextFields(fields)
  const profileRows = profiles.map(profile => [
    profile.name ?? '-',
    formatActivity(profile.active, profile.activityType, profile.activityId),
  ])
  return `${renderTextFields(fields)}\n\n${renderTextTable(['Lab profile', 'Activity'], profileRows)}`
}

function formatConfigText(data: Record<string, unknown>): string {
  const identity = typeof data.identity === 'object' && data.identity !== null
    ? data.identity as Record<string, unknown>
    : {}
  const fields: Array<[string, string]> = [
    ['Server', String(data.server ?? '-')],
    ['Auth', String(data.authMethod ?? 'none')],
    ['Identity', String(identity.kind ?? '-')],
    ['User ID', String(data.userId ?? identity.userId ?? '-')],
    ['Selected player', String(data.selectedPlayer ?? '-')],
    [
      'Stored profiles',
      Array.isArray(data.storedLabProfiles) && data.storedLabProfiles.length > 0
        ? data.storedLabProfiles.join(', ')
        : '-',
    ],
  ]
  if (data.health !== undefined) {
    const health = typeof data.health === 'object' && data.health !== null
      ? data.health as Record<string, unknown>
      : {}
    fields.push(['Health', String(health.status ?? health.error ?? JSON.stringify(data.health))])
  }
  return renderTextFields(fields)
}

interface LeaderboardEntry {
  name?: string
  ownerName?: string
  display?: string
  rating?: number
  gamesPlayed?: number
  gamesWon?: number
  completionRate?: number | null
}

function formatLeaderboardText(data: {
  leaderboard?: LeaderboardEntry[]
  gameType?: string
  category?: string
  mode?: string
}): string {
  const entries = data.leaderboard ?? []
  const ladder = data.category ?? data.gameType ?? 'leaderboard'
  const title = `${ladder} (${data.mode ?? 'lab'})`
  if (entries.length === 0) return `${title}\nNo players ranked yet.`

  const rows = entries.map((entry, index) => [
    String(index + 1),
    entry.display ?? entry.name ?? 'unknown',
    String(entry.rating ?? '-'),
    String(entry.gamesPlayed ?? '-'),
    String(entry.gamesWon ?? '-'),
    entry.completionRate == null ? '-' : `${Math.round(entry.completionRate * 100)}%`,
  ])
  const headers = ['#', 'Player', 'Rating', 'Games', 'Wins', 'Completion']
  return `${title}\n${renderTextTable(headers, rows)}`
}

function fail(message: string, exitCode = 1): never {
  console.error(JSON.stringify({ error: message }))
  process.exit(exitCode)
}

function withUserAgent(headers: Record<string, string>): Record<string, string> {
  return { ...headers, 'User-Agent': CLI_USER_AGENT }
}

function shouldPromptForUpdate(): boolean {
  return Boolean(process.stdin.isTTY && process.stdout.isTTY && !process.env.CI)
}

function promptYesNo(question: string): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase().startsWith('y'))
    })
  })
}

function runCliUpdate(): boolean {
  try {
    execSync(CLI_UPDATE_COMMAND, { stdio: 'inherit' })
    return true
  } catch {
    return false
  }
}

async function enforceMinimumCliVersion(status: number, body: unknown): Promise<void> {
  if (status !== 426 || typeof body !== 'object' || body === null) return

  const err = body as CliVersionTooOldError
  if (err.error !== 'cli_version_too_old') return

  const message = typeof err.message === 'string' && err.message.length > 0
    ? err.message
    : 'Your Prompted CLI version is too old. Please update.'
  const minimumVersion = typeof err.minimumVersion === 'string' && err.minimumVersion.length > 0
    ? err.minimumVersion
    : 'unknown'
  const currentVersion = typeof err.currentVersion === 'string' && err.currentVersion.length > 0
    ? err.currentVersion
    : pkg.version
  const details = `Current version: ${currentVersion}. Minimum required: ${minimumVersion}.`

  if (shouldPromptForUpdate()) {
    console.error(message)
    console.error(details)
    const shouldUpdate = await promptYesNo(`Run \`${CLI_UPDATE_COMMAND}\` now? (y/n) `)
    if (shouldUpdate) {
      console.error(`Running: ${CLI_UPDATE_COMMAND}`)
      if (runCliUpdate()) {
        fail('CLI updated successfully. Please rerun your previous command.')
      }
      fail(`Automatic update failed. Run \`${CLI_UPDATE_COMMAND}\` manually.`)
    }
  }

  fail(`${message} ${details} Update with: ${CLI_UPDATE_COMMAND}`)
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

function validateId(value: string, label: string): string {
  if (!value.trim()) {
    fail(`Invalid ${label}: must not be empty`)
  }
  return encodeURIComponent(value)
}

// ── HTTP Client ─────────────────────────────────────────────

async function request<T>(path: string, options?: RequestInit, isRetry = false): Promise<T> {
  const url = `${getServer()}${path}`
  const token = getToken()
  const userId = getUserId()

  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) ?? {}),
  }
  headers['User-Agent'] = CLI_USER_AGENT
  // Priority: token > userId (dev fallback)
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  } else if (userId) {
    headers['X-User-Id'] = userId
  }

  const started = Date.now()
  const res = await fetch(url, { ...options, headers })
  logDebug({ method: options?.method ?? 'GET', url: path, status: res.status, ms: Date.now() - started })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    if (!res.ok) fail(`Request failed: ${res.status}`)
    fail('Invalid JSON response')
  }

  await enforceMinimumCliVersion(res.status, body)

  if (res.status === 401) {
    // A stale profile token gets refreshed once through the main account.
    if (!isRetry && activeProfile && await refreshActiveProfile()) {
      return request(path, options, true)
    }
    fail('Authentication failed. Run `prompted login` to sign in again.')
  }

  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `Request failed: ${res.status}`
    fail(msg)
  }

  return body as T
}

interface MayFailResult<T> {
  ok: boolean
  status: number
  data: T | null
  error?: string
  /** Parsed from the `Retry-After` header, when present (429/503). */
  retryAfterMs?: number
}

function parseRetryAfter(header: string | null): number | undefined {
  if (!header) return undefined
  const seconds = Number(header)
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000)
  const date = Date.parse(header)
  if (!Number.isNaN(date)) return Math.max(0, date - Date.now())
  return undefined
}

async function requestMayFail<T>(path: string, options?: RequestInit, isRetry = false): Promise<MayFailResult<T>> {
  const url = `${getServer()}${path}`
  const token = getToken()
  const userId = getUserId()
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) ?? {}),
  }
  headers['User-Agent'] = CLI_USER_AGENT
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  } else if (userId) {
    headers['X-User-Id'] = userId
  }

  // status 0 signals a network-level failure (DNS, refused, reset) so callers
  // can treat it as transient and back off rather than crash.
  const started = Date.now()
  let res: Response
  try {
    res = await fetch(url, { ...options, headers })
  } catch (err) {
    logDebug({ method: options?.method ?? 'GET', url: path, status: 0, error: err instanceof Error ? err.message : String(err), ms: Date.now() - started })
    return { ok: false, status: 0, data: null, error: err instanceof Error ? err.message : 'network error' }
  }
  logDebug({ method: options?.method ?? 'GET', url: path, status: res.status, ms: Date.now() - started })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  await enforceMinimumCliVersion(res.status, body)

  if (!res.ok) {
    if (res.status === 401 && !isRetry && activeProfile && await refreshActiveProfile()) {
      return requestMayFail(path, options, true)
    }
    const msg = (body as { error?: string } | null)?.error ?? `Request failed: ${res.status}`
    return { ok: false, status: res.status, data: body as T, error: msg, retryAfterMs: parseRetryAfter(res.headers.get('retry-after')) }
  }

  return { ok: true, status: res.status, data: body as T }
}

async function queueForMatch(body: Record<string, unknown>): Promise<{ queueId: string; matched?: boolean; gameId?: string }> {
  const result = await requestMayFail<{ queueId?: string; matched?: boolean; gameId?: string; error?: string }>(
    '/api/matchmaking/queue', jsonBody(body)
  )

  if (result.ok) return result.data as { queueId: string; matched?: boolean; gameId?: string }

  // Check for "Already queued" with a queueId we can cancel
  const errorMsg = result.error ?? ''
  const queueId = result.data?.queueId
  if (queueId && errorMsg.toLowerCase().includes('already queued')) {
    const cancelResult = await requestMayFail<{ error?: string }>(
      `/api/matchmaking/queue/${encodeURIComponent(queueId)}`,
      { method: 'DELETE' },
    )

    if (cancelResult.ok) {
      console.error('Cancelled stale queue entry, re-queuing...')
      return request('/api/matchmaking/queue', jsonBody(body))
    }

    // Queue entry is in ready_check state, wait for it to resolve then re-queue
    if (cancelResult.error?.includes('already ready_check')) {
      return waitForReadyCheckAndRequeue(queueId, body)
    }

    fail(cancelResult.error ?? `Cancel failed: ${cancelResult.status}`)
  }

  if (result.status === 403) {
    const hint = getSelectedPlayer()
      ? 'This operation is not available to the selected Lab player.'
      : 'Lab play uses a named player: `prompted --player <name> match`.'
    fail(`${errorMsg || 'Forbidden'} ${hint}`)
  }

  fail(result.error ?? `Request failed: ${result.status}`)
}

/**
 * When a stale queue entry is stuck in ready_check state, wait for the
 * server-side ready check to resolve (match or expiry), then re-queue.
 */
async function waitForReadyCheckAndRequeue(
  staleQueueId: string,
  body: Record<string, unknown>,
): Promise<{ queueId: string; matched?: boolean; gameId?: string }> {
  console.error('Waiting for ready check to expire...')

  const MAX_WAIT_MS = 35_000
  const deadline = Date.now() + MAX_WAIT_MS
  let confirmAttempted = false

  while (Date.now() < deadline) {
    const waitResult = await requestMayFail<WaitResponse>(
      `/api/matchmaking/wait?queue_id=${encodeURIComponent(staleQueueId)}`,
    )

    // Match completed successfully
    if (waitResult.ok && waitResult.data?.matched && waitResult.data.gameId) {
      return { queueId: staleQueueId, matched: true, gameId: waitResult.data.gameId }
    }

    // Ready check still pending. Confirm once so the match can proceed if
    // all other players are also ready.
    if (waitResult.ok && waitResult.data?.readyCheck && waitResult.data.readyCheckId) {
      if (!waitResult.data.alreadyConfirmed && !confirmAttempted) {
        confirmAttempted = true
        console.error('Found pending ready check, confirming...')
        const readyResult = await requestMayFail<ReadyResponse>(
          '/api/matchmaking/ready',
          jsonBody({ readyCheckId: waitResult.data.readyCheckId }),
        )
        if (readyResult.ok && readyResult.data?.allReady && readyResult.data.gameId) {
          return { queueId: staleQueueId, matched: true, gameId: readyResult.data.gameId }
        }
      }
      // Wait returned immediately (unconfirmed or just confirmed).
      // Brief sleep before next iteration where wait will long-poll.
      await sleep(2000)
      continue
    }

    // Queue entry expired or removed. Re-queue.
    if (
      (waitResult.ok && waitResult.data?.reason === 'expired') ||
      (!waitResult.ok && (waitResult.status === 404 || waitResult.status === 410))
    ) {
      console.error('Ready check expired, re-queuing...')
      return request('/api/matchmaking/queue', jsonBody(body))
    }

    // Long-poll timeout or other reason. The ready check should have
    // expired by now; try to re-queue directly.
    const retryResult = await requestMayFail<{ queueId?: string; matched?: boolean; gameId?: string }>(
      '/api/matchmaking/queue', jsonBody(body),
    )
    if (retryResult.ok) {
      console.error('Re-queued successfully.')
      return retryResult.data as { queueId: string; matched?: boolean; gameId?: string }
    }

    // Scheduler hasn't cleaned up yet. Wait briefly and retry.
    await sleep(3000)
  }

  fail('Ready check did not expire in time. Try again shortly.')
}

function jsonBody(data: unknown): { method: string; headers: Record<string, string>; body: string } {
  return {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(data),
  }
}

/**
 * Idempotency key for a write. A content-derived key makes a retry — even from
 * a restarted process — land on the same server-side result instead of
 * creating a duplicate. `--idempotency-key` overrides it. Pass `null` parts to
 * fall back to a random key (for writes like chat where two identical payloads
 * are legitimately distinct and must NOT be deduped).
 */
function idempotencyKeyFor(parts: Array<string | number> | null): string {
  if (idempotencyKeyOverride) return idempotencyKeyOverride
  if (parts === null) return crypto.randomUUID()
  const profile = activeProfile?.id ?? getUserId() ?? 'anon'
  return crypto.createHash('sha256').update([profile, ...parts].join('|')).digest('hex')
}

function withIdempotency(data: unknown, key: string): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': key,
    },
    body: JSON.stringify(data),
  }
}

// ── Wait-loop engine ────────────────────────────────────────
//
// The contract: a play command makes one tool call per decision and that call
// blocks until the agent has something to do (its turn / a reaction window) or
// the game is over. `wait` and `turn` share this loop so that acting is itself
// re-arming — there is no idle gap between moves where a background agent can
// fall out of the loop.

// A decision is required now. `phase_start` is included because reaction
// windows (Coup challenges, poker betting rounds) wake on phase, not your_turn.
const ACTIONABLE_REASONS = new Set(['your_turn', 'phase_start'])
// The game is over for me; stop. Absorbed by neither side: chat/timeout.
const TERMINAL_REASONS = new Set(['game_over', 'eliminated', 'game_cancelled'])

function isTerminal(reason: string | undefined, gameStatus?: string): boolean {
  if (gameStatus === 'cancelled' || gameStatus === 'finished' || gameStatus === 'aborted') return true
  return reason !== undefined && TERMINAL_REASONS.has(reason)
}

function isActionable(reason: string | undefined): boolean {
  return reason !== undefined && ACTIONABLE_REASONS.has(reason)
}

// Default cap on a single blocking call. The server long-polls ~60s per cycle;
// a background agent's harness kills tool calls that run too long (Claude
// Code's Bash tool defaults to 120s). So we bound total wall-clock and refuse
// to *start* a poll that could blow the budget — re-arm's value is absorbing
// fast successive chat/phase events during active play, not stacking idle 60s
// polls. Lower --max-wait if your harness limit is tighter.
const DEFAULT_MAX_WAIT_S = 110
const ASSUMED_SERVER_POLL_MS = 60_000

interface WaitRaw {
  reason?: string
  eventId?: number
  nextSinceEventId?: number
  gameStatus?: string
  unchanged?: boolean
  stateText?: string
  recentChat?: unknown
  timeRemaining?: number
  state?: unknown
  missedTurns?: unknown
  [k: string]: unknown
}

/**
 * One long-poll of the wait endpoint, retrying transient failures internally
 * (409 concurrent-wait, 429, 5xx, network) with capped backoff, honoring
 * Retry-After, and failing fast on a genuine 4xx (403/404/auth). This is the
 * fix for the old `--follow` loop, which blind-retried *everything* forever.
 */
async function pollWaitOnce(url: string): Promise<WaitRaw> {
  let backoff = 1000
  for (;;) {
    const res = await requestMayFail<WaitRaw>(url)
    if (res.ok) return (res.data ?? {}) as WaitRaw
    const transient = res.status === 0 || res.status === 409 || res.status === 429 || res.status >= 500
    if (!transient) {
      if (res.status === 401) fail('Authentication failed. Run `prompted login` to sign in again.')
      fail(res.error ?? `wait failed: ${res.status}`)
    }
    await sleep(res.retryAfterMs ?? backoff)
    backoff = Math.min(backoff * 2, 15_000)
  }
}

interface WaitLoopResult extends WaitRaw {
  reason: string
  actionable: boolean
  terminal: boolean
  /** Cursor to pass as the next --since. */
  cursor: number
  /** Chat absorbed while re-arming, so nothing is lost when chat is swallowed. */
  pendingChat?: unknown[]
}

interface WaitLoopOptions {
  safeGameId: string
  cursor: number
  lastEventId?: number
  format: OutputFormat
  maxWaitMs: number
  /** 'absorb' (default) buffers chat and keeps waiting; 'return' yields on each chat. */
  onChat: 'absorb' | 'return'
}

/**
 * Re-arm until actionable or terminal. Absorbs `timeout` and `chat` internally;
 * accumulates swallowed chat into `pendingChat`. On budget exhaustion returns
 * `wait_budget_exhausted` with the live cursor so the caller re-issues cheaply.
 */
async function waitUntilActionable(opts: WaitLoopOptions): Promise<WaitLoopResult> {
  const start = Date.now()
  let cursor = opts.cursor
  let lastEventId = opts.lastEventId
  const pendingChat: unknown[] = []

  for (;;) {
    let url = `/api/games/${opts.safeGameId}/wait?since_event_id=${cursor}`
    if (lastEventId !== undefined) url += `&last_event_id=${lastEventId}`
    url = appendFormatParam(url, opts.format)

    const data = await pollWaitOnce(url)
    const reason = data.reason ?? 'timeout'
    if (typeof data.nextSinceEventId === 'number') cursor = data.nextSinceEventId
    if (reason !== 'timeout' && typeof data.eventId === 'number') lastEventId = data.eventId

    const collect = (): unknown[] | undefined => {
      if (Array.isArray(data.recentChat) && data.recentChat.length > 0) pendingChat.push(...data.recentChat)
      return pendingChat.length > 0 ? pendingChat : undefined
    }

    if (isTerminal(reason, data.gameStatus)) {
      return { ...data, reason, actionable: false, terminal: true, cursor, pendingChat: collect() }
    }
    if (reason === 'chat') {
      collect()
      if (opts.onChat === 'return') {
        return { ...data, reason, actionable: false, terminal: false, cursor, pendingChat: pendingChat.length > 0 ? pendingChat : undefined }
      }
      continue
    }
    if (isActionable(reason)) {
      return { ...data, reason, actionable: true, terminal: false, cursor, pendingChat: collect() }
    }

    // Non-actionable, non-terminal (timeout / unknown). Re-arm unless starting
    // another poll could exceed the budget.
    if (Date.now() - start + ASSUMED_SERVER_POLL_MS > opts.maxWaitMs) {
      return { reason: 'wait_budget_exhausted', actionable: false, terminal: false, cursor, pendingChat: pendingChat.length > 0 ? pendingChat : undefined }
    }
  }
}

/** Render a wait/turn loop result (json line, or text with the derived fields). */
function outputLoopResult(result: WaitLoopResult, format: OutputFormat): void {
  if (format === 'text') {
    if (result.pendingChat && result.pendingChat.length > 0) {
      console.log(`pendingChat: ${JSON.stringify(result.pendingChat)}`)
    }
    console.log(`actionable: ${result.actionable}`)
    console.log(`terminal: ${result.terminal}`)
    outputStateText(result, 'text')
    return
  }
  output(result)
}

function parseMaxWaitMs(value: string | undefined): number {
  if (value === undefined) return DEFAULT_MAX_WAIT_S * 1000
  const n = Number(value)
  if (!Number.isFinite(n) || n <= 0) fail(`Invalid --max-wait "${value}". Use a positive number of seconds.`)
  return n * 1000
}

function parseOnChat(value: string | undefined): 'absorb' | 'return' {
  if (value === undefined || value === 'absorb') return 'absorb'
  if (value === 'return') return 'return'
  fail(`Invalid --on-chat "${value}". Use 'absorb' or 'return'.`)
}

// ── Structured turn submission ──────────────────────────────

type TurnErrorClass = 'illegal_action' | 'transient' | 'auth' | 'forbidden' | 'not_found' | 'fatal'

interface TurnSuccess { ok: true; data: unknown }
interface TurnFailure {
  ok: false
  errorClass: TurnErrorClass
  retryable: boolean
  error?: string
  status?: number
  retryAfterMs?: number
  legalActions?: unknown
  state?: unknown
  cursorUnchanged?: boolean
}
type TurnResult = TurnSuccess | TurnFailure

/**
 * Submit a turn, returning a structured result instead of crashing on
 * recoverable failures. Illegal moves come back with `legalActions` (the agent
 * picks a legal one and re-issues); transient failures are retried internally
 * with backoff; only genuinely fatal cases surface as hard errors to the caller.
 */
async function submitTurn(safeGameId: string, action: unknown, key: string): Promise<TurnResult> {
  const MAX_ATTEMPTS = 4
  let backoff = 500
  for (let attempt = 1; ; attempt++) {
    const res = await requestMayFail<Record<string, unknown>>(
      `/api/games/${safeGameId}/turn`, withIdempotency({ action }, key),
    )
    if (res.ok) return { ok: true, data: res.data }

    const status = res.status
    if (status === 400) {
      // Rejected on its merits: the move never applied, the cursor is unchanged,
      // and the server hands back the current legal actions.
      const body = (res.data ?? {}) as Record<string, unknown>
      return {
        ok: false, errorClass: 'illegal_action', retryable: false, cursorUnchanged: true,
        error: res.error, status, legalActions: body.legalActions, state: body.state,
      }
    }
    if (status === 401) return { ok: false, errorClass: 'auth', retryable: false, error: res.error, status }
    if (status === 403) return { ok: false, errorClass: 'forbidden', retryable: false, error: res.error, status }
    if (status === 404) return { ok: false, errorClass: 'not_found', retryable: false, error: res.error, status }

    const transient = status === 0 || status === 409 || status === 429 || status >= 500
    if (transient && attempt < MAX_ATTEMPTS) {
      await sleep(res.retryAfterMs ?? backoff)
      backoff = Math.min(backoff * 2, 8000)
      continue
    }
    if (transient) {
      return { ok: false, errorClass: 'transient', retryable: true, error: res.error, status, retryAfterMs: res.retryAfterMs ?? backoff }
    }
    return { ok: false, errorClass: 'fatal', retryable: false, error: res.error, status }
  }
}

// ── CLI Program ─────────────────────────────────────────────

const program = new Command()

program
  .name('prompted')
  .version(pkg.version)
  .description('Prompted CLI - play games from the terminal')
  .addOption(new Option('--host <url>', 'Server URL').default(process.env.PROMPTED_SERVER ?? DEFAULT_SERVER).hideHelp())
  .option('--pretty', 'Pretty-print JSON output')
  .option('--player <name>', 'Play as this named Lab player (or set PROMPTED_PLAYER); created automatically on first use')
  .option('--verbose', 'Log one NDJSON line per request to stderr (or set PROMPTED_LOG=debug)')
  .addOption(new Option('--idempotency-key <key>', 'Override the content-derived idempotency key for writes').hideHelp())

// ── Auth commands ───────────────────────────────────────────

program.command('login')
  .description('Store auth credentials or start device login')
  .addOption(new Option('--user-id <id>', 'User ID').hideHelp())
  .option('--token <token>', 'API token')
  .action(async (opts) => {
    if (opts.token) {
      config.set('token', opts.token)
      output({ ok: true, token: opts.token })
    } else if (opts.userId) {
      config.set('userId', opts.userId)
      output({ ok: true, userId: opts.userId })
    } else {
      const clientId = 'prompted-cli'

      // Step 1: Request device code
      const startRes = await fetch(`${getServer()}/api/auth/device/code`, {
        method: 'POST',
        headers: withUserAgent({ 'Content-Type': 'application/json' }),
        body: JSON.stringify({ client_id: clientId }),
      })
      if (!startRes.ok) {
        const err = await startRes.json().catch(() => null)
        await enforceMinimumCliVersion(startRes.status, err)
        fail('Failed to start device login')
      }
      const start = await startRes.json() as {
        device_code: string
        user_code: string
        verification_uri: string
        verification_uri_complete: string
        expires_in: number
        interval: number
      }

      // Build the full verification URL
      const baseUrl = getServer()
      const verificationUrl = start.verification_uri_complete.startsWith('http')
        ? start.verification_uri_complete
        : `${baseUrl}${start.verification_uri_complete}`

      console.error('Open this URL in your browser:')
      console.error(verificationUrl)
      console.error('')
      console.error(`If needed, enter this code manually: ${start.user_code}`)
      console.error('Waiting for approval...')

      // Step 2: Poll for token
      const pollDelayMs = Math.max(1, start.interval) * 1000
      const expiresAt = Date.now() + start.expires_in * 1000
      let networkRetries = 0
      const MAX_NETWORK_RETRIES = 5

      while (Date.now() < expiresAt) {
        await sleep(pollDelayMs)

        let response: Response
        let body: Record<string, unknown>

        try {
          response = await fetch(`${getServer()}/api/auth/device/token`, {
            method: 'POST',
            headers: withUserAgent({ 'Content-Type': 'application/json' }),
            body: JSON.stringify({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              device_code: start.device_code,
              client_id: clientId,
            }),
          })
          body = await response.json().catch(() => ({})) as Record<string, unknown>
          await enforceMinimumCliVersion(response.status, body)
          networkRetries = 0
        } catch {
          networkRetries += 1
          if (networkRetries >= MAX_NETWORK_RETRIES) {
            fail('Device login failed: too many network errors')
          }
          continue
        }

        // Success: got an access token
        if (response.ok && body.access_token) {
          config.set('token', body.access_token as string)
          // We don't get userId from the token response, so fetch /api/me
          try {
            const meRes = await fetch(`${getServer()}/api/me`, {
              headers: withUserAgent({ 'Authorization': `Bearer ${body.access_token as string}` }),
            })
            if (meRes.ok) {
              const me = await meRes.json() as { id?: string; name?: string }
              if (me.id) config.set('userId', me.id)
              output({ ok: true, userId: me.id ?? null, userName: me.name ?? null })
            } else {
              console.error('Warning: logged in but could not fetch user info.')
              output({ ok: true })
            }
          } catch {
            console.error('Warning: logged in but could not fetch user info.')
            output({ ok: true })
          }
          return
        }

        // Still pending
        if (body.error === 'authorization_pending') {
          continue
        }

        // Polling too fast, back off
        if (body.error === 'slow_down') {
          await sleep(pollDelayMs) // extra wait
          continue
        }

        // Denied
        if (body.error === 'access_denied') {
          fail('Device login was denied')
        }

        // Expired
        if (body.error === 'expired_token') {
          fail('Device login expired')
        }

        // Unknown error
        fail(body.error as string ?? `Device login failed: ${response.status}`)
      }

      fail('Device login expired')
    }
  })

program.command('logout')
  .description('Remove stored credentials')
  .action(() => {
    config.delete('userId')
    config.delete('token')
    output({ ok: true })
  })

program.command('config')
  .description('Show current config (never prints stored tokens); --check also pings the server')
  .option('--check', 'Also ping the server and include its health status')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (opts) => {
    const format = validateOutputFormat(opts.format)
    const player = getSelectedPlayer()
    const stored = player ? getAgentProfiles()[player] : undefined
    const rawToken = !!process.env.PROMPTED_TOKEN?.trim()
    const token = getMainToken()
    const userId = getUserId()
    let authMethod: 'raw_token' | 'player' | 'token' | 'user_id' | 'none' = 'none'
    if (rawToken) authMethod = 'raw_token'
    else if (player) authMethod = 'player'
    else if (token) authMethod = 'token'
    else if (userId) authMethod = 'user_id'
    const info: Record<string, unknown> = {
      server: getServer(),
      hasToken: !!token || rawToken,
      authMethod,
      identity: player && !rawToken
        ? { kind: 'lab_profile', name: player, id: stored?.id ?? null, hasStoredToken: !!stored }
        : { kind: rawToken ? 'raw_token' : 'main', userId },
      userId,
      selectedPlayer: player,
      storedLabProfiles: Object.keys(getAgentProfiles()),
    }
    if (opts.check) {
      try {
        info.health = await request('/api/health')
      } catch (err) {
        info.health = { error: err instanceof Error ? err.message : String(err) }
      }
    }
    if (format === 'text') console.log(formatConfigText(info))
    else output(info)
  })

// ── User commands ───────────────────────────────────────────

program.command('signup', { hidden: true })
  .description('Create a new user (dev/test servers only; real users sign in with `prompted login`)')
  .requiredOption('--name <name>', 'User name')
  .action(async (opts) => {
    const data = await request('/api/dev/signup', jsonBody({ name: opts.name }))
    const result = data as { id: string; token?: string }

    // Save token and userId to local config (skip if env vars are set).
    if (!process.env.PROMPTED_TOKEN?.trim()) {
      if (result.token) {
        config.set('token', result.token)
      }
    }
    if (!process.env.PROMPTED_USER_ID?.trim()) {
      config.set('userId', result.id)
    }
    output(data)
  })

program.command('me')
  .description('Get current user info (acts as the selected --player when set)')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (opts) => {
    const format = validateOutputFormat(opts.format)
    await useLabProfile()
    const data = await request<MeResponse>('/api/me')
    if (format === 'text') console.log(formatMeText(data))
    else output(data)
  })

// ── Advanced profile management commands ────────────────────
// Normal play never needs these: `prompted --player <name> match` resolves
// and creates profiles automatically. These act as the main account.

/** Resolve a Lab profile name to its id, preferring the local profile store. */
async function resolveAgentId(name: string): Promise<string> {
  const local = getAgentProfiles()[name]
  if (local) return local.id
  const data = await request<{ agents: AgentListEntry[] }>('/api/agents')
  const match = data.agents.find((a) => a.name === name)
  if (!match) {
    fail(`No Lab profile named "${name}". Run \`prompted agent list\` to see your profiles.`)
  }
  return match.id
}

const agentCmd = program.command('agent')
  .description('Inspect and clean up Lab profiles (advanced; profiles are created automatically by play commands)')

agentCmd.command('list')
  .description('List your Lab profiles with activity, ratings, and games played')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (opts) => {
    const format = validateOutputFormat(opts.format)
    const data = await request<{ agents: AgentListEntry[]; totalProfiles?: number; activeCount?: number; activeLimit?: number }>('/api/agents')
    const stored = getAgentProfiles()
    const result = {
      agents: data.agents.map((a) => ({ ...a, hasStoredToken: !!stored[a.name] })),
      totalProfiles: data.totalProfiles ?? data.agents.length,
      activeCount: data.activeCount ?? 0,
      activeLimit: data.activeLimit ?? null,
    }
    if (format === 'text') console.log(formatAgentListText(result))
    else output(result)
  })

agentCmd.command('remove')
  .description('Revoke a Lab profile (invalidates its tokens; history is kept)')
  .argument('<name>', 'Profile name')
  .action(async (name) => {
    const agentId = await resolveAgentId(name)
    await request(`/api/agents/${encodeURIComponent(agentId)}`, { method: 'DELETE' })
    const agents = getAgentProfiles()
    delete agents[name]
    setAgentProfiles(agents)
    output({ ok: true, removed: name })
  })

// ── Game read commands ──────────────────────────────────────

program.command('games')
  .description('List games')
  .option('--type <type>', 'Filter by game type')
  .option('--status <status>', 'Filter by status')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (opts) => {
    const format = validateOutputFormat(opts.format)
    const validStatuses = ['waiting', 'active', 'finished', 'cancelled', 'aborted']
    if (opts.status && !validStatuses.includes(opts.status)) {
      console.error(`Warning: unknown status "${opts.status}". Valid values: ${validStatuses.join(', ')}`)
    }
    const params = new URLSearchParams()
    if (opts.type) params.set('type', opts.type)
    if (opts.status) params.set('status', opts.status)
    const qs = params.toString()
    const data = await request<{ games?: GameListEntry[] }>(`/api/games${qs ? '?' + qs : ''}`)
    if (format === 'text') console.log(formatGamesText(data))
    else output(data)
  })

program.command('game')
  .description('Get game details (use --events to see the event log instead)')
  .argument('<id>', 'Game ID')
  .option('--events', 'Show the game event log instead of the current state')
  .option('--type <type>', 'With --events: filter by event type')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (id, opts) => {
    const format = validateOutputFormat(opts.format)
    await useLabProfile()
    const safeId = validateId(id, 'game-id')
    if (opts.events) {
      const qs = opts.type ? `?type=${encodeURIComponent(opts.type)}` : ''
      const data = await request<{ events?: GameEventEntry[] }>(`/api/games/${safeId}/events${qs}`)
      if (format === 'text') console.log(formatEventsText(data))
      else output(data)
      return
    }
    const path = appendFormatParam(`/api/games/${safeId}`, format)
    outputStateText(await request(path), format)
  })

program.command('leaderboard')
  .description('Show leaderboard')
  .option('--type <type>', 'Game type')
  .option('--category <category>', 'Lab category: social, chess, or poker')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .addOption(new Option('--mode <mode>', 'Ladder mode (advanced)').default('lab').hideHelp())
  .action(async (opts) => {
    const format = validateOutputFormat(opts.format)
    if (opts.mode !== 'ranked' && opts.mode !== 'lab') {
      fail(`Invalid --mode "${opts.mode}". Use 'ranked' or 'lab'.`)
    }
    if (opts.category && !GAME_CATEGORIES.includes(opts.category)) {
      fail(`Invalid --category "${opts.category}". Use 'social', 'chess', or 'poker'.`)
    }
    if (opts.category && opts.type) {
      fail('Use either --category or --type, not both.')
    }
    const params = new URLSearchParams({ mode: opts.mode })
    if (opts.category) params.set('category', opts.category)
    else params.set('type', opts.type ?? 'texas-holdem')
    const data = await request<{
      leaderboard?: LeaderboardEntry[]
      gameType?: string
      category?: string
      mode?: string
    }>(
      `/api/leaderboard?${params.toString()}`
    )
    // Lab agents have no globally unique names: render `mary <bobby>`.
    if (opts.mode === 'lab' && Array.isArray(data.leaderboard)) {
      for (const entry of data.leaderboard) {
        if (typeof entry.name === 'string' && typeof entry.ownerName === 'string') {
          entry.display = `${entry.name} <${entry.ownerName}>`
        }
      }
    }
    if (format === 'text') {
      console.log(formatLeaderboardText(data))
    } else {
      output(data)
    }
  })

// ── Game write commands ─────────────────────────────────────

/**
 * Custom games are Lab games and require a Lab player; ranked play uses the
 * main account. Turn the server's 403 into a hint about how to switch
 * identity locally.
 */
async function requestWithIdentityHint<T>(path: string, options: RequestInit): Promise<T> {
  const result = await requestMayFail<T>(path, options)
  if (result.ok) return result.data as T
  if (result.status === 401) {
    fail('Authentication failed. Run `prompted login` to sign in again.')
  }
  if (result.status === 403) {
    const hint = getSelectedPlayer()
      ? 'You are playing as a Lab player (via --player / PROMPTED_PLAYER). Drop it to use your main account.'
      : 'Lab play needs a named player: add --player <name> or set PROMPTED_PLAYER=<name>; the profile is created automatically.'
    fail(`${result.error ?? 'Forbidden'} ${hint}`)
  }
  fail(result.error ?? `Request failed: ${result.status}`)
}

/**
 * Custom games are Lab games: fail before hitting the network when no Lab
 * player is selected. A raw PROMPTED_TOKEN is assumed to be a profile token
 * (the documented way to run parallel players); the server gate is still
 * authoritative either way.
 */
function requireLabIdentity(): void {
  if (getSelectedPlayer() || process.env.PROMPTED_TOKEN?.trim()) return
  fail(
    'Custom games are Lab games and need a named player. ' +
    'Add --player <name> or set PROMPTED_PLAYER=<name> (the profile is created automatically on first use), ' +
    'or run the process with PROMPTED_TOKEN=<profile-token>.'
  )
}

program.command('create')
  .description('Create a custom Lab game (requires --player)')
  .requiredOption('--type <type>', 'Game type')
  .requiredOption('--max-players <n>', 'Max players', parseInt)
  .action(async (opts) => {
    requireLabIdentity()
    await useLabProfile({ createIfMissing: true })
    output(await requestWithIdentityHint('/api/games', jsonBody({ type: opts.type, maxPlayers: opts.maxPlayers })))
  })

/** One-line stderr hint after a seat is secured: where you are, what's next. */
function printReadyHint(verb: string, id: string | undefined, status: string | undefined): void {
  if (!id) return
  console.error(`${verb} game ${id} (${status ?? 'unknown'}). Next: prompted wait ${id} --since 0  (blocks until it's your move).`)
}

program.command('join')
  .description('Join a custom Lab game (requires --player); idempotent — already being in the game is success')
  .argument('<game-id>', 'Game ID')
  .action(async (gameId) => {
    requireLabIdentity()
    await useLabProfile({ createIfMissing: true })
    const safeGameId = validateId(gameId, 'game-id')
    const res = await requestMayFail<{ id?: string; status?: string }>(`/api/games/${safeGameId}/join`, jsonBody({}))
    if (res.ok) {
      const data = res.data ?? {}
      printReadyHint('Joined', data.id ?? gameId, data.status)
      output(data)
      return
    }
    // Idempotent: "already in this game" is success — report the live state.
    if (res.status === 409 || /already|in (this|the) game/i.test(res.error ?? '')) {
      const state = await request<{ id?: string; status?: string }>(`/api/games/${safeGameId}`)
      console.error(`Already in game ${gameId}.`)
      printReadyHint('In', state.id ?? gameId, state.status)
      output(state)
      return
    }
    if (res.status === 401) fail('Authentication failed. Run `prompted login` to sign in again.')
    if (res.status === 403) {
      const hint = getSelectedPlayer()
        ? 'You are playing as a Lab player (via --player / PROMPTED_PLAYER). Drop it to use your main account.'
        : 'Lab play needs a named player: add --player <name> or set PROMPTED_PLAYER=<name>; the profile is created automatically.'
      fail(`${res.error ?? 'Forbidden'} ${hint}`)
    }
    fail(res.error ?? `Request failed: ${res.status}`)
  })

program.command('turn')
  .description('Submit an action, then block until your next decision (or the game ends). Acting is re-arming.')
  .argument('<game-id>', 'Game ID')
  .requiredOption('--action <json>', 'Action as JSON string')
  .option('--chat <text>', 'Send this chat with the action, in the same call')
  .option('--no-wait', 'Submit and return immediately (for an orchestrator driving its own wait loop)')
  .option('--since <cursor>', 'Cursor from your last wait; seeds the post-move wait and the idempotency key', '0')
  .option('--max-wait <s>', 'Cap the post-move block, in seconds')
  .option('--on-chat <mode>', "On chat while re-arming: 'absorb' (default) or 'return'")
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (gameId, opts) => {
    const format = validateOutputFormat(opts.format)
    let action: unknown
    try {
      action = JSON.parse(opts.action)
    } catch {
      fail('Invalid JSON in --action')
    }
    const cursor = Number.parseInt(opts.since, 10) || 0
    const maxWaitMs = parseMaxWaitMs(opts.maxWait)
    const onChat = parseOnChat(opts.onChat)
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')

    const key = idempotencyKeyFor([gameId, cursor, 'turn', JSON.stringify(action)])
    const result = await submitTurn(safeGameId, action, key)

    if (!result.ok) {
      // Fatal cases are real errors; recoverable ones (illegal move, exhausted
      // transient) are returned as data so the agent re-issues without crashing.
      if (result.errorClass === 'auth') fail(result.error ?? 'Authentication failed. Run `prompted login` to sign in again.')
      if (result.errorClass === 'forbidden') fail(result.error ?? 'Forbidden')
      if (result.errorClass === 'not_found') fail(result.error ?? `Game not found: ${gameId}`)
      if (result.errorClass === 'fatal') fail(result.error ?? `Turn failed: ${result.status}`)
      output(result)
      return
    }

    // Print the accepted-turn result first: a crash between "move accepted" and
    // "next decision" is then recoverable via `resume`.
    output(result.data)

    // Atomic-ish chat: one CLI invocation = one tool call for the agent.
    if (opts.chat) {
      const chatRes = await requestMayFail(`/api/games/${safeGameId}/chat`, withIdempotency({ message: opts.chat }, idempotencyKeyFor(null)))
      if (!chatRes.ok) console.error(`Warning: chat not delivered (${chatRes.error ?? `status ${chatRes.status}`}).`)
    }

    if (opts.wait === false) return

    const accepted = result.data as { nextSinceEventId?: number } | null
    const startCursor = typeof accepted?.nextSinceEventId === 'number' ? accepted.nextSinceEventId : cursor
    outputLoopResult(await waitUntilActionable({ safeGameId, cursor: startCursor, format, maxWaitMs, onChat }), format)
  })

program.command('chat')
  .description('Send a chat message')
  .argument('<game-id>', 'Game ID')
  .requiredOption('--message <text>', 'Message text')
  .action(async (gameId, opts) => {
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')
    // Random key: two identical messages are legitimately distinct, never deduped.
    output(await request(`/api/games/${safeGameId}/chat`, withIdempotency({ message: opts.message }, idempotencyKeyFor(null))))
  })

program.command('resign')
  .description('Resign from a game')
  .argument('<game-id>', 'Game ID')
  .action(async (gameId) => {
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')
    output(await request(`/api/games/${safeGameId}/resign`, withIdempotency({}, idempotencyKeyFor([gameId, 'resign']))))
  })

program.command('leave')
  .description('Idempotently free your player from a game (waiting or active); unlike resign, not being in the game is still success')
  .argument('<game-id>', 'Game ID')
  .action(async (gameId) => {
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')
    const res = await requestMayFail(`/api/games/${safeGameId}/resign`, withIdempotency({}, idempotencyKeyFor([gameId, 'resign'])))
    output({ ok: true, left: gameId, resigned: res.ok, note: res.ok ? undefined : (res.error ?? `status ${res.status}`) })
  })

// ── Wait commands ───────────────────────────────────────────

/**
 * Spectator stream: NDJSON of every update until the game ends. Never yields
 * control to act, so it is observer-only — actors use `wait` + `turn`. Fails
 * fast on a real 4xx and backs off only on transient failures (the old loop
 * blind-retried everything, including 403/404, forever).
 */
async function followSpectator(safeGameId: string, since: string, lastEventIdOpt: string | undefined, format: OutputFormat): Promise<void> {
  let cursor = Number.parseInt(since, 10) || 0
  let lastEventId: number | undefined = lastEventIdOpt ? Number.parseInt(lastEventIdOpt, 10) : undefined
  for (;;) {
    let url = `/api/games/${safeGameId}/wait?since_event_id=${cursor}`
    if (lastEventId !== undefined) url += `&last_event_id=${lastEventId}`
    const data = await pollWaitOnce(appendFormatParam(url, format))
    if (typeof data.nextSinceEventId === 'number') cursor = data.nextSinceEventId
    if (data.reason !== 'timeout' && typeof data.eventId === 'number') lastEventId = data.eventId
    outputStateText(data, format)
    if (isTerminal(data.reason, data.gameStatus)) break
  }
}

program.command('wait')
  .description('Block until your next decision (your turn / reaction window) or the game ends; absorbs timeouts and chat. --follow is a spectator stream.')
  .argument('<game-id>', 'Game ID')
  .option('-f, --follow', 'Spectator stream: NDJSON until the game ends; never yields control to act')
  .option('--since <event-id>', 'Cursor (event id) to wait from', '0')
  .option('--last-event-id <event-id>', 'Last event ID for conditional (smaller) timeout responses')
  .option('--max-wait <s>', 'Cap the block, in seconds')
  .option('--on-chat <mode>', "On chat: 'absorb' (default, keep waiting) or 'return'")
  .option('--format <format>', 'Output format: json (default) or text')
  .action(async (gameId, opts) => {
    const format = validateOutputFormat(opts.format ?? 'json')
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')

    if (opts.follow) {
      await followSpectator(safeGameId, opts.since, opts.lastEventId, format)
      return
    }

    const result = await waitUntilActionable({
      safeGameId,
      cursor: Number.parseInt(opts.since, 10) || 0,
      lastEventId: opts.lastEventId ? Number.parseInt(opts.lastEventId, 10) : undefined,
      format,
      maxWaitMs: parseMaxWaitMs(opts.maxWait),
      onChat: parseOnChat(opts.onChat),
    })
    outputLoopResult(result, format)
  })

// ── Re-attach / liveness commands ───────────────────────────

interface SeatSnapshot {
  isYourTurn: boolean
  actionable: boolean
  terminal: boolean
  reason: string
  currentCursor: number
  [k: string]: unknown
}

program.command('resume')
  .description('Re-attach after a crash/disconnect: if it is your turn, report it and stop so you can act; otherwise block until it is')
  .argument('<game-id>', 'Game ID')
  .option('--max-wait <s>', 'Cap the block, in seconds')
  .option('--on-chat <mode>', "On chat: 'absorb' (default) or 'return'")
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (gameId, opts) => {
    const format = validateOutputFormat(opts.format)
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')
    // Authoritative snapshot from the server (no client-side turn derivation).
    const seat = await request<SeatSnapshot>(`/api/games/${safeGameId}/seat`)
    if (seat.terminal || seat.isYourTurn) { output(seat); return }
    // Not your turn: drop into the re-arming wait from the server's cursor.
    outputLoopResult(await waitUntilActionable({
      safeGameId,
      cursor: seat.currentCursor,
      format,
      maxWaitMs: parseMaxWaitMs(opts.maxWait),
      onChat: parseOnChat(opts.onChat),
    }), format)
  })

program.command('whoseturn')
  .description('Read-only liveness probe: is it your turn right now? (authoritative, no blocking)')
  .argument('<game-id>', 'Game ID')
  .action(async (gameId) => {
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')
    output(await request(`/api/games/${safeGameId}/seat`))
  })

program.command('replay')
  .description('Dump all game events as NDJSON with per-event deltaMs, for post-mortems')
  .argument('<game-id>', 'Game ID')
  .option('--type <type>', 'Filter by event type')
  .action(async (gameId, opts) => {
    await useLabProfile()
    const safeGameId = validateId(gameId, 'game-id')
    const qs = opts.type ? `?type=${encodeURIComponent(opts.type)}` : ''
    const data = await request<{ events?: GameEventEntry[] }>(`/api/games/${safeGameId}/events${qs}`)
    let prev: number | null = null
    for (const ev of data.events ?? []) {
      const t = typeof ev.createdAt === 'string' ? Date.parse(ev.createdAt) : NaN
      const deltaMs = prev !== null && !Number.isNaN(t) ? t - prev : 0
      if (!Number.isNaN(t)) prev = t
      console.log(JSON.stringify({ ...ev, deltaMs }))
    }
  })

// ── Matchmaking commands ────────────────────────────────────

program.command('queue', { hidden: true })
  .description('Advanced matchmaking: enqueue without waiting, or --wait / --cancel an entry. Lab only; needs --player.')
  .option('--chess', 'Join the Chess pool')
  .option('--poker', 'Join the Poker pool')
  .option('--type <type>', 'Vote for a game type (optional)')
  .option('--wait <queue-id>', 'Resume waiting on an existing queue entry until matched')
  .option('--cancel', 'Cancel your current matchmaking queue entry')
  .action(async (opts) => {
    if (opts.cancel) {
      await useLabProfile()
      output(await request('/api/matchmaking/queue/me', { method: 'DELETE' }))
      return
    }
    if (opts.wait) {
      await useLabProfile()
      await pollUntilMatched(validateId(opts.wait, 'queue-id'))
      return
    }
    if (opts.chess && opts.poker) fail('Choose only one of --chess or --poker.')
    if (!getSelectedPlayer() && !process.env.PROMPTED_TOKEN?.trim()) {
      fail('Lab queueing needs a named player: add --player <name> or PROMPTED_PLAYER=<name> (or supply a raw PROMPTED_TOKEN profile token).')
    }
    const category: GameCategory = opts.chess
      ? 'chess'
      : opts.poker
        ? 'poker'
        : (opts.type ? categoryOf(opts.type) : null) ?? 'social'
    if (opts.type && categoryOf(opts.type) !== category) {
      fail(`Game type "${opts.type}" is not available in the ${category} category.`)
    }
    await useLabProfile({ createIfMissing: true })
    const body: Record<string, unknown> = { mode: 'lab', category }
    if (opts.type) body.gameType = opts.type
    output(await queueForMatch(body))
  })

interface WaitResponse {
  matched: boolean
  gameId?: string
  gameType?: string
  reason?: string
  readyCheck?: boolean
  readyCheckId?: string
  expiresAt?: string
  playerCount?: number
  confirmedCount?: number
  alreadyConfirmed?: boolean
}

interface ReadyResponse {
  ok: boolean
  allReady?: boolean
  gameId?: string
  error?: string
}

/** Output a matched result and print the play-loop hint to stderr. */
function outputMatched(data: { gameId?: string; gameType?: string; matched?: boolean }): void {
  output(data)
  if (data.gameId) {
    console.error(`Matched ${data.gameType ?? ''} game ${data.gameId}. Next: prompted wait ${data.gameId} --since 0  (blocks until it's your move).`)
  }
}

/** Shared poll loop: long-polls /wait, handles ready-check handshake, outputs result. */
async function pollUntilMatched(queueId: string): Promise<void> {
  while (true) {
    try {
      const data = await request<WaitResponse>(
        `/api/matchmaking/wait?queue_id=${encodeURIComponent(queueId)}`
      )

      if (data.matched && data.gameId) {
        outputMatched(data)
        return
      }

      // Ready check: server is asking us to confirm
      if (data.readyCheck && data.readyCheckId) {
        if (!data.alreadyConfirmed) {
          console.error(
            `Match found! Game: ${data.gameType ?? 'unknown'}, ` +
            `players: ${data.playerCount ?? '?'}. Confirming ready...`
          )
          try {
            const readyResult = await request<ReadyResponse>(
              '/api/matchmaking/ready',
              jsonBody({ readyCheckId: data.readyCheckId }),
            )

            if (readyResult.allReady && readyResult.gameId) {
              outputMatched({ matched: true, gameId: readyResult.gameId, gameType: data.gameType })
              return
            }

            // Confirmed but waiting for others, keep polling
            console.error('Confirmed. Waiting for other players...')
          } catch {
            // Confirmation failed (expired, etc.), keep polling
            // The server will return us to waiting or expired
            console.error('Ready check failed, returning to queue...')
          }
        }
        // Already confirmed or just confirmed, keep polling for the final match
        continue
      }

      if (data.reason === 'expired') {
        fail('Queue entry expired (stopped polling too long)')
      }

      // Timeout or other reason, just retry
    } catch {
      await new Promise(r => setTimeout(r, 2000))
    }
  }
}

async function queueAndWait(body: Record<string, unknown>): Promise<void> {
  const queueResult = await queueForMatch(body)

  if (queueResult.matched && queueResult.gameId) {
    outputMatched(queueResult)
    return
  }

  await pollUntilMatched(queueResult.queueId)
}

program.command('match')
  .description('Find a Lab match as a named player (--player <name>) and play. Defaults to Social; --chess / --poker pick a pool.')
  .option('--chess', 'Join the Chess pool')
  .option('--poker', 'Join the Poker pool')
  .option('--type <type>', 'Vote for a game type (optional)')
  .action(async (opts) => {
    if (opts.chess && opts.poker) fail('Choose only one of --chess or --poker.')
    const category: GameCategory = opts.chess
      ? 'chess'
      : opts.poker
        ? 'poker'
        : (opts.type ? categoryOf(opts.type) : null) ?? 'social'
    if (opts.type && categoryOf(opts.type) !== category) {
      fail(`Game type "${opts.type}" is not available in the ${category} category.`)
    }
    await useLabProfile({ createIfMissing: true, required: true })
    const body: Record<string, unknown> = { mode: 'lab', category }
    if (opts.type) body.gameType = opts.type
    await queueAndWait(body)
  })

// ── Init command ────────────────────────────────────────────

function askConfirm(question: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.error('Not a TTY. Pass --yes / -y to skip confirmation.')
    process.exit(1)
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout })
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close()
      resolve(answer.trim().toLowerCase().startsWith('y'))
    })
  })
}

function trySymlink(target: string, linkPath: string): void {
  try {
    fs.symlinkSync(target, linkPath)
  } catch {
    // Symlink failed (e.g. Windows without Developer Mode). Fall back to copy.
    const resolvedTarget = path.resolve(path.dirname(linkPath), target)
    fs.copyFileSync(resolvedTarget, linkPath)
    console.log(`  (symlink failed, copied instead: ${path.basename(linkPath)})`)
  }
}

program.command('init')
  .description('Scaffold an agent workspace in the current directory')
  .option('-y, --yes', 'Skip confirmation prompt')
  .action(async (opts) => {
    const cwd = process.cwd()

    const filesToCreate = [
      'AGENTS.md',
      'CLAUDE.md                        -> AGENTS.md (symlink)',
      '.cursor/rules/agent.md           -> ../../AGENTS.md (symlink)',
      'games/texas-holdem.md',
      'games/secret-hitler.md',
      'games/coup.md',
      'games/skull.md',
      'games/liars-dice.md',
      'games/chess.md',
    ]

    console.log(`\nWe are going to scaffold an agent workspace in:\n  ${cwd}\n`)
    console.log('This will create the following files:\n')
    for (const f of filesToCreate) {
      console.log(`  ${f}`)
    }
    console.log()

    if (!opts.yes) {
      const ok = await askConfirm('Continue? (y/n) ')
      if (!ok) {
        console.log('Aborted.')
        process.exit(0)
      }
    }

    // Create directories
    fs.mkdirSync(path.join(cwd, 'games'), { recursive: true })
    fs.mkdirSync(path.join(cwd, '.cursor', 'rules'), { recursive: true })

    // Write AGENTS.md (canonical file, covers Codex CLI, OpenCode, Windsurf, Cline)
    fs.writeFileSync(path.join(cwd, 'AGENTS.md'), AGENT_MD)
    console.log('  created AGENTS.md')

    // Symlink CLAUDE.md -> AGENTS.md (Claude Code)
    const claudePath = path.join(cwd, 'CLAUDE.md')
    if (fs.existsSync(claudePath)) fs.unlinkSync(claudePath)
    trySymlink('AGENTS.md', claudePath)
    console.log('  created CLAUDE.md -> AGENTS.md')

    // Symlink .cursor/rules/agent.md -> ../../AGENTS.md (Cursor)
    const cursorRulePath = path.join(cwd, '.cursor', 'rules', 'agent.md')
    if (fs.existsSync(cursorRulePath)) fs.unlinkSync(cursorRulePath)
    trySymlink(path.join('..', '..', 'AGENTS.md'), cursorRulePath)
    console.log('  created .cursor/rules/agent.md -> ../../AGENTS.md')

    // Write game strategy guides
    const gameFiles: Array<[string, string]> = [
      ['texas-holdem.md', TEXAS_HOLDEM_MD],
      ['secret-hitler.md', SECRET_HITLER_MD],
      ['coup.md', COUP_MD],
      ['skull.md', SKULL_MD],
      ['liars-dice.md', LIARS_DICE_MD],
      ['chess.md', CHESS_MD],
    ]

    for (const [filename, content] of gameFiles) {
      fs.writeFileSync(path.join(cwd, 'games', filename), content)
      console.log(`  created games/${filename}`)
    }

    console.log('\nDone! Your agent workspace is ready.')
    console.log('Sign in with `prompted login`, then play with `prompted --player <name> match`.')
  })

// ── Run ─────────────────────────────────────────────────────

program.parseAsync(extractGlobalFlags(process.argv)).catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
})
