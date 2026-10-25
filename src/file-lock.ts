import { mkdir, readdir, readFile, rmdir, stat, unlink, writeFile } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { hostname } from 'node:os'
import { dirname, join } from 'node:path'

const INITIALIZATION_STALE_MS = 120_000
const LOCK_TIMEOUT_MS = 15_000
const OWNER_NAME = /^owner-[0-9a-f-]+\.json$/

function code(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code
}

function cancelled(): Error {
  return new Error('multiprovider: operation cancelled')
}

async function pause(signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw cancelled()
  let abort: (() => void) | undefined
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, 25)
      abort = () => { clearTimeout(timer); reject(cancelled()) }
      signal?.addEventListener('abort', abort, { once: true })
      if (signal?.aborted) abort()
    })
  } finally {
    if (abort !== undefined) signal?.removeEventListener('abort', abort)
  }
}

async function removeEmptyDirectory(path: string): Promise<void> {
  try {
    // Atomic emptiness checking protects a replacement owner's record.
    await rmdir(path)
  } catch (error) {
    if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(code(error) ?? '')) throw error
  }
}

async function removeOwner(path: string, owner: string): Promise<void> {
  try {
    // Owner names are never reused, even when the directory is replaced.
    await unlink(join(path, owner))
  } catch (error) {
    if (code(error) === 'ENOENT') return
    throw error
  }
  await removeEmptyDirectory(path)
}

async function ownerGone(path: string): Promise<boolean> {
  let owner: { host?: unknown; pid?: unknown }
  try {
    owner = JSON.parse(await readFile(path, 'utf8')) as typeof owner
  } catch (error) {
    if (code(error) === 'ENOENT') return false
    if (!(error instanceof SyntaxError)) throw error
    // An interrupted initial write cannot have entered the critical section.
    return Date.now() - (await stat(path)).mtimeMs > INITIALIZATION_STALE_MS
  }
  if (owner === null || owner.host !== hostname() || !Number.isInteger(owner.pid)
    || typeof owner.pid !== 'number' || owner.pid <= 0 || owner.pid > 2_147_483_647) return false
  try {
    process.kill(owner.pid, 0)
    return false
  } catch (error) {
    // EPERM and remote owners are not evidence that a process exited.
    return code(error) === 'ESRCH'
  }
}

async function reclaim(path: string): Promise<void> {
  try {
    const owners = await readdir(path)
    if (owners.length === 0) {
      if (Date.now() - (await stat(path)).mtimeMs > INITIALIZATION_STALE_MS) {
        await removeEmptyDirectory(path)
      }
      return
    }
    for (const owner of owners) {
      if (OWNER_NAME.test(owner) && await ownerGone(join(path, owner))) {
        await removeOwner(path, owner)
      }
    }
  } catch (error) {
    if (code(error) === 'ENOENT') return
    if (code(error) === 'ENOTDIR') {
      throw new Error(`multiprovider: legacy auth store lock at ${path}; stop all Pi processes before removing this file`)
    }
    throw error
  }
}

/** An owner record pins the directory until its operation ends or its process exits. */
export async function withFileLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: { signal?: AbortSignal; timeoutMs?: number } = {},
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 })
  const startedAt = Date.now()
  const owner = `owner-${randomUUID()}.json`
  while (true) {
    if (options.signal?.aborted) throw cancelled()
    let created = false
    try {
      await mkdir(path, { mode: 0o700 })
      created = true
    } catch (error) {
      if (code(error) !== 'EEXIST') throw error
    }
    if (created) {
      let acquired = false
      try {
        await writeFile(join(path, owner), JSON.stringify({ host: hostname(), pid: process.pid }), { flag: 'wx', mode: 0o600 })
        // A reclaimer may remove an empty directory while its initializer is
        // paused. Only the sole published owner may enter the critical section.
        const owners = await readdir(path)
        acquired = owners.length === 1 && owners[0] === owner
      } catch (error) {
        if (code(error) !== 'ENOENT') {
          await removeOwner(path, owner).catch(() => undefined)
          throw error
        }
      }
      if (acquired) {
        try {
          if (options.signal?.aborted) throw cancelled()
          return await operation()
        } finally {
          await removeOwner(path, owner)
        }
      }
      await removeOwner(path, owner)
    } else {
      await reclaim(path)
    }
    if (Date.now() - startedAt >= (options.timeoutMs ?? LOCK_TIMEOUT_MS)) {
      throw new Error(`multiprovider: timed out waiting for auth store lock at ${path}`)
    }
    await pause(options.signal)
  }
}
