import { execFileSync, execFile } from 'node:child_process'
import { createServer, type Server, type IncomingMessage, type ServerResponse } from 'node:http'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { describe, it, expect, beforeEach, afterEach } from 'vitest'

const CLI = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf-8'))

function run(args: string[], env: Record<string, string> = {}): string {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 10_000,
    env: { ...process.env, PROMPTED_TOKEN: '', PROMPTED_PLAYER: '', ...env },
  }).trim()
}

// The mock servers run inside the vitest process, so child CLI processes must
// be spawned asynchronously (execFileSync would block the event loop and
// deadlock the mock server).
function runAsync(args: string[], env: Record<string, string> = {}): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolveRun) => {
    execFile('node', [CLI, ...args], {
      encoding: 'utf-8',
      timeout: 10_000,
      env: { ...process.env, PROMPTED_TOKEN: '', PROMPTED_PLAYER: '', ...env },
    }, (err, stdout, stderr) => {
      resolveRun({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: stdout.trim(), stderr: stderr.trim() })
    })
  })
}

function runFail(args: string[], env: Record<string, string> = {}): string {
  try {
    run(args, env)
  } catch (err) {
    return ((err as { stderr?: string }).stderr ?? '').trim()
  }
  throw new Error('expected command to exit non-zero')
}

describe('prompted CLI', () => {
  it('prints version from package.json', () => {
    expect(run(['--version'])).toBe(pkg.version)
  })

  it('prints help without crashing', () => {
    const out = run(['--help'])
    expect(out).toContain('prompted')
    expect(out).toContain('Commands:')
  })

  it('exposes the new command model in help output', () => {
    const out = run(['--help'])
    for (const cmd of ['login', 'logout', 'games', 'create', 'join', 'turn', 'wait', 'init', 'agent', 'match', '--player']) {
      expect(out).toContain(cmd)
    }
    expect(out).not.toMatch(/^\s*queue\b/m)
    expect(out.toLowerCase()).not.toContain('ranked')
  })

  it('hides dev-only signup from help (still runnable)', () => {
    const out = run(['--help'])
    expect(out).not.toMatch(/^\s*signup\b/m)
  })

  it('does not expose removed commands and options', () => {
    const out = run(['--help'])
    expect(out).not.toContain('quickmatch')
    expect(out).not.toContain('--as ')
    expect(out).not.toContain('PROMPTED_AGENT')
    // Consolidated away: wait-loop -> wait --follow, events -> game --events,
    // match-wait/queue-cancel -> queue --wait/--cancel, health -> config --check.
    expect(out).not.toContain('wait-loop')
    expect(out).not.toContain('match-wait')
    expect(out).not.toContain('queue-cancel')
    for (const cmd of ['wait-loop', 'match-wait', 'queue-cancel', 'events', 'health']) {
      expect(runFail([cmd, 'x'])).toContain('unknown command')
    }
    const agentOut = run(['agent', '--help'])
    expect(agentOut).not.toMatch(/^\s*create\b/m)
    expect(agentOut).not.toMatch(/^\s*token\b/m)
  })

  it('exposes only list/remove agent subcommands', () => {
    const out = run(['agent', '--help'])
    for (const cmd of ['list', 'remove']) {
      expect(out).toContain(cmd)
    }
  })

  it('match without a player fails before queueing', () => {
    const stderr = runFail(['match'])
    expect(stderr).toContain('--player')
  })

  it('does not register rankedmatch', () => {
    expect(runFail(['rankedmatch'])).toContain('unknown command')
  })

  it('validates Lab category flags before queueing', () => {
    expect(runFail(['--player', 'mary', 'match', '--chess', '--poker'])).toContain('only one')
    expect(runFail(['--player', 'mary', 'match', '--chess', '--type', 'coup'])).toContain('not available')
  })

  it('rejects create without a player identity, without hitting the network', () => {
    const stderr = runFail(['create', '--type', 'counter', '--max-players', '2'])
    expect(stderr).toContain('Lab games')
    expect(stderr).toContain('--player')
  })

  it('queue is Lab-only, needs a player, and validates category flags', () => {
    expect(runFail(['queue'])).toContain('--player')
    expect(runFail(['--player', 'mary', 'queue', '--chess', '--poker'])).toContain('only one')
    expect(runFail(['--player', 'mary', 'queue', '--chess', '--type', 'coup'])).toContain('not available')
  })

  it('rejects an invalid leaderboard --mode without hitting the network', () => {
    const stderr = runFail(['leaderboard', '--mode', 'bogus'])
    expect(stderr).toContain('Invalid --mode')
  })

  it('rejects an invalid leaderboard --category without hitting the network', () => {
    expect(runFail(['leaderboard', '--category', 'unknown'])).toContain('Invalid --category')
  })

  it('rejects an invalid leaderboard --format without hitting the network', () => {
    expect(runFail(['leaderboard', '--format', 'yaml'])).toContain('Invalid --format')
  })
})

