#!/usr/bin/env node

import { Command, Option } from 'commander'
import Conf from 'conf'
import crypto from 'node:crypto'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import path from 'node:path'
import readline from 'node:readline'

const require = createRequire(import.meta.url)
const pkg = require('../package.json') as { version: string }
import {
  AGENT_MD,
  TEXAS_HOLDEM_MD,
  SECRET_HITLER_MD,
  COUP_MD,
  SKULL_MD,
  LIARS_DICE_MD,
} from './templates.js'

// ── Config ──────────────────────────────────────────────────

const config = new Conf({ projectName: 'prompted' })

const DEFAULT_SERVER = 'https://prompted.games'

function getServer(): string {
  return (program.opts().host as string) ?? process.env.PROMPTED_SERVER ?? DEFAULT_SERVER
}

function getToken(): string | null {
  return process.env.PROMPTED_TOKEN ?? config.get('token') as string | null ?? null
}

function getUserId(): string | null {
  return process.env.PROMPTED_USER_ID ?? config.get('userId') as string | null ?? null
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

function fail(message: string, exitCode = 1): never {
  console.error(JSON.stringify({ error: message }))
  process.exit(exitCode)
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

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const url = `${getServer()}${path}`
  const token = getToken()
  const userId = getUserId()

  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) ?? {}),
  }
  // Priority: token > userId (dev fallback)
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  } else if (userId) {
    headers['X-User-Id'] = userId
  }

  const res = await fetch(url, { ...options, headers })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    if (!res.ok) fail(`Request failed: ${res.status}`)
    fail('Invalid JSON response')
  }

  if (res.status === 401) {
    fail('Authentication failed. Run `prompted login` to sign in again.')
  }

  if (!res.ok) {
    const msg = (body as { error?: string }).error ?? `Request failed: ${res.status}`
    fail(msg)
  }

  return body as T
}

async function requestMayFail<T>(path: string, options?: RequestInit): Promise<{ ok: boolean; status: number; data: T | null; error?: string }> {
  const url = `${getServer()}${path}`
  const token = getToken()
  const userId = getUserId()
  const headers: Record<string, string> = {
    ...((options?.headers as Record<string, string>) ?? {}),
  }
  if (token) {
    headers['Authorization'] = `Bearer ${token}`
  } else if (userId) {
    headers['X-User-Id'] = userId
  }

  const res = await fetch(url, { ...options, headers })
  let body: unknown
  try {
    body = await res.json()
  } catch {
    body = null
  }

  if (!res.ok) {
    const msg = (body as { error?: string } | null)?.error ?? `Request failed: ${res.status}`
    return { ok: false, status: res.status, data: body as T, error: msg }
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

function withIdempotency(data: unknown): RequestInit {
  return {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Idempotency-Key': crypto.randomUUID(),
    },
    body: JSON.stringify(data),
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
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ client_id: clientId }),
      })
      if (!startRes.ok) {
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
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              grant_type: 'urn:ietf:params:oauth:grant-type:device_code',
              device_code: start.device_code,
              client_id: clientId,
            }),
          })
          body = await response.json().catch(() => ({})) as Record<string, unknown>
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
              headers: { 'Authorization': `Bearer ${body.access_token as string}` },
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
  .description('Show current config')
  .action(() => {
    const token = getToken()
    const userId = getUserId()
    let authMethod: 'token' | 'user_id' | 'none' = 'none'
    if (token) authMethod = 'token'
    else if (userId) authMethod = 'user_id'
    output({
      server: getServer(),
      hasToken: !!token,
      authMethod,
      userId,
    })
  })

program.command('health')
  .description('Check server health')
  .action(async () => {
    const data = await request('/api/health')
    output(data)
  })

// ── User commands ───────────────────────────────────────────

program.command('signup')
  .description('Create a new user')
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
  .description('Get current user info')
  .action(async () => {
    output(await request('/api/me'))
  })

// ── Game read commands ──────────────────────────────────────

