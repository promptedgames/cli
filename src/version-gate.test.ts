import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const CLI = resolve(import.meta.dirname, '..', 'dist', 'index.js')
const pkg = JSON.parse(readFileSync(resolve(import.meta.dirname, '..', 'package.json'), 'utf-8')) as {
  version: string
}

function runCli(args: string[], mockFile: string, env: Record<string, string> = {}) {
  return spawnSync('node', ['--import', mockFile, CLI, ...args], {
    encoding: 'utf-8',
    timeout: 5_000,
    env: {
      ...process.env,
      ...env,
      PROMPTED_TOKEN: '',
      PROMPTED_USER_ID: '',
    },
  })
}

describe('CLI version gate behavior', () => {
  it('sends prompted-cli version in User-Agent', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'prompted-cli-test-'))
    const captureFile = resolve(tempDir, 'capture.json')
    const mockFile = resolve(tempDir, 'mock-fetch.mjs')
    writeFileSync(mockFile, `
import { writeFileSync } from 'node:fs'

globalThis.fetch = async (_url, options = {}) => {
  const headers = options.headers ?? {}
  const userAgent = headers['User-Agent'] ?? headers['user-agent'] ?? ''
  writeFileSync(process.env.MOCK_CAPTURE_FILE, JSON.stringify({ userAgent }))
  return new Response(JSON.stringify({ status: 'ok' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  })
}
`, 'utf-8')
    try {
      const result = runCli(['health', '--host', 'https://example.test'], mockFile, {
        MOCK_CAPTURE_FILE: captureFile,
      })
      const capture = JSON.parse(readFileSync(captureFile, 'utf-8')) as { userAgent: string }
      expect(result.status).toBe(0)
      expect(capture.userAgent).toBe(`prompted-cli/${pkg.version}`)
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })

  it('fails with update guidance on 426 cli_version_too_old', () => {
    const tempDir = mkdtempSync(resolve(tmpdir(), 'prompted-cli-test-'))
    const mockFile = resolve(tempDir, 'mock-fetch.mjs')
    writeFileSync(mockFile, `
globalThis.fetch = async () => {
  return new Response(JSON.stringify({
    error: 'cli_version_too_old',
    message: 'Your Prompted CLI version is too old. Please update.',
    minimumVersion: '0.1.1',
    currentVersion: '0.1.0',
    updateCommand: 'npm i -g @promptedgames/cli',
  }), {
    status: 426,
    headers: { 'Content-Type': 'application/json' },
  })
}
`, 'utf-8')
    try {
      const result = runCli(['health', '--host', 'https://example.test'], mockFile, { CI: '1' })
      expect(result.status).toBe(1)
      expect(result.stderr).toContain('Minimum required: 0.1.1')
      expect(result.stderr).toContain('npm i -g @promptedgames/cli')
    } finally {
      rmSync(tempDir, { recursive: true, force: true })
    }
  })
})
