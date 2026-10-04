import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

async function loadMultilogoutHandler(agentDir: string) {
  vi.stubEnv('PI_CODING_AGENT_DIR', agentDir)
  const commands = new Map<string, (args: string, ctx: unknown) => Promise<void>>()
  const pi = {
    registerCommand: (name: string, def: { handler: (args: string, ctx: unknown) => Promise<void> }) => {
      commands.set(name, def.handler)
    },
    registerProvider: () => {},
    unregisterProvider: () => {},
    appendEntry: () => {},
    on: () => {},
    events: { emit: () => {}, on: () => () => {} },
  }
  const mod = await import('../extensions/multiprovider.ts')
  await (mod.default as (pi: unknown) => Promise<void>)(pi)
  vi.unstubAllEnvs()
  const handler = commands.get('multilogout')
  if (handler === undefined) throw new Error('multilogout not registered')
  return handler
}

function mockCtx(calls: string[]) {
  return {
    hasUI: true,
    mode: 'tui',
    modelRegistry: { getAll: () => [], getProvider: () => undefined },
    ui: {
      notify: (message: string, level: string) => { calls.push(`notify:${level}:${message}`) },
      select: async (title: string) => { calls.push(`select:${title}`); return undefined },
      confirm: async () => false,
      input: async () => undefined,
    },
  }
}

describe('multilogout handler repro', () => {
  it('notifies when nothing is stored', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multilogout-repro-'))
    try {
      const handler = await loadMultilogoutHandler(dir)
      const calls: string[] = []
      await handler('', mockCtx(calls))
      expect(calls).not.toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })

  it('offers the pooled account for removal', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'multilogout-repro-'))
    try {
      await writeFile(join(dir, 'multiprovider-auth.json'), JSON.stringify({
        version: 1,
        providers: {
          antigravity: {
            providerId: 'antigravity',
            accounts: [{ id: 'a1', label: 'bn', authKind: 'api_key', credential: { type: 'api_key', key: 'k' } }],
          },
        },
      }))
      const handler = await loadMultilogoutHandler(dir)
      const calls: string[] = []
      await handler('', mockCtx(calls))
      expect(calls).not.toEqual([])
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})
