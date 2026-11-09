import type { Api, Provider } from '@earendil-works/pi-ai'
import { DynamicBorder, type Theme } from '@earendil-works/pi-coding-agent'
import { Container, Input, type SettingItem, SettingsList, type SettingsListTheme, Spacer, Text, truncateToWidth, visibleWidth } from '@earendil-works/pi-tui'
import { captureVirtualModelTemplate } from '../src/virtual.ts'
import type { VirtualProviderConfig } from '../src/types.ts'

// /vprovider editor, loaded on first use so idle startup never pulls the TUI
// component graph. Ids compose into scheduler ids and backend account ids via
// '::' separators.
const VIRTUAL_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/i

interface SettingsListInternals {
  readonly searchEnabled: boolean
  readonly searchInput: { render(width: number): string[] } | undefined
  readonly theme: SettingsListTheme
  readonly selectedIndex: number
  getDisplayItems(): SettingItem[]
  getVisibleRange(displayItems: SettingItem[]): { startIndex: number; endIndex: number }
  addHintLine(lines: string[], width: number): void
}

// SettingsList caps the label column at 36 characters, so rows misalign once
// a label runs longer; this variant sizes the value column to the longest
// label actually displayed instead.
class DynamicColumnSettingsList extends SettingsList {
  override render(width: number): string[] {
    const internal = this as unknown as SettingsListInternals
    const lines: string[] = []
    if (internal.searchEnabled && internal.searchInput) {
      lines.push(...internal.searchInput.render(width))
      lines.push('')
    }
    const displayItems = internal.getDisplayItems()
    if (displayItems.length === 0) {
      lines.push(truncateToWidth(internal.theme.hint('  No matching models'), width))
      internal.addHintLine(lines, width)
      return lines
    }
    const maxLabelWidth = Math.max(...displayItems.map(item => visibleWidth(item.label)))
    const { startIndex, endIndex } = internal.getVisibleRange(displayItems)
    for (let index = startIndex; index < endIndex; index++) {
      const item = displayItems[index]!
      const selected = index === internal.selectedIndex
      const prefix = selected ? internal.theme.cursor : '  '
      const labelPadded = item.label + ' '.repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)))
      const separator = '  '
      const valueMaxWidth = Math.max(0, width - visibleWidth(prefix) - maxLabelWidth - separator.length - 2)
      const valueText = internal.theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ''), selected)
      lines.push(truncateToWidth(prefix + internal.theme.label(labelPadded, selected) + separator + valueText, width))
    }
    if (startIndex > 0 || endIndex < displayItems.length) {
      lines.push(internal.theme.hint(truncateToWidth(`  (${internal.selectedIndex + 1}/${displayItems.length})`, width - 2, '')))
    }
    internal.addHintLine(lines, width)
    return lines
  }
}

export type VirtualEditorOutcome =
  | { kind: 'dismissed' }
  | { kind: 'saved'; draft: VirtualProviderConfig }
  | { kind: 'discarded' }
  | { kind: 'removed'; id: string }

type EditorPage =
  | { kind: 'root' }
  | { kind: 'menu' }
  | { kind: 'provider-picker' }
  | { kind: 'model-picker' }
  | { kind: 'backend' }
  | { kind: 'input'; purpose: 'provider-id' | 'model-id' | 'weight' }

// Single-host editor for the /vprovider flow, styled after the /model and
// hide-providers selectors: every page (root menu, create inputs, editor
// menu, pickers, backend actions) swaps inside one bordered dialog the way
// /fabric settings does, so moving between pages never tears down to the
// chat view.
export class VirtualProviderEditorDialog extends Container {
  private readonly theme: Theme
  private readonly stored: VirtualProviderConfig[]
  private readonly candidates: Provider<Api>[]
  private readonly isProviderIdAvailable: (id: string) => boolean
  private readonly done: (outcome: VirtualEditorOutcome) => void
  private readonly pageContainer = new Container()
  private readonly listTheme: SettingsListTheme
  private draft: VirtualProviderConfig | undefined
  private page: EditorPage
  private inputBackPage: EditorPage = { kind: 'root' }
  private createProviderId: string | undefined
  private chosenProvider: Provider<Api> | undefined
  private activeBackendIndex = 0
  private inputInitial = ''
  private pageError = ''
  private activeList: SettingsList | undefined
  private activeInput: Input | undefined

