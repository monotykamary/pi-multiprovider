export class UnknownProviderError extends Error {
  constructor(readonly providerId: string) {
    super(`multiprovider: unknown provider "${providerId}"`)
    this.name = 'UnknownProviderError'
  }
}

export class NoAccountAvailableError extends Error {
  constructor(
    readonly providerId: string,
    readonly nextAvailableAt?: number,
  ) {
    super(nextAvailableAt === undefined
      ? `multiprovider: provider "${providerId}" has no enabled accounts`
      : `multiprovider: provider "${providerId}" has no account available until ${new Date(nextAvailableAt).toISOString()}`)
    this.name = 'NoAccountAvailableError'
  }
}
