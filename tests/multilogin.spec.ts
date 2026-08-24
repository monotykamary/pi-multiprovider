import {
  createProvider,
  type AuthEvent,
  type AuthPrompt,
  type Model,
  type ProviderAuthInteraction,
} from '@earendil-works/pi-ai'
import { describe, expect, it } from 'vitest'
import { loginCredential } from '../src/multilogin.ts'

const model: Model<'test-api'> = {
  id: 'model',
  name: 'Model',
  api: 'test-api',
  provider: 'login-provider',
  baseUrl: 'https://login.invalid',
  reasoning: false,
  input: ['text'],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 1_000,
  maxTokens: 100,
}

const provider = createProvider<'test-api'>({
  id: model.provider,
  name: 'Login Provider',
  auth: {
    apiKey: {
      name: 'Login API key',
      async login(interaction) {
        return {
          type: 'api_key',
          key: await interaction.prompt({ type: 'secret', message: 'Enter API key' }),
        }
      },
      async resolve() {
        return undefined
      },
    },
    oauth: {
      name: 'Login OAuth',
      async login(interaction) {
        interaction.notify({
          type: 'device_code',
          userCode: 'ABCD-1234',
          verificationUri: 'https://login.invalid/device',
        })
        interaction.notify({ type: 'progress', message: 'Waiting for authentication...' })
        const method = await interaction.prompt({
          type: 'select',
          message: 'Select login method:',
          options: [
            { id: 'browser', label: 'Browser OAuth' },
            { id: 'manual', label: 'Manual code' },
          ],
        })
        const code = await interaction.prompt({ type: 'manual_code', message: 'Paste the authorization code' })
        return {
          type: 'oauth',
          refresh: `${method}-refresh`,
          access: code,
          expires: Date.now() + 60_000,
        }
      },
      async refresh(credential) {
        return credential
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

function interaction(events: AuthEvent[], prompts: AuthPrompt[]): ProviderAuthInteraction {
  return {
    signal: new AbortController().signal,
    notify(event) {
      events.push(event)
    },
    async prompt(prompt) {
      prompts.push(prompt)
      if (prompt.type === 'secret') return 'simulated-api-key'
      if (prompt.type === 'select') return 'browser'
      return 'simulated-oauth-code'
    },
  }
}

describe('/multilogin provider auth', () => {
  it('runs API-key and OAuth provider flows through the same interaction contract', async () => {
    const events: AuthEvent[] = []
    const prompts: AuthPrompt[] = []
    await expect(loginCredential(
      { provider, authType: 'api_key' },
      interaction(events, prompts),
    )).resolves.toEqual({ type: 'api_key', key: 'simulated-api-key' })
    await expect(loginCredential(
      { provider, authType: 'oauth' },
      interaction(events, prompts),
    )).resolves.toMatchObject({
      type: 'oauth',
      refresh: 'browser-refresh',
      access: 'simulated-oauth-code',
    })
    expect(prompts.map(prompt => prompt.type)).toEqual(['secret', 'select', 'manual_code'])
    expect(events.map(event => event.type)).toEqual(['device_code', 'progress'])
  })
})