  constructor(options: {
    theme: Theme
    stored: VirtualProviderConfig[]
    candidates: Provider<Api>[]
    isProviderIdAvailable: (id: string) => boolean
    startDraft: VirtualProviderConfig | undefined
    done: (outcome: VirtualEditorOutcome) => void
  }) {
    super()
    this.theme = options.theme
    this.stored = options.stored
    this.candidates = options.candidates
    this.isProviderIdAvailable = options.isProviderIdAvailable
    this.done = options.done
    this.draft = options.startDraft
    this.page = options.startDraft === undefined ? { kind: 'root' } : { kind: 'menu' }
    this.listTheme = {
      label: (text, selected) => (selected ? this.theme.fg('accent', text) : text),
      value: text => this.theme.fg('muted', text),
      description: text => this.theme.fg('muted', text),
      cursor: this.theme.fg('accent', '→ '),
      hint: text => this.theme.fg('muted', text),
    }
    this.addChild(new DynamicBorder(s => this.theme.fg('border', s)))
    this.addChild(new Spacer(1))
    this.addChild(this.pageContainer)
    this.addChild(new DynamicBorder(s => this.theme.fg('border', s)))
    this.enterPage()
  }

  handleInput(data: string): void {
    if (this.activeInput !== undefined) this.activeInput.handleInput(data)
    else this.activeList?.handleInput(data)
  }

  private goTo(page: EditorPage): void {
    this.page = page
    this.pageError = ''
    this.enterPage()
  }

  private enterPage(): void {
    this.activeList = undefined
    this.activeInput = undefined
    this.pageContainer.clear()
    if (this.page.kind === 'root') this.buildRoot()
    else if (this.page.kind === 'menu') this.buildMenu()
    else if (this.page.kind === 'provider-picker') this.buildProviderPicker()
    else if (this.page.kind === 'model-picker') this.buildModelPicker()
    else if (this.page.kind === 'backend') this.buildBackendActions()
    else this.buildInput()
  }

  // Matches the /model and hide-providers selectors: blank line after the
  // border, flush-left accent title, muted description, then the list.
  private addHeading(title: string, description: string): void {
    this.pageContainer.addChild(new Text(this.theme.fg('accent', this.theme.bold(title)), 0, 0))
    this.pageContainer.addChild(new Text(this.theme.fg('muted', description), 0, 0))
    this.pageContainer.addChild(new Spacer(1))
    if (this.pageError !== '') {
      this.pageContainer.addChild(new Text(this.theme.fg('warning', this.pageError), 0, 0))
      this.pageContainer.addChild(new Spacer(1))
    }
  }

  private attachList(
    title: string,
    description: string,
    items: SettingItem[],
    onSelect: (id: string) => void,
    onCancel: () => void,
  ): void {
    this.addHeading(title, description)
    this.activeList = new DynamicColumnSettingsList(
      items,
      10,
      this.listTheme,
      id => onSelect(id),
      onCancel,
      { enableSearch: true },
    )
    this.pageContainer.addChild(this.activeList)
  }

  private menuItem(id: string, label: string): SettingItem {
    return { id, label, currentValue: '', values: [id] }
  }

  private separatorItem(id: string): SettingItem {
    return { id, label: '', currentValue: '' }
  }

