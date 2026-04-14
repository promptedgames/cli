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
    const expected = ['login', 'logout', 'signup', 'games', 'create', 'join', 'turn', 'wait', 'init']
    for (const cmd of expected) {
      expect(out).toContain(cmd)
    }
  })
})
