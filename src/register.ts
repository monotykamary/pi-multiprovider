import type { Api } from '@earendil-works/pi-ai'
import type { ExtensionAPI } from '@earendil-works/pi-coding-agent'
import {
  MULTIPROVIDER_REGISTER_EVENT,
  type MultiProviderIntegration,
} from './types.ts'

export function registerMultiProvider<TApi extends Api, TCredentialRef>(
  pi: ExtensionAPI,
  integration: MultiProviderIntegration<TApi, TCredentialRef>,
): void {
  const announce = () => {
    pi.events.emit(MULTIPROVIDER_REGISTER_EVENT, integration)
  }

  announce()
  pi.on('session_start', announce)
}