  private buildRoot(): void {
    const items: SettingItem[] = [
      this.menuItem('create', 'Create new virtual provider'),
      ...this.stored.map(config => this.menuItem(`edit-${config.id}`, `Edit ${config.id}`)),
      ...this.stored.map(config => this.menuItem(`delete-${config.id}`, `Delete ${config.id}`)),
    ]
    this.attachList(
      'Virtual providers',
      'Create, edit, or remove virtual providers that map one model across provider models.',
      items,
      id => {
        if (id === 'create') {
          this.createProviderId = undefined
          this.inputBackPage = { kind: 'root' }
          this.inputInitial = 'pooled'
          this.goTo({ kind: 'input', purpose: 'provider-id' })
        } else if (id.startsWith('edit-')) {
          const target = this.stored.find(candidate => candidate.id === id.slice(5))
          if (target === undefined) return
          this.draft = structuredClone(target)
          this.goTo({ kind: 'menu' })
        } else if (id.startsWith('delete-')) {
          this.done({ kind: 'removed', id: id.slice(7) })
        }
      },
      () => this.done({ kind: 'dismissed' }),
    )
  }

  private buildMenu(): void {
    const model = this.draft!.models[0]!
    const items: SettingItem[] = [
      this.menuItem('model-id', `Model id: ${model.id}`),
      this.menuItem('add', 'Add backing provider model'),
      this.separatorItem('sep-top'),
      ...model.backends.map((backend, index) => this.menuItem(
        `backend-${index}`,
        `${index + 1}. ${backend.providerId}`
          + this.theme.fg('dim', ` · ${backend.modelId} · ${backend.enabled === false ? 'disabled' : 'enabled'} · w${backend.weight ?? 1}`),
      )),
      this.separatorItem('sep-bottom'),
      this.menuItem('save', 'Save and apply'),
      this.menuItem('discard', 'Discard changes'),
    ]
    this.attachList(
      `Virtual provider "${this.draft!.id}"`,
      'Enter selects · Esc discards changes.',
      items,
      id => {
        if (id === 'model-id') {
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = model.id
          this.goTo({ kind: 'input', purpose: 'model-id' })
        } else if (id === 'add') {
          this.goTo({ kind: 'provider-picker' })
        } else if (id === 'save') {
          if (model.backends.filter(backend => backend.enabled !== false).length === 0) {
            this.pageError = 'Add at least one enabled backing provider model before saving.'
            this.enterPage()
            return
          }
          // Heal templates for backends stored before capture existed; live
          // resolution still wins at runtime — this covers the snapshot taken
          // before backing providers register.
          for (const backend of model.backends) {
            if (backend.enabled === false || backend.template !== undefined) continue
            const candidate = this.candidates
              .find(provider => provider.id === backend.providerId)
              ?.getModels()
              .find(item => item.id === backend.modelId)
            if (candidate !== undefined) backend.template = captureVirtualModelTemplate(candidate)
          }
          this.done({ kind: 'saved', draft: this.draft! })
        } else if (id === 'discard') {
          this.done({ kind: 'discarded' })
        } else if (id.startsWith('backend-')) {
          this.activeBackendIndex = Number(id.slice(8))
          this.goTo({ kind: 'backend' })
        }
      },
      () => this.done({ kind: 'discarded' }),
    )
  }

