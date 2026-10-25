import { spawn, spawnSync } from 'node:child_process'
import { mkdir, mkdtemp, readFile, readdir, rm, rmdir, stat, unlink, utimes, writeFile } from 'node:fs/promises'
import { hostname, tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

const hooks = vi.hoisted(() => ({
  afterRead: undefined as undefined | ((path: unknown) => Promise<void>),
  beforeWrite: undefined as undefined | ((path: unknown) => Promise<void>),
}))
vi.mock('node:fs/promises', async importOriginal => {
  const fs = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...fs,
    readFile: async (...args: Parameters<typeof fs.readFile>) => {
      const value = await fs.readFile(...args)
      await hooks.afterRead?.(args[0])
      return value
    },
    writeFile: async (...args: Parameters<typeof fs.writeFile>) => {
      await hooks.beforeWrite?.(args[0])
      return fs.writeFile(...args)
    },
  }
})
import { withFileLock } from '../src/file-lock.ts'

const directories: string[] = []
afterEach(async () => {
  hooks.afterRead = undefined
  hooks.beforeWrite = undefined
  vi.restoreAllMocks()
  await Promise.all(directories.splice(0).map(path => rm(path, { recursive: true, force: true })))
})
async function fixture() {
  const dir = await mkdtemp(join(tmpdir(), 'multiprovider-lock-'))
  directories.push(dir)
  return { dir, lock: join(dir, 'store.lock') }
}
async function owner(lock: string, name: string, pid = process.pid, host = hostname()) {
  await mkdir(lock, { recursive: true })
  const path = join(lock, name)
  await writeFile(path, JSON.stringify({ host, pid }))
  return path
}
function deadPid() {
  const child = spawnSync(process.execPath, ['-e', ''])
  expect(child.status).toBe(0)
  return child.pid
}

it('releases ownership after success, throws, and cancellation during an operation', async () => {
  const { lock } = await fixture()
  await expect(withFileLock(lock, async () => 42)).resolves.toBe(42)
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  await expect(withFileLock(lock, async () => { throw new Error('probe') })).rejects.toThrow('probe')
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
  const controller = new AbortController()
  controller.abort()
  await expect(withFileLock(lock, async () => 1, { signal: controller.signal })).rejects.toThrow('cancelled')
})

it('never expires a known-live owner, even beyond the old stale threshold', async () => {
  const { lock } = await fixture()
  const path = await owner(lock, 'owner-a.json')
  const old = new Date(Date.now() - 300_000)
  await utimes(path, old, old)
  await utimes(lock, old, old)
  await expect(withFileLock(lock, async () => 1, { timeoutMs: 50 })).rejects.toThrow('timed out')
  expect(JSON.parse(await readFile(path, 'utf8')).pid).toBe(process.pid)
})