// ── Mock-server tests for profile resolution ─────────────────

interface RecordedRequest {
  method: string
  url: string
  auth: string | null
  idempotencyKey: string | null
  body: unknown
}

function startMockServer(handler: (req: RecordedRequest, res: ServerResponse) => void): Promise<{ server: Server; url: string; requests: RecordedRequest[] }> {
  const requests: RecordedRequest[] = []
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let data = ''
    req.on('data', (c) => { data += c })
    req.on('end', () => {
      const recorded: RecordedRequest = {
        method: req.method ?? '',
        url: req.url ?? '',
        auth: (req.headers.authorization as string | undefined) ?? null,
        idempotencyKey: (req.headers['idempotency-key'] as string | undefined) ?? null,
        body: data ? JSON.parse(data) : null,
      }
      requests.push(recorded)
      handler(recorded, res)
    })
  })
  return new Promise((resolveStart) => {
    server.listen(0, () => {
      const address = server.address()
      const port = typeof address === 'object' && address ? address.port : 0
      resolveStart({ server, url: `http://127.0.0.1:${port}`, requests })
    })
  })
}

function json(res: ServerResponse, status: number, body: unknown) {
  res.writeHead(status, { 'Content-Type': 'application/json' })
  res.end(JSON.stringify(body))
}

