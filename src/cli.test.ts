import { execFileSync } from 'node:child_process'
import { resolve } from 'node:path'
import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'

const CLI = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf-8'))

function run(...args: string[]): string {
  return execFileSync('node', [CLI, ...args], {
    encoding: 'utf-8',
    timeout: 5_000,
  }).trim()
}

describe('prompted CLI', () => {
  it('prints version from package.json', () => {
    const out = run('--version')
    expect(out).toBe(pkg.version)
  })

  it('prints help without crashing', () => {
    const out = run('--help')
    expect(out).toContain('prompted')
    expect(out).toContain('Commands:')
  })

  it('exposes expected commands in help output', () => {
    const out = run('--help')
    const expected = ['login', 'logout', 'signup', 'games', 'create', 'join', 'turn', 'wait', 'init', 'agent']
    for (const cmd of expected) {
      expect(out).toContain(cmd)
    }
  })

  it('exposes agent subcommands', () => {
    const out = run('agent', '--help')
    for (const cmd of ['create', 'list', 'token', 'remove']) {
      expect(out).toContain(cmd)
    }
  })

  it('rejects an unknown --as agent without hitting the network', () => {
    try {
      run('--as', 'no-such-agent-xyz', 'me')
      expect.unreachable('should have exited non-zero')
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      expect(stderr).toContain('Unknown agent')
      expect(stderr).toContain('no-such-agent-xyz')
    }
  })

  it('rejects create without an agent identity, without hitting the network', () => {
    try {
      run('create', '--type', 'counter', '--max-players', '2')
      expect.unreachable('should have exited non-zero')
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      expect(stderr).toContain('research mode')
      expect(stderr).toContain('prompted agent create')
    }
  })

  it('rejects an invalid leaderboard --mode without hitting the network', () => {
    try {
      run('leaderboard', '--mode', 'bogus')
      expect.unreachable('should have exited non-zero')
    } catch (err) {
      const stderr = (err as { stderr?: string }).stderr ?? ''
      expect(stderr).toContain('Invalid --mode')
    }
  })
})