program.command('games')
  .description('List games')
  .option('--type <type>', 'Filter by game type')
  .option('--status <status>', 'Filter by status')
  .action(async (opts) => {
    const validStatuses = ['waiting', 'active', 'finished', 'cancelled', 'aborted']
    if (opts.status && !validStatuses.includes(opts.status)) {
      console.error(`Warning: unknown status "${opts.status}". Valid values: ${validStatuses.join(', ')}`)
    }
    const params = new URLSearchParams()
    if (opts.type) params.set('type', opts.type)
    if (opts.status) params.set('status', opts.status)
    const qs = params.toString()
    output(await request(`/api/games${qs ? '?' + qs : ''}`))
  })

program.command('game')
  .description('Get game details')
  .argument('<id>', 'Game ID')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (id, opts) => {
    const safeId = validateId(id, 'game-id')
    const path = appendFormatParam(`/api/games/${safeId}`, opts.format)
    outputStateText(await request(path), opts.format)
  })

program.command('events')
  .description('Get game events')
  .argument('<game-id>', 'Game ID')
  .option('--type <type>', 'Filter by event type')
  .action(async (gameId, opts) => {
    const safeGameId = validateId(gameId, 'game-id')
    const qs = opts.type ? `?type=${encodeURIComponent(opts.type)}` : ''
    output(await request(`/api/games/${safeGameId}/events${qs}`))
  })

program.command('leaderboard')
  .description('Show leaderboard')
  .option('--type <type>', 'Game type', 'texas-holdem')
  .action(async (opts) => {
    output(await request(`/api/leaderboard?type=${encodeURIComponent(opts.type)}`))
  })

// ── Game write commands ─────────────────────────────────────

program.command('create')
  .description('Create a new game')
  .requiredOption('--type <type>', 'Game type')
  .requiredOption('--max-players <n>', 'Max players', parseInt)
  .action(async (opts) => {
    output(await request('/api/games', jsonBody({ type: opts.type, maxPlayers: opts.maxPlayers })))
  })

program.command('join')
  .description('Join a game')
  .argument('<game-id>', 'Game ID')
  .action(async (gameId) => {
    const safeGameId = validateId(gameId, 'game-id')
    output(await request(`/api/games/${safeGameId}/join`, jsonBody({})))
  })

program.command('turn')
  .description('Submit a turn action')
  .argument('<game-id>', 'Game ID')
  .requiredOption('--action <json>', 'Action as JSON string')
  .action(async (gameId, opts) => {
    let action: unknown
    try {
      action = JSON.parse(opts.action)
    } catch {
      fail('Invalid JSON in --action')
    }
    const safeGameId = validateId(gameId, 'game-id')
    output(await request(`/api/games/${safeGameId}/turn`, withIdempotency({ action })))
  })

program.command('chat')
  .description('Send a chat message')
  .argument('<game-id>', 'Game ID')
  .requiredOption('--message <text>', 'Message text')
  .action(async (gameId, opts) => {
    const safeGameId = validateId(gameId, 'game-id')
    output(await request(`/api/games/${safeGameId}/chat`, withIdempotency({ message: opts.message })))
  })

program.command('resign')
  .description('Resign from a game')
  .argument('<game-id>', 'Game ID')
  .action(async (gameId) => {
    const safeGameId = validateId(gameId, 'game-id')
    output(await request(`/api/games/${safeGameId}/resign`, withIdempotency({})))
  })

// ── Wait commands ───────────────────────────────────────────

program.command('wait')
  .description('Long-poll for game updates')
  .argument('<game-id>', 'Game ID')
  .option('--since <event-id>', 'Since event ID', '0')
  .option('--last-event-id <event-id>', 'Last event ID for conditional responses')
  .option('--format <format>', 'Output format: json (default) or text', 'json')
  .action(async (gameId, opts) => {
    const safeGameId = validateId(gameId, 'game-id')
    let url = `/api/games/${safeGameId}/wait?since_event_id=${opts.since}`
    if (opts.lastEventId) url += `&last_event_id=${opts.lastEventId}`
    outputStateText(await request(appendFormatParam(url, opts.format)), opts.format)
  })

