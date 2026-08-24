import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  createProvider,
  type Model,
  type OAuthCredential,
} from '@earendil-works/pi-ai'
import { afterEach, describe, expect, it } from 'vitest'
import { MultiAuthStore } from '../src/index.ts'

const temporaryDirectories: string[] = []

async function storeFixture(): Promise<{ directory: string; store: MultiAuthStore }> {
  const directory = await mkdtemp(join(tmpdir(), 'pi-multiprovider-auth-'))
  temporaryDirectories.push(directory)
  return { directory, store: new MultiAuthStore(join(directory, 'multiprovider-auth.json')) }
}

const model: Model<'test-api'> = {
  id: 'model',
  name: 'Model',
  api: 'test-api',
  provider: 'example',
  baseUrl: 'https://example.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map(directory => rm(directory, { recursive: true, force: true })))
})

describe('MultiAuthStore', () => {
  it('persists atomically with mode 0600 and never exposes credential values in public views', async () => {
    const { store } = await storeFixture()
    const first = await store.addAccount('example', {
      label: 'Work',
      credential: { type: 'api_key', key: 'test-secret-one' },
      weight: 3,
    })
    await Promise.all(Array.from({ length: 6 }, (_, index) => store.addAccount('example', {
      label: `Concurrent ${index + 1}`,
      credential: { type: 'api_key', key: `test-secret-${index + 2}` },
    })))
    await store.updatePool('example', {
      policy: 'weighted-round-robin',
      affinity: false,
      includeUpstream: false,
    })

    const pool = await store.getPool('example')
    expect(pool).toMatchObject({
      providerId: 'example',
      policy: 'weighted-round-robin',
      affinity: false,
      includeUpstream: false,
    })
    expect(pool?.accounts).toHaveLength(7)
    expect(pool?.accounts.find(account => account.id === first.id)).toMatchObject({
      label: 'Work',
      weight: 3,
      authKind: 'api-key',
    })
    expect(JSON.stringify(pool)).not.toContain('test-secret')
    expect((await stat(store.path)).mode & 0o777).toBe(0o600)
    expect(await readFile(store.path, 'utf8')).toContain('test-secret-one')
  })

  it('resolves API-key accounts and refreshes one expired OAuth credential once under contention', async () => {
    const { store } = await storeFixture()
    const apiAccount = await store.addAccount('example', {
      label: 'API account',
      credential: { type: 'api_key', key: 'account-api-key', env: { ACCOUNT_REGION: 'west' } },
    })
    const oauthAccount = await store.addAccount('example', {
      label: 'OAuth account',
      credential: {
        type: 'oauth',
        refresh: 'refresh-token',
        access: 'expired-access',
        expires: 0,
      },
    })
    let refreshes = 0
    const provider = createProvider<'test-api'>({
      id: model.provider,
      name: 'Example',
      auth: {
        apiKey: {
          name: 'Example API key',
          async resolve({ credential }) {
            return credential?.key === undefined
              ? undefined
              : {
                  auth: { apiKey: credential.key },
                  ...(credential.env === undefined ? {} : { env: credential.env }),
                  source: 'stored test key',
                }
          },
        },
        oauth: {
          name: 'Example OAuth',
          async login() {
            throw new Error('not used')
          },
          async refresh(credential): Promise<OAuthCredential> {
            refreshes += 1
            return {
              ...credential,
              access: 'refreshed-access',
              expires: Date.now() + 10 * 60_000,
            }
          },
          async toAuth(credential) {
            return { apiKey: credential.access }
          },
        },
      },
      models: [model],
      api: {
        stream() {
          throw new Error('not used')
        },
        streamSimple() {
          throw new Error('not used')
        },
      },
    })
    const signal = new AbortController().signal

    await expect(store.resolveAccount(provider, apiAccount.id, signal)).resolves.toMatchObject({
      auth: { apiKey: 'account-api-key' },
      env: { ACCOUNT_REGION: 'west' },
      source: 'API account · stored test key',
    })
    const resolutions = await Promise.all([
      store.resolveAccount(provider, oauthAccount.id, signal),
      store.resolveAccount(provider, oauthAccount.id, signal),
    ])
    expect(resolutions.map(result => result.auth.apiKey)).toEqual([
      'refreshed-access',
      'refreshed-access',
    ])
    expect(refreshes).toBe(1)
    expect(JSON.stringify(await store.getPool('example'))).not.toContain('refreshed-access')
  })
})