  private buildProviderPicker(): void {
    const items: SettingItem[] = this.candidates.map(provider => ({
      id: provider.id,
      label: `${provider.name} (${provider.id})`,
      currentValue: '',
      values: [provider.id],
    }))
    this.attachList(
      'Backing provider',
      'Type to search · Enter picks the provider · Esc goes back.',
      items,
      id => {
        const chosen = this.candidates.find(candidate => candidate.id === id)
        if (chosen === undefined) return
        this.chosenProvider = chosen
        this.goTo({ kind: 'model-picker' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildModelPicker(): void {
    const catalog = this.chosenProvider!.getModels()
    const items: SettingItem[] = catalog.map(candidate => ({
      id: candidate.id,
      label: candidate.id,
      currentValue: candidate.name,
      values: [candidate.id],
    }))
    this.attachList(
      `Backing model for ${this.chosenProvider!.name}`,
      'Type to search · Enter picks the model · Esc goes back.',
      items,
      id => {
        const chosen = catalog.find(candidate => candidate.id === id)
        const providerId = this.chosenProvider?.id
        if (chosen === undefined || providerId === undefined) return
        const model = this.draft!.models[0]!
        if (model.backends.some(backend =>
          backend.providerId === providerId && backend.modelId === chosen.id)) {
          this.pageError = 'That provider model is already a backend.'
          this.enterPage()
          return
        }
        model.backends.push({
          providerId,
          modelId: chosen.id,
          weight: 1,
          // Persisted so the virtual model advertises correct thinking support
          // before backing providers register (pi snapshots models at load).
          template: captureVirtualModelTemplate(chosen),
        })
        this.goTo({ kind: 'menu' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildBackendActions(): void {
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]!
    const items: SettingItem[] = [
      this.menuItem('toggle', backend.enabled === false ? 'Enable' : 'Disable'),
      this.menuItem('weight', 'Set weight'),
      this.menuItem('remove', 'Remove'),
    ]
    this.attachList(
      `${backend.providerId} · ${backend.modelId}`,
      'Enter selects · Esc goes back.',
      items,
      id => {
        if (id === 'toggle') {
          backend.enabled = backend.enabled === false
        } else if (id === 'weight') {
          this.inputBackPage = { kind: 'menu' }
          this.inputInitial = String(backend.weight ?? 1)
          this.goTo({ kind: 'input', purpose: 'weight' })
        } else if (id === 'remove') {
          this.draft!.models[0]!.backends.splice(this.activeBackendIndex, 1)
        } else return
        this.goTo({ kind: 'menu' })
      },
      () => this.goTo({ kind: 'menu' }),
    )
  }

  private buildInput(): void {
    const purpose = this.page.kind === 'input' ? this.page.purpose : 'model-id'
    const title = purpose === 'provider-id'
      ? 'Virtual provider id'
      : purpose === 'model-id' ? 'Virtual model id (shown in /model)' : 'Set weight'
    this.addHeading(title, 'Enter confirms · Esc goes back.')
    const input = new Input()
    input.setValue(this.inputInitial)
    input.onSubmit = () => this.applyInput(purpose, input.getValue())
    input.onEscape = () => this.goTo(this.inputBackPage)
    this.activeInput = input
    this.pageContainer.addChild(input)
    // Pages without a SettingsList footer (the list pages get one from
    // addHintLine) need a trailing blank row so the input does not sit
    // flush against the bottom border.
    this.pageContainer.addChild(new Spacer(1))
  }

  private applyInput(purpose: 'provider-id' | 'model-id' | 'weight', raw: string): void {
    const value = raw.trim()
    if (purpose === 'provider-id') {
      if (!VIRTUAL_ID_PATTERN.test(value) || !this.isProviderIdAvailable(value)) {
        this.pageError = 'Provider id is invalid or already registered.'
        this.inputInitial = value
        this.enterPage()
        return
      }
      this.createProviderId = value
      this.inputInitial = value
      this.goTo({ kind: 'input', purpose: 'model-id' })
      return
    }
    if (purpose === 'model-id') {
      if (!VIRTUAL_ID_PATTERN.test(value)) {
        this.pageError = 'Use letters, numbers, dots, dashes, or underscores for the model id.'
        this.inputInitial = value
        this.enterPage()
        return
      }
      if (this.draft === undefined) {
        this.draft = {
          id: this.createProviderId!,
          label: this.createProviderId!,
          models: [{ id: value, backends: [] }],
        }
        this.pageError = 'Add at least one enabled backing provider model, then choose "Save and apply".'
      } else {
        this.draft.models[0]!.id = value
      }
      this.goTo({ kind: 'menu' })
      return
    }
    const parsed = Number(value)
    const backend = this.draft!.models[0]!.backends[this.activeBackendIndex]
    if (!Number.isInteger(parsed) || parsed < 1 || backend === undefined) {
      this.pageError = 'Weight must be an integer ≥ 1.'
      this.inputInitial = value
      this.enterPage()
      return
    }
    backend.weight = parsed
    this.goTo({ kind: 'menu' })
  }
}