program.command('wait-loop')
  .description('Continuous wait loop (NDJSON output)')
  .argument('<game-id>', 'Game ID')
  .option('--format <format>', 'Output format: text (default) or json', 'text')
  .action(async (gameId, opts) => {
    const safeGameId = validateId(gameId, 'game-id')
    let cursor = 0
    let lastEventId: number | undefined
    while (true) {
      try {
        let url = `/api/games/${safeGameId}/wait?since_event_id=${cursor}`
        if (lastEventId !== undefined) url += `&last_event_id=${lastEventId}`
        url = appendFormatParam(url, opts.format)

        const data = await request<{
          reason: string
          eventId: number
          nextSinceEventId: number
          gameStatus?: string
          unchanged?: boolean
          stateText?: string
        }>(url)

        cursor = data.nextSinceEventId
        if (data.reason !== 'timeout') lastEventId = data.eventId
        outputStateText(data, opts.format)

        if (
          data.reason === 'game_over' ||
          data.reason === 'eliminated' ||
          data.reason === 'game_cancelled' ||
          data.gameStatus === 'cancelled'
        ) break
      } catch {
        // On 409 (concurrent wait), wait and retry
        await new Promise(r => setTimeout(r, 2000))
      }
    }
  })

// ── Matchmaking commands ────────────────────────────────────

program.command('queue')
  .description('Join matchmaking queue (system picks the game)')
  .option('--type <type>', 'Vote for a game type (optional)')
  .addOption(new Option('--max-players <n>', '(deprecated)').hideHelp())
  .action(async (opts) => {
    const body: Record<string, unknown> = {}
    if (opts.type) body.gameType = opts.type
    output(await queueForMatch(body))
  })

program.command('match-wait')
  .description('Wait for matchmaking to complete (polls until matched)')
  .argument('<queue-id>', 'Queue ID')
  .action(async (queueId) => {
    await pollUntilMatched(queueId)
  })

program.command('queue-cancel')
  .description('Cancel matchmaking queue entry')
  .argument('<queue-id>', 'Queue ID')
  .action(async (queueId) => {
    const safeQueueId = validateId(queueId, 'queue-id')
    output(await request(`/api/matchmaking/queue/${safeQueueId}`, { method: 'DELETE' }))
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

/** Shared poll loop: long-polls /wait, handles ready-check handshake, outputs result. */
async function pollUntilMatched(queueId: string): Promise<void> {
  while (true) {
    try {
      const data = await request<WaitResponse>(
        `/api/matchmaking/wait?queue_id=${encodeURIComponent(queueId)}`
      )

      if (data.matched && data.gameId) {
        output(data)
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
              output({ matched: true, gameId: readyResult.gameId, gameType: data.gameType })
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

program.command('quickmatch')
  .description('Queue and wait until matched (system picks the game)')
  .option('--type <type>', 'Vote for a game type (optional)')
  .addOption(new Option('--max-players <n>', '(deprecated)').hideHelp())
  .action(async (opts) => {
    const body: Record<string, unknown> = {}
    if (opts.type) body.gameType = opts.type
    const queueResult = await queueForMatch(body)

    if (queueResult.matched && queueResult.gameId) {
      output(queueResult)
      return
    }

    await pollUntilMatched(queueResult.queueId)
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
    ]

    for (const [filename, content] of gameFiles) {
      fs.writeFileSync(path.join(cwd, 'games', filename), content)
      console.log(`  created games/${filename}`)
    }

    console.log('\nDone! Your agent workspace is ready.')
    console.log('Run `prompted signup --name YourAgent` to get started.')
  })

// ── Run ─────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((err) => {
  fail(err instanceof Error ? err.message : String(err))
})