it('does not treat remote owners or EPERM as evidence of death', async () => {
  const { lock } = await fixture()
  const path = await owner(lock, 'owner-b.json', deadPid(), `${hostname()}-remote`)
  await expect(withFileLock(lock, async () => 1, { timeoutMs: 25 })).rejects.toThrow('timed out')
  await unlink(path)
  await owner(lock, 'owner-c.json')
  vi.spyOn(process, 'kill').mockImplementation(() => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
  await expect(withFileLock(lock, async () => 1, { timeoutMs: 25 })).rejects.toThrow('timed out')
})

it('cancels a waiter without removing another owner', async () => {
  const { lock } = await fixture()
  const path = await owner(lock, 'owner-d.json')
  const controller = new AbortController()
  const pending = withFileLock(lock, async () => 1, { signal: controller.signal })
  setTimeout(() => controller.abort(), 10)
  await expect(pending).rejects.toThrow('cancelled')
  await expect(stat(path)).resolves.toBeDefined()
})

it('reclaims abandoned initialization but fails closed on legacy files', async () => {
  const { lock } = await fixture()
  await mkdir(lock)
  const old = new Date(Date.now() - 300_000)
  await utimes(lock, old, old)
  await expect(withFileLock(lock, async () => 1)).resolves.toBe(1)
  await writeFile(lock, '')
  await expect(withFileLock(lock, async () => 1)).rejects.toThrow('legacy auth store lock')
  await expect(stat(lock)).resolves.toMatchObject({ size: 0 })
})

it('reclaims interrupted owner writes only after initialization expires', async () => {
  const { lock } = await fixture()
  await mkdir(lock)
  const path = join(lock, 'owner-e.json')
  await writeFile(path, '{')
  await expect(withFileLock(lock, async () => 1, { timeoutMs: 25 })).rejects.toThrow('timed out')
  const old = new Date(Date.now() - 300_000)
  await utimes(path, old, old)
  await expect(withFileLock(lock, async () => 1)).resolves.toBe(1)
})

it('cannot remove a replacement live owner when two waiters reclaim the dead owner', async () => {
  const { lock } = await fixture()
  const oldPath = await owner(lock, 'owner-f.json', deadPid())
  const liveName = 'owner-a1.json'
  hooks.afterRead = async path => {
    if (path !== oldPath) return
    hooks.afterRead = undefined
    // A second reclaimer wins and a new process publishes its owner record.
    await unlink(oldPath)
    await rmdir(lock)
    await owner(lock, liveName)
  }
  await expect(withFileLock(lock, async () => 1, { timeoutMs: 50 })).rejects.toThrow('timed out')
  expect(await readdir(lock)).toEqual([liveName])
})

it('an initializer displaced while paused cannot enter alongside a replacement owner', async () => {
  const { lock } = await fixture()
  let entered = false
  hooks.beforeWrite = async path => {
    if (typeof path !== 'string' || !path.startsWith(lock)) return
    hooks.beforeWrite = undefined
    await rmdir(lock)
    await owner(lock, 'owner-a2.json')
  }
  await expect(withFileLock(lock, async () => { entered = true }, { timeoutMs: 50 })).rejects.toThrow('timed out')
  expect(entered).toBe(false)
  expect(await readdir(lock)).toEqual(['owner-a2.json'])
})

it('recovers when a real lock owner exits without running finally', async () => {
  const { lock } = await fixture()
  const script = `
    import { withFileLock } from ${JSON.stringify(pathToFileURL(resolve('src/file-lock.ts')).href)};
    await withFileLock(${JSON.stringify(lock)}, async () => { process.exit(0) });
  `
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', script])
  expect(child.status, String(child.stderr)).toBe(0)
  expect(await readdir(lock)).toHaveLength(1)
  await expect(withFileLock(lock, async () => 42, { timeoutMs: 1000 })).resolves.toBe(42)
})

it('serializes mutations across independent processes after abandoned-lock recovery', async () => {
  const { dir, lock } = await fixture()
  await owner(lock, 'owner-a3.json', deadPid())
  const counter = join(dir, 'counter')
  await writeFile(counter, '0')
  const script = `
    import { readFile, writeFile } from 'node:fs/promises';
    import { withFileLock } from ${JSON.stringify(pathToFileURL(resolve('src/file-lock.ts')).href)};
    for (let i = 0; i < 8; i++) await withFileLock(${JSON.stringify(lock)}, async () => {
      const n = Number(await readFile(${JSON.stringify(counter)}, 'utf8'));
      await new Promise(r => setTimeout(r, 2));
      await writeFile(${JSON.stringify(counter)}, String(n + 1));
    });
  `
  await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolveChild, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', script], { stdio: ['ignore', 'ignore', 'pipe'] })
    let stderr = ''
    child.stderr.on('data', chunk => { stderr += String(chunk) })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolveChild() : reject(new Error(`child exit ${code}: ${stderr}`)))
  })))
  expect(await readFile(counter, 'utf8')).toBe('48')
  await expect(stat(lock)).rejects.toMatchObject({ code: 'ENOENT' })
}, 15_000)
