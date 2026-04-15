#!/usr/bin/env node
/**
 * End-to-end CLI test against a live server.
 *
 * Requires two pre-existing test users. Configure via env vars:
 *
 *   PROMPTED_SERVER=https://your-server.example.com \
 *   TEST_USER_A=<user-id-1> \
 *   TEST_USER_B=<user-id-2> \
 *   node cli/test/e2e-staging.mjs
 *
 * Verifies:
 * - Basic commands (health, me, config, games, leaderboard)
 * - Game creation, joining, state, turns, chat, resign
 * - Error handling (invalid inputs, auth, status validation)
 * - Format flags (--format json, --format text, --pretty)
 */

import { execSync } from 'node:child_process'

const SERVER = process.env.PROMPTED_SERVER
const USER_A = process.env.TEST_USER_A
const USER_B = process.env.TEST_USER_B

if (!SERVER || !USER_A || !USER_B) {
  console.error('Required env vars: PROMPTED_SERVER, TEST_USER_A, TEST_USER_B')
  process.exit(1)
}

let passed = 0
let failed = 0
const failures = []

function run(userId, args) {
  const env = `PROMPTED_SERVER=${SERVER} PROMPTED_USER_ID=${userId}`
  const cmd = `${env} prompted ${args}`
  try {
    const out = execSync(cmd, { encoding: 'utf-8', timeout: 30000, stdio: ['pipe', 'pipe', 'pipe'] })
    return { ok: true, stdout: out.trim(), stderr: '' }
  } catch (err) {
    return {
      ok: false,
      stdout: (err.stdout ?? '').trim(),
      stderr: (err.stderr ?? '').trim(),
      code: err.status,
    }
  }
}