describe('prompted CLI with mock server', () => {
  let confDir: string

  beforeEach(() => {
    confDir = mkdtempSync(join(tmpdir(), 'prompted-cli-test-'))
  })

  afterEach(() => {
    rmSync(confDir, { recursive: true, force: true })
  })

  function env(serverUrl: string, extra: Record<string, string> = {}): Record<string, string> {
    return { PROMPTED_SERVER: serverUrl, PROMPTED_CONFIG_DIR: confDir, ...extra }
  }

  async function ok(args: string[], e: Record<string, string>): Promise<string> {
    const result = await runAsync(args, e)
    expect(result.code, result.stderr).toBe(0)
    return result.stdout
  }

  it('signup --name is unaffected by the global --player flag handling', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/dev/signup') {
        json(res, 201, { id: 'u1', name: (req.body as { name: string }).name, token: 'main-token' })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['signup', '--name', 'bobby'], env(mock.url)))
      expect(out.name).toBe('bobby')
      expect((mock.requests[0].body as { name: string }).name).toBe('bobby')
    } finally {
      mock.server.close()
    }
  })

  it('first --player use resolves through the main account, stores the token, and prints the created notice once', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') {
        json(res, 201, { id: 'agent-1', name: 'mary', token: 'profile-token', created: true })
        return
      }
      if (req.url?.endsWith('/chat')) {
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))

      const first = await runAsync(['--player', 'mary', 'chat', 'g1', '--message', 'hi'], env(mock.url))
      expect(first.code, first.stderr).toBe(0)
      expect(first.stderr).toContain('Created new Lab profile "mary"')

      const resolveReq = mock.requests.find((r) => r.url === '/api/agents/resolve')
      expect(resolveReq).toBeDefined()
      expect(resolveReq!.auth).toBe('Bearer main-token')
      // Continuation commands never auto-create.
      expect((resolveReq!.body as { createIfMissing: boolean }).createIfMissing).toBe(false)
      const chatReq = mock.requests.find((r) => r.url?.endsWith('/chat'))
      expect(chatReq!.auth).toBe('Bearer profile-token')

      // Second use: stored token reused, no further resolve, no created notice.
      const before = mock.requests.length
      const second = await runAsync(['--player', 'mary', 'chat', 'g1', '--message', 'again'], env(mock.url))
      expect(second.code).toBe(0)
      expect(second.stderr).not.toContain('Created new Lab profile')
      expect(mock.requests.slice(before).filter((r) => r.url === '/api/agents/resolve').length).toBe(0)
    } finally {
      mock.server.close()
    }
  })

  it('entry commands resolve with createIfMissing=true', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') {
        json(res, 201, { id: 'agent-1', name: 'mary', token: 'profile-token', created: true })
        return
      }
      if (req.url?.endsWith('/join')) {
        json(res, 200, { id: 'g1', status: 'waiting' })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))
      await ok(['--player', 'mary', 'join', 'g1'], env(mock.url))
      const resolveReq = mock.requests.find((r) => r.url === '/api/agents/resolve')
      expect((resolveReq!.body as { createIfMissing: boolean }).createIfMissing).toBe(true)
    } finally {
      mock.server.close()
    }
  })

  it('re-created profiles (new id for a stored name) print the fresh-ratings note and replace the stored entry', async () => {
    let resolvedId = 'agent-old'
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') {
        json(res, 200, { id: resolvedId, name: 'mary', token: `tok-${resolvedId}`, created: false })
        return
      }
      if (req.url?.endsWith('/chat')) {
        // Force a 401 on the old token so the CLI re-resolves through main.
        if (req.auth === 'Bearer tok-agent-old' && resolvedId === 'agent-new') {
          json(res, 401, { error: 'Invalid or expired token' })
          return
        }
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))
      await ok(['--player', 'mary', 'chat', 'g1', '--message', 'seed'], env(mock.url))

      // Server-side: the profile was removed and re-created with a new id.
      resolvedId = 'agent-new'
      const result = await runAsync(['--player', 'mary', 'chat', 'g1', '--message', 'hi'], env(mock.url))
      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toContain('new profile with fresh ratings')

      const config = JSON.parse(await ok(['config', '--player', 'mary'], env(mock.url)))
      expect(config.identity.id).toBe('agent-new')
    } finally {
      mock.server.close()
    }
  })

  it('a 401 on a stored profile token refreshes once through the main account and retries', async () => {
    let chatCalls = 0
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') {
        const isFirst = mock === undefined // placeholder, replaced below
        void isFirst
        json(res, 200, { id: 'agent-1', name: 'mary', token: 'fresh-token', created: false })
        return
      }
      if (req.url?.endsWith('/chat')) {
        chatCalls++
        if (req.auth !== 'Bearer fresh-token') {
          json(res, 401, { error: 'Invalid or expired token' })
          return
        }
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))
      // Seed a stale stored profile token via a separate mock.
      const seed = await startMockServer((req, res) => {
        if (req.url === '/api/agents/resolve') {
          json(res, 200, { id: 'agent-1', name: 'mary', token: 'stale-token', created: false })
          return
        }
        if (req.url?.endsWith('/chat')) {
          json(res, 200, { ok: true })
          return
        }
        json(res, 404, { error: 'not found' })
      })
      await ok(['--player', 'mary', 'chat', 'g1', '--message', 'seed'], env(seed.url))
      seed.server.close()

      const out = await ok(['--player', 'mary', 'chat', 'g1', '--message', 'hello'], env(mock.url))
      expect(out).toContain('"ok":true')
      expect(chatCalls).toBe(2) // 401 then retry with refreshed token
      const resolveReq = mock.requests.find((r) => r.url === '/api/agents/resolve')
      expect(resolveReq!.auth).toBe('Bearer main-token')
    } finally {
      mock.server.close()
    }
  })

  it('match defaults to Social and resolves the player', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') {
        json(res, 201, { id: 'agent-1', name: 'mary', token: 'profile-token', created: true })
        return
      }
      if (req.url === '/api/matchmaking/queue') {
        json(res, 200, { queueId: 'q1', matched: true, gameId: 'g1' })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))
      const out = await ok(['match'], env(mock.url, { PROMPTED_PLAYER: 'mary' }))
      expect(out).toContain('"gameId":"g1"')
      const resolveReq = mock.requests.find((r) => r.url === '/api/agents/resolve')
      expect((resolveReq!.body as { createIfMissing: boolean }).createIfMissing).toBe(true)
      const queueReq = mock.requests.find((r) => r.url === '/api/matchmaking/queue')
      expect(queueReq!.auth).toBe('Bearer profile-token')
      expect((queueReq!.body as { mode: string }).mode).toBe('lab')
      expect((queueReq!.body as { category: string }).category).toBe('social')
    } finally {
      mock.server.close()
    }
  })

  it('match --chess and --poker send their categories', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') {
        json(res, 200, { id: 'agent-1', name: 'mary', token: 'profile-token', created: false })
        return
      }
      if (req.url === '/api/matchmaking/queue') {
        json(res, 200, { queueId: 'q1', matched: true, gameId: 'g1' })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))
      await ok(['--player', 'mary', 'match', '--chess'], env(mock.url))
      await ok(['--player', 'mary', 'match', '--poker'], env(mock.url))
      const queueRequests = mock.requests.filter((request) => request.url === '/api/matchmaking/queue')
      expect(queueRequests.map(request => (request.body as { category: string }).category)).toEqual(['chess', 'poker'])
    } finally {
      mock.server.close()
    }
  })

  it('leaderboard --category requests the category ladder', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/leaderboard?mode=lab&category=social') {
        json(res, 200, { leaderboard: [], category: 'social', mode: 'lab' })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const result = await ok(['leaderboard', '--category', 'social'], env(mock.url))
      expect(result).toContain('"category":"social"')
    } finally {
      mock.server.close()
    }
  })

  it('leaderboard --format text renders a readable table', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/leaderboard?mode=lab&type=texas-holdem') {
        json(res, 200, {
          leaderboard: [{
            name: 'hughmann',
            ownerName: 'Faltum',
            rating: 1205,
            gamesPlayed: 1,
            gamesWon: 1,
            completionRate: 1,
          }],
          gameType: 'texas-holdem',
          mode: 'lab',
        })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const result = await ok(['leaderboard', '--format', 'text'], env(mock.url))
      expect(result).toContain('texas-holdem (lab)')
      expect(result).toContain('Player')
      expect(result).toContain('hughmann <Faltum>')
      expect(result).toContain('1205')
      expect(result).toContain('100%')
      expect(result).not.toContain('"leaderboard"')
    } finally {
      mock.server.close()
    }
  })

  it('read commands render useful --format text output', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games') {
        json(res, 200, {
          games: [{
            id: 'g1',
            type: 'coup',
            mode: 'lab',
            status: 'active',
            maxPlayers: 4,
            players: [
              { name: 'mary', ownerName: 'Faltum' },
              { name: 'basho', ownerName: 'Faltum' },
            ],
            createdAt: '2026-06-14T12:30:00.000Z',
          }],
        })
        return
      }
      if (req.url === '/api/me') {
        json(res, 200, {
          id: 'u1',
          name: 'Faltum',
          kind: 'standard',
          createdAt: '2026-06-01T10:00:00.000Z',
          agentActive: false,
          labActivity: {
            activeCount: 1,
            limit: 4,
            profiles: [{
              id: 'p1',
              name: 'mary',
              active: true,
              activityType: 'active_game',
              activityId: 'g1',
            }],
          },
        })
        return
      }
      if (req.url === '/api/agents') {
        json(res, 200, {
          agents: [{
            id: 'p1',
            name: 'mary',
            ownerUserId: 'u1',
            createdAt: '2026-06-01T10:00:00.000Z',
            active: true,
            activityType: 'active_game',
            activityId: 'g1',
            gamesPlayed: 3,
            ratings: [{
              gameType: 'coup',
              rating: 1210,
              gamesPlayed: 3,
              gamesWon: 2,
            }],
          }],
          totalProfiles: 1,
          activeCount: 1,
          activeLimit: 4,
        })
        return
      }
      if (req.url === '/api/games/g1/events') {
        json(res, 200, {
          events: [{
            eventIndex: 1,
            type: 'game_start',
            userName: null,
            data: {
              players: [{ name: 'mary' }, { name: 'basho' }],
              initialStateJson: 'large-secret-state',
            },
            createdAt: '2026-06-14T12:31:00.000Z',
          }],
        })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))

      const games = await ok(['games', '--format', 'text'], env(mock.url))
      expect(games).toContain('g1')
      expect(games).toContain('mary <Faltum>, basho <Faltum>')
      expect(games).toContain('2/4')

      const me = await ok(['me', '--format', 'text'], env(mock.url))
      expect(me).toContain('Faltum')
      expect(me).toContain('Lab activity')
      expect(me).toContain('1/4')
      expect(me).toContain('active game g1')

      const agents = await ok(['agent', 'list', '--format', 'text'], env(mock.url))
      expect(agents).toContain('Lab profiles: 1 total, 1/4 active')
      expect(agents).toContain('coup 1210 (2W/3G)')

      const events = await ok(['game', 'g1', '--events', '--format', 'text'], env(mock.url))
      expect(events).toContain('game_start')
      expect(events).toContain('2 players')
      expect(events).not.toContain('large-secret-state')
    } finally {
      mock.server.close()
    }
  })

  // ── Play-loop contract ─────────────────────────────────────

  it('wait re-arms past a timeout and returns the actionable decision', async () => {
    let waits = 0
    const mock = await startMockServer((req, res) => {
      if (req.url?.startsWith('/api/games/g1/wait')) {
        waits++
        if (waits === 1) { json(res, 200, { reason: 'timeout', eventId: 0, nextSinceEventId: 0 }); return }
        json(res, 200, { reason: 'your_turn', eventId: 5, nextSinceEventId: 5, state: { legalActions: ['call'] } })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['wait', 'g1', '--since', '0'], env(mock.url, { PROMPTED_USER_ID: 'u1' })))
      expect(out.reason).toBe('your_turn')
      expect(out.actionable).toBe(true)
      expect(out.terminal).toBe(false)
      expect(out.cursor).toBe(5)
      expect(waits).toBe(2) // the timeout was absorbed internally
    } finally {
      mock.server.close()
    }
  })

  it('wait absorbs chat and attaches it as pendingChat on the next decision', async () => {
    let waits = 0
    const mock = await startMockServer((req, res) => {
      if (req.url?.startsWith('/api/games/g1/wait')) {
        waits++
        if (waits === 1) { json(res, 200, { reason: 'chat', eventId: 2, nextSinceEventId: 2, recentChat: [{ from: 'mary', text: 'gl' }] }); return }
        json(res, 200, { reason: 'your_turn', eventId: 5, nextSinceEventId: 5 })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['wait', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' })))
      expect(out.reason).toBe('your_turn')
      expect(out.pendingChat).toEqual([{ from: 'mary', text: 'gl' }])
    } finally {
      mock.server.close()
    }
  })

  it('wait --on-chat return yields on each chat', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url?.startsWith('/api/games/g1/wait')) {
        json(res, 200, { reason: 'chat', eventId: 2, nextSinceEventId: 2, recentChat: [{ text: 'hi' }] })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['wait', 'g1', '--on-chat', 'return'], env(mock.url, { PROMPTED_USER_ID: 'u1' })))
      expect(out.reason).toBe('chat')
      expect(out.actionable).toBe(false)
    } finally {
      mock.server.close()
    }
  })

  it('turn submits then auto-waits, printing the accepted result before the next decision', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/turn') { json(res, 200, { ok: true, nextSinceEventId: 6 }); return }
      if (req.url?.startsWith('/api/games/g1/wait')) { json(res, 200, { reason: 'your_turn', eventId: 8, nextSinceEventId: 8 }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['turn', 'g1', '--action', '{"action":"call"}', '--since', '5'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      const lines = out.split('\n').map((l) => JSON.parse(l))
      expect(lines[0].ok).toBe(true) // accepted-turn result, printed first
      expect(lines[1].reason).toBe('your_turn') // next decision after auto-wait
      // auto-wait started from the accepted result's cursor (6), not --since (5)
      const waitReq = mock.requests.find((r) => r.url?.startsWith('/api/games/g1/wait'))
      expect(waitReq!.url).toContain('since_event_id=6')
    } finally {
      mock.server.close()
    }
  })

  it('turn --no-wait returns immediately without waiting', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/turn') { json(res, 200, { ok: true }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['turn', 'g1', '--action', '{"action":"check"}', '--no-wait'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      expect(JSON.parse(out).ok).toBe(true)
      expect(mock.requests.some((r) => r.url?.startsWith('/api/games/g1/wait'))).toBe(false)
    } finally {
      mock.server.close()
    }
  })

  it('turn on an illegal move returns a structured envelope with legalActions (exit 0)', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/turn') { json(res, 400, { error: 'illegal move', legalActions: ['fold', 'call'] }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['turn', 'g1', '--action', '{"action":"raise"}'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      const parsed = JSON.parse(out)
      expect(parsed.ok).toBe(false)
      expect(parsed.errorClass).toBe('illegal_action')
      expect(parsed.retryable).toBe(false)
      expect(parsed.cursorUnchanged).toBe(true)
      expect(parsed.legalActions).toEqual(['fold', 'call'])
    } finally {
      mock.server.close()
    }
  })

  it('turn on a stale "not your turn" 400 re-waits for the real next decision instead of surfacing illegal_action', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/turn') { json(res, 400, { error: 'Not your turn', code: 'stale_turn' }); return }
      if (req.url?.startsWith('/api/games/g1/wait')) { json(res, 200, { reason: 'your_turn', eventId: 9, nextSinceEventId: 9 }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['turn', 'g1', '--action', '{"action":"bid","quantity":2,"face":3}', '--since', '5'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      const parsed = JSON.parse(out)
      expect(parsed.reason).toBe('your_turn') // recovered the real next decision
      expect(parsed.actionable).toBe(true)
      // re-waited from the cursor it tried to act on (--since 5), not a fresh 0
      const waitReq = mock.requests.find((r) => r.url?.startsWith('/api/games/g1/wait'))
      expect(waitReq!.url).toContain('since_event_id=5')
    } finally {
      mock.server.close()
    }
  })

  it('turn --no-wait on a stale 400 (no code, no legalActions) returns a retryable stale_turn envelope and does not re-wait', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/turn') { json(res, 400, { error: 'Not your turn' }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['turn', 'g1', '--action', '{"action":"liar"}', '--no-wait'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      const parsed = JSON.parse(out)
      expect(parsed.ok).toBe(false)
      expect(parsed.errorClass).toBe('stale_turn') // absence of legalActions is the discriminator
      expect(parsed.retryable).toBe(true)
      expect(mock.requests.some((r) => r.url?.startsWith('/api/games/g1/wait'))).toBe(false)
    } finally {
      mock.server.close()
    }
  })

  it('wait --brief caps bulky *History arrays in state while preserving legalActions and player ids', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url?.startsWith('/api/games/g1/wait')) {
        json(res, 200, {
          reason: 'your_turn', eventId: 3, nextSinceEventId: 3,
          state: {
            legalActions: [{ action: 'liar' }],
            currentBid: { quantity: 2, face: 3 },
            players: [{ id: 'p-abc' }, { id: 'p-def' }],
            roundHistory: [{ r: 1 }, { r: 2 }, { r: 3 }],
          },
        })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['wait', 'g1', '--brief'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      const parsed = JSON.parse(out)
      expect(parsed.state.roundHistory).toEqual([{ r: 3 }]) // capped to last entry
      expect(parsed.state.roundHistoryTruncated).toBe(true)
      expect(parsed.state.legalActions).toEqual([{ action: 'liar' }]) // preserved
      expect(parsed.state.players).toEqual([{ id: 'p-abc' }, { id: 'p-def' }]) // ids preserved (unlike --format text)
      expect(parsed.state.currentBid).toEqual({ quantity: 2, face: 3 })
    } finally {
      mock.server.close()
    }
  })

  it('warns loudly on stderr (keeping stdout machine-clean) when the server auto-played a missed turn', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url?.startsWith('/api/games/g1/wait')) {
        json(res, 200, {
          reason: 'your_turn', eventId: 3, nextSinceEventId: 3,
          missedTurns: [{ action: 'check', summary: 'Turn timed out, auto-played: check', defaultPolicy: 'auto_check' }],
          state: { legalActions: [] },
        })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const result = await runAsync(['wait', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toContain('you were auto-played: check')
      expect(result.stderr).toContain('auto_check')
      expect(JSON.parse(result.stdout).reason).toBe('your_turn') // stdout stays clean JSON
    } finally {
      mock.server.close()
    }
  })

  it('warns on stderr when the server granted a grace extension, and passes timeoutStrikes through', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url?.startsWith('/api/games/g1/wait')) {
        json(res, 200, {
          reason: 'your_turn', eventId: 4, nextSinceEventId: 4,
          graceExtensions: [{ eventIndex: 4, graceMsAdded: 30000, strikesUsed: 1, strikesLeft: 1, summary: 'Turn deadline missed; granted 30s grace (strike 1 of 2).' }],
          timeoutStrikes: { used: 1, max: 2 },
          state: { legalActions: [] },
        })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const result = await runAsync(['wait', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      expect(result.code, result.stderr).toBe(0)
      expect(result.stderr).toContain('grace extension')
      expect(result.stderr).toContain('strike 1/2')
      const parsed = JSON.parse(result.stdout)
      expect(parsed.timeoutStrikes).toEqual({ used: 1, max: 2 }) // reaches the agent in the JSON
    } finally {
      mock.server.close()
    }
  })

  it('turn idempotency key is content-derived and stable across identical retries', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/turn') { json(res, 200, { ok: true }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const e = env(mock.url, { PROMPTED_USER_ID: 'u1' })
      await ok(['turn', 'g1', '--action', '{"action":"call"}', '--since', '5', '--no-wait'], e)
      await ok(['turn', 'g1', '--action', '{"action":"call"}', '--since', '5', '--no-wait'], e)
      const keys = mock.requests.filter((r) => r.url === '/api/games/g1/turn').map((r) => r.idempotencyKey)
      expect(keys).toHaveLength(2)
      expect(keys[0]).toBeTruthy()
      expect(keys[0]).toBe(keys[1]) // same profile|game|cursor|action -> same key
    } finally {
      mock.server.close()
    }
  })

  it('chat idempotency keys differ for identical messages (never deduped)', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/chat') { json(res, 200, { ok: true }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const e = env(mock.url, { PROMPTED_USER_ID: 'u1' })
      await ok(['chat', 'g1', '--message', 'ja'], e)
      await ok(['chat', 'g1', '--message', 'ja'], e)
      const keys = mock.requests.filter((r) => r.url === '/api/games/g1/chat').map((r) => r.idempotencyKey)
      expect(keys[0]).not.toBe(keys[1])
    } finally {
      mock.server.close()
    }
  })

  it('--idempotency-key overrides the derived key', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/turn') { json(res, 200, { ok: true }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['--idempotency-key', 'fixed-123', 'turn', 'g1', '--action', '{"action":"call"}', '--no-wait'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      const turnReq = mock.requests.find((r) => r.url === '/api/games/g1/turn')
      expect(turnReq!.idempotencyKey).toBe('fixed-123')
    } finally {
      mock.server.close()
    }
  })

  it('wait --follow fails fast on a 404 instead of looping forever', async () => {
    const mock = await startMockServer((req, res) => {
      json(res, 404, { error: 'game not found' })
    })
    try {
      const result = await runAsync(['wait', 'g1', '--follow'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      expect(result.code).not.toBe(0)
      expect(result.stderr).toContain('game not found')
      // One request, not an endless retry storm.
      expect(mock.requests.length).toBe(1)
    } finally {
      mock.server.close()
    }
  })

  it('leave is idempotent even when the player is not in the game', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/resign') { json(res, 400, { error: 'not in this game' }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['leave', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' })))
      expect(out.ok).toBe(true)
      expect(out.resigned).toBe(false)
    } finally {
      mock.server.close()
    }
  })

  it('replay emits NDJSON with per-event deltaMs', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/events') {
        json(res, 200, { events: [
          { eventIndex: 1, type: 'game_start', createdAt: '2026-06-14T12:00:00.000Z' },
          { eventIndex: 2, type: 'turn', createdAt: '2026-06-14T12:00:03.000Z' },
        ] })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['replay', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' }))
      const lines = out.split('\n').map((l) => JSON.parse(l))
      expect(lines[0].deltaMs).toBe(0)
      expect(lines[1].deltaMs).toBe(3000)
    } finally {
      mock.server.close()
    }
  })

  it('join is idempotent: already-in-game reports the live state as success', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') { json(res, 200, { id: 'agent-1', name: 'mary', token: 'profile-token', created: false }); return }
      if (req.url === '/api/games/g1/join') { json(res, 409, { error: 'already in this game' }); return }
      if (req.url === '/api/games/g1') { json(res, 200, { id: 'g1', status: 'active' }); return }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'main-token'], env(mock.url))
      const out = JSON.parse(await ok(['--player', 'mary', 'join', 'g1'], env(mock.url)))
      expect(out.status).toBe('active')
    } finally {
      mock.server.close()
    }
  })

  it('whoseturn calls the authoritative seat endpoint', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/seat') {
        json(res, 200, { isYourTurn: true, actionable: true, terminal: false, reason: 'your_turn', currentCursor: 5, legalActions: ['call'] })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['whoseturn', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' })))
      expect(out.isYourTurn).toBe(true)
      expect(out.reason).toBe('your_turn')
      expect(mock.requests.some((r) => r.url === '/api/games/g1/seat')).toBe(true)
    } finally {
      mock.server.close()
    }
  })

  it('resume returns immediately when seat says it is your turn', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/seat') {
        json(res, 200, { isYourTurn: true, actionable: true, terminal: false, reason: 'your_turn', currentCursor: 5 })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['resume', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' })))
      expect(out.isYourTurn).toBe(true)
      expect(mock.requests.some((r) => r.url?.startsWith('/api/games/g1/wait'))).toBe(false)
    } finally {
      mock.server.close()
    }
  })

  it('resume waits from the seat cursor when it is not your turn', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/games/g1/seat') {
        json(res, 200, { isYourTurn: false, actionable: false, terminal: false, reason: 'waiting', currentCursor: 3 })
        return
      }
      if (req.url?.startsWith('/api/games/g1/wait')) {
        json(res, 200, { reason: 'your_turn', eventId: 7, nextSinceEventId: 7 })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = JSON.parse(await ok(['resume', 'g1'], env(mock.url, { PROMPTED_USER_ID: 'u1' })))
      expect(out.reason).toBe('your_turn')
      const waitReq = mock.requests.find((r) => r.url?.startsWith('/api/games/g1/wait'))
      expect(waitReq!.url).toContain('since_event_id=3')
    } finally {
      mock.server.close()
    }
  })

  it('a raw PROMPTED_TOKEN bypasses profile resolution', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/matchmaking/queue') {
        json(res, 200, { queueId: 'q1', matched: true, gameId: 'g1' })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      const out = await ok(['match'], env(mock.url, { PROMPTED_TOKEN: 'raw-profile-token' }))
      expect(out).toContain('"gameId":"g1"')
      expect(mock.requests.some((r) => r.url === '/api/agents/resolve')).toBe(false)
      const queueReq = mock.requests.find((r) => r.url === '/api/matchmaking/queue')
      expect(queueReq!.auth).toBe('Bearer raw-profile-token')
    } finally {
      mock.server.close()
    }
  })

  it('config shows the selected player and stored profiles without printing tokens', async () => {
    const mock = await startMockServer((req, res) => {
      if (req.url === '/api/agents/resolve') {
        json(res, 201, { id: 'agent-1', name: 'mary', token: 'secret-profile-token', created: true })
        return
      }
      if (req.url?.endsWith('/chat')) {
        json(res, 200, { ok: true })
        return
      }
      json(res, 404, { error: 'not found' })
    })
    try {
      await ok(['login', '--token', 'secret-main-token'], env(mock.url))
      await ok(['--player', 'mary', 'chat', 'g1', '--message', 'hi'], env(mock.url))
      const out = await ok(['config', '--player', 'mary'], env(mock.url))
      const parsed = JSON.parse(out)
      expect(parsed.selectedPlayer).toBe('mary')
      expect(parsed.storedLabProfiles).toContain('mary')
      expect(out).not.toContain('secret-profile-token')
      expect(out).not.toContain('secret-main-token')

      const text = await ok(['config', '--player', 'mary', '--format', 'text'], env(mock.url))
      expect(text).toContain('Selected player  mary')
      expect(text).toContain('Stored profiles  mary')
      expect(text).not.toContain('secret-profile-token')
      expect(text).not.toContain('secret-main-token')
    } finally {
      mock.server.close()
    }
  })
})