function runA(args) { return run(USER_A, args) }
function runB(args) { return run(USER_B, args) }

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  \x1b[32m✓\x1b[0m ${name}`)
  } catch (err) {
    failed++
    failures.push({ name, error: err.message })
    console.log(`  \x1b[31m✗\x1b[0m ${name}`)
    console.log(`    ${err.message}`)
  }
}

function assert(condition, msg) {
  if (!condition) throw new Error(msg)
}

function assertJson(str) {
  try { return JSON.parse(str) } catch { throw new Error(`Not valid JSON: ${str.slice(0, 200)}`) }
}

function assertContains(str, sub) {
  assert(str.includes(sub), `Expected output to contain "${sub}", got: ${str.slice(0, 300)}`)
}

// ── Tests ───────────────────────────────────────────────────

console.log('\n\x1b[1m=== CLI E2E Tests (staging) ===\x1b[0m\n')

// ── Basic commands ──────────────────────────────────────────

console.log('\x1b[1mBasic commands\x1b[0m')

test('health returns JSON with status ok', () => {
  const r = runA('health')
  assert(r.ok, `health failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.status === 'ok', `Expected status ok, got ${j.status}`)
  assert(j.db?.connected === true, 'DB not connected')
})

test('me returns user info', () => {
  const r = runA('me')
  assert(r.ok, `me failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.id === USER_A, `Wrong user id: ${j.id}`)
  assert(typeof j.name === 'string' && j.name.length > 0, `Missing name: ${j.name}`)
})

test('config shows authMethod user_id', () => {
  const r = runA('config')
  assert(r.ok, `config failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.authMethod === 'user_id', `Expected authMethod user_id, got ${j.authMethod}`)
  assert(j.server === SERVER, `Wrong server: ${j.server}`)
})

test('games returns game list', () => {
  const r = runA('games')
  assert(r.ok, `games failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(Array.isArray(j.games) || Array.isArray(j), `Expected games array, got keys: ${Object.keys(j)}`)
})

test('games --pretty returns formatted JSON', () => {
  const r = runA('games --pretty')
  assert(r.ok, `games --pretty failed: ${r.stderr}`)
  assert(r.stdout.includes('\n'), 'Expected multi-line pretty output')
})

test('leaderboard returns data', () => {
  const r = runA('leaderboard')
  assert(r.ok, `leaderboard failed: ${r.stderr}`)
  // May be empty array or object, just check it's valid JSON
  assertJson(r.stdout)
})

// ── Status validation ───────────────────────────────────────

console.log('\n\x1b[1mInput validation\x1b[0m')

test('games --status bogus warns about invalid status', () => {
  const r = runA('games --status bogus')
  // Should still succeed (warning on stderr)
  assert(r.ok || r.stderr.includes('unknown status'), `Expected warning, got: stdout=${r.stdout} stderr=${r.stderr}`)
})

test('create with invalid type fails with error message', () => {
  const r = runA('create --type nonexistent --max-players 2')
  assert(!r.ok, 'Expected create to fail')
  // Should have some error output
  assert(r.stdout.length > 0 || r.stderr.length > 0, 'Expected error message')
})

test('create with max-players too high shows specific limit', () => {
  const r = runA('create --type skull --max-players 99')
  assert(!r.ok, 'Expected create to fail')
  const output = r.stdout + r.stderr
  assertContains(output.toLowerCase(), 'most')
})

test('create with max-players too low shows specific limit', () => {
  const r = runA('create --type secret-hitler --max-players 2')
  assert(!r.ok, 'Expected create to fail')
  const output = r.stdout + r.stderr
  assertContains(output.toLowerCase(), 'least')
})

// ── Game lifecycle ──────────────────────────────────────────

console.log('\n\x1b[1mGame lifecycle\x1b[0m')

let gameId

test('create liars-dice game', () => {
  const r = runA('create --type liars-dice --max-players 2')
  assert(r.ok, `create failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.id, 'No game id returned')
  assert(j.status === 'waiting', `Expected waiting, got ${j.status}`)
  gameId = j.id
})

test('game state (JSON default)', () => {
  const r = runA(`game ${gameId}`)
  assert(r.ok, `game failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.status === 'waiting', `Expected waiting, got ${j.status}`)
})

test('game state --format text', () => {
  const r = runA(`game ${gameId} --format text`)
  assert(r.ok, `game --format text failed: ${r.stderr}`)
  // Text mode should not be valid JSON
  let isJson = true
  try { JSON.parse(r.stdout) } catch { isJson = false }
  assert(!isJson, 'Expected text output, got JSON')
})

test('game state --pretty', () => {
  const r = runA(`game ${gameId} --pretty`)
  assert(r.ok, `game --pretty failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(r.stdout.includes('\n'), 'Expected multi-line pretty JSON')
  assert(j.status === 'waiting', `Expected waiting, got ${j.status}`)
})

test('join game as user B', () => {
  const r = runB(`join ${gameId}`)
  assert(r.ok, `join failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.status === 'active', `Expected active after join, got ${j.status}`)
})

test('game state shows active with dice', () => {
  const r = runA(`game ${gameId}`)
  assert(r.ok, `game failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.status === 'active', `Expected active, got ${j.status}`)
  assert(j.state, 'No state in response')
})

test('wait returns JSON with reason and nextSinceEventId', () => {
  const r = runA(`wait ${gameId} --since 0`)
  assert(r.ok, `wait failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.reason, `No reason field: ${Object.keys(j)}`)
  assert(typeof j.nextSinceEventId === 'number', `nextSinceEventId not a number: ${j.nextSinceEventId}`)
})

test('chat in active game', () => {
  const r = runA(`chat ${gameId} --message "e2e test message"`)
  assert(r.ok, `chat failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.ok === true, 'Expected ok:true')
})

// Play a turn
test('submit a turn (bid)', () => {
  // Get state to find whose turn and legal actions
  const stateRes = runA(`game ${gameId}`)
  assert(stateRes.ok, 'Failed to get state')
  const state = assertJson(stateRes.stdout)

  // Determine which user should move
  const activePlayer = state.state?.activePlayerId
  const runner = activePlayer === USER_A ? runA : runB
  const action = JSON.stringify({ action: 'bid', quantity: 1, face: 2 })

  const r = runner(`turn ${gameId} --action '${action}'`)
  assert(r.ok, `turn failed: ${r.stderr} ${r.stdout}`)
})

test('events returns event list', () => {
  const r = runA(`events ${gameId}`)
  assert(r.ok, `events failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.events, 'No events array')
  assert(j.events.length > 0, 'Expected at least one event')
  // Check event shape
  const e = j.events[0]
  assert(e.eventIndex !== undefined, 'Missing eventIndex')
  assert(e.type, 'Missing type')
  assert(e.data !== undefined, 'Missing data')
})

// ── Resign from active game ────────────────────────────────

test('resign from active game', () => {
  const r = runB(`resign ${gameId}`)
  assert(r.ok, `resign failed: ${r.stderr}`)
})

test('game is finished after resign', () => {
  const r = runA(`game ${gameId}`)
  assert(r.ok, `game failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.status === 'finished', `Expected finished, got ${j.status}`)
})

test('chat on finished game is rejected', () => {
  const r = runA(`chat ${gameId} --message "should fail"`)
  assert(!r.ok, 'Expected chat on finished game to fail')
})

// ── Resign from waiting game ───────────────────────────────

console.log('\n\x1b[1mWaiting game resign\x1b[0m')

let waitingGameId

test('create game then resign while waiting', () => {
  const r = runA('create --type skull --max-players 3')
  assert(r.ok, `create failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  waitingGameId = j.id
  assert(j.status === 'waiting', `Expected waiting, got ${j.status}`)
})

test('resign from waiting game cancels it', () => {
  const r = runA(`resign ${waitingGameId}`)
  assert(r.ok, `resign from waiting failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  assert(j.ok === true, 'Expected ok:true')
})

// ── Skull waiting state text ────────────────────────────────

console.log('\n\x1b[1mSkull waiting state\x1b[0m')

test('skull waiting game shows Phase: waiting in text mode', () => {
  const r = runA('create --type skull --max-players 3')
  assert(r.ok, `create failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  const skullId = j.id

  const stateR = runA(`game ${skullId} --format text`)
  assert(stateR.ok, `game text failed: ${stateR.stderr}`)
  assertContains(stateR.stdout, 'Phase: waiting')

  // Cleanup
  runA(`resign ${skullId}`)
})

// ── Liars dice specific fields ──────────────────────────────

console.log('\n\x1b[1mLiars dice fields\x1b[0m')

let ldGameId

test('create and start liars-dice game', () => {
  const r = runA('create --type liars-dice --max-players 2')
  assert(r.ok, `create failed: ${r.stderr}`)
  ldGameId = assertJson(r.stdout).id

  const join = runB(`join ${ldGameId}`)
  assert(join.ok, `join failed: ${join.stderr}`)
})

test('liars-dice state has bidRange field', () => {
  const r = runA(`game ${ldGameId}`)
  assert(r.ok, `game failed: ${r.stderr}`)
  const j = assertJson(r.stdout)
  // bidRange should exist when it's the player's turn
  if (j.state?.legalActions?.length > 0) {
    assert(j.state.bidRange, `Expected bidRange, got keys: ${Object.keys(j.state)}`)
    assert(j.state.bidRange.minQuantity, 'bidRange missing minQuantity')
  }
})

test('cleanup: resign from liars-dice', () => {
  runB(`resign ${ldGameId}`)
})

// ── Auth error handling ─────────────────────────────────────

console.log('\n\x1b[1mAuth errors\x1b[0m')

test('no auth returns error', () => {
  const env = `PROMPTED_SERVER=${SERVER}`
  try {
    execSync(`${env} prompted me`, { encoding: 'utf-8', timeout: 10000, stdio: ['pipe', 'pipe', 'pipe'] })
    throw new Error('Expected command to fail')
  } catch (err) {
    if (err.message === 'Expected command to fail') throw err
    // Should fail with auth-related error
    const output = (err.stdout ?? '') + (err.stderr ?? '')
    assert(output.length > 0, 'Expected error output')
  }
})

// ── Results ─────────────────────────────────────────────────

console.log(`\n\x1b[1m=== Results: ${passed} passed, ${failed} failed ===\x1b[0m`)
if (failures.length > 0) {
  console.log('\n\x1b[31mFailures:\x1b[0m')
  for (const f of failures) {
    console.log(`  - ${f.name}: ${f.error}`)
  }
  process.exit(1)
}
console.log('')
