// Settings-view primitives ported from pi-fabric's /fabric settings pattern:
// a searchable SettingsList root with inline value cycling, drill-in section
// submenus, and select/integer/string input submenus.
import type { Theme } from '@earendil-works/pi-coding-agent'
import {
  Container,
  type Component,
  Input,
  SelectList,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  type SettingItem,
  SettingsList,
  type SettingsListTheme,
  Spacer,
  Text,
} from '@earendil-works/pi-tui'

export const BOOLEANS = ['true', 'false'] as const

const SUBMENU_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
}

export type SettingsSubmenu = (
  currentValue: string,
  done: (selectedValue?: string) => void,
) => Component

// Local mirror of the host's DynamicBorder component, matching pi-fabric: the
// host's global-theme default is unreliable across module realms, so the color
// function is always explicit.
export class DynamicBorder {
  readonly #color: (text: string) => string

  constructor(color: (text: string) => string = (text: string) => text) {
    this.#color = color
  }

  invalidate(): void {
    // No cached state to invalidate.
  }

  render(width: number): string[] {
    return [this.#color('─'.repeat(Math.max(1, width)))]
  }
}

export const settingsListTheme = (theme: Theme): SettingsListTheme => ({
  label: (text, selected) => (selected ? theme.fg('accent', text) : text),
  value: (text, selected) => (selected ? theme.fg('accent', text) : theme.fg('muted', text)),
  description: (text) => theme.fg('dim', text),
  cursor: theme.fg('accent', '→ '),
  hint: (text) => theme.fg('dim', text),
})

export const selectListTheme = (theme: Theme): SelectListTheme => ({
  selectedPrefix: (text) => theme.fg('accent', text),
  selectedText: (text) => theme.fg('accent', text),
  description: (text) => theme.fg('muted', text),
  scrollInfo: (text) => theme.fg('muted', text),
  noMatch: (text) => theme.fg('muted', text),
})

export const formatMs = (ms: number): string =>
  ms < 1_000
    ? `${ms}ms`
    : ms < 60_000
      ? `${ms / 1_000}s`
      : ms < 3_600_000
        ? `${ms / 60_000}m`
        : `${ms / 3_600_000}h`

export const setting = (
  id: string,
  label: string,
  currentValue: string,
  rest: {
    description?: string
    values?: readonly string[]
    submenu?: SettingsSubmenu
  } = {},
): SettingItem => {
  const item: SettingItem = { id, label, currentValue }
  if (rest.description !== undefined) item.description = rest.description
  if (rest.values !== undefined) item.values = [...rest.values]
  if (rest.submenu !== undefined) item.submenu = rest.submenu
  return item
}

// Append › to labels that open a submenu so drill-ins read differently from
// inline value cycling rows.
export const markDrillIn = (items: SettingItem[]): SettingItem[] => {
  for (const item of items) {
    if (item.submenu && !item.label.endsWith('›')) item.label = `${item.label} ›`
  }
  return items
}

export class IntegerInputSubmenu extends Container {
  readonly input: Input
  private readonly validationText: Text

  constructor(
    theme: Theme,
    title: string,
    description: string,
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
    minValue = 0,
  ) {
    super()
    this.addChild(new Text(theme.bold(theme.fg('accent', title)), 0, 0))
    this.addChild(new Spacer(1))
    this.addChild(new Text(theme.fg('muted', description), 0, 0))
    this.addChild(new Spacer(1))

    this.input = new Input()
    this.input.handleInput(currentValue)
    this.input.focused = true
    this.validationText = new Text('', 0, 0)
    this.input.onSubmit = (value) => {
      const normalized = value.trim()
      const parsed = /^\d+$/.test(normalized) ? Number(normalized) : Number.NaN
      if (!Number.isSafeInteger(parsed) || parsed < minValue) {
        this.validationText.setText(
          theme.fg('error', `Enter an integer greater than or equal to ${minValue}.`),
        )
        return
      }
      onSelect(String(parsed))
    }
    this.input.onEscape = onCancel
    this.addChild(this.input)
    this.addChild(this.validationText)
    this.addChild(new Spacer(1))
    this.addChild(new Text(theme.fg('dim', '  Enter to save · Esc to go back'), 0, 0))
  }

  handleInput(data: string): void {
    this.validationText.setText('')
    this.input.handleInput(data)
  }

  render(width: number): string[] {
    this.input.focused = true
    return super.render(width)
  }
}

export class StringInputSubmenu extends Container {
  readonly input: Input

  constructor(
    theme: Theme,
    title: string,
    description: string,
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super()
    this.addChild(new Text(theme.bold(theme.fg('accent', title)), 0, 0))
    this.addChild(new Spacer(1))
    this.addChild(new Text(theme.fg('muted', description), 0, 0))
    this.addChild(new Spacer(1))

    this.input = new Input()
    this.input.handleInput(currentValue)
    this.input.focused = true
    this.input.onSubmit = (value) => onSelect(value.trim())
    this.input.onEscape = onCancel
    this.addChild(this.input)
    this.addChild(new Spacer(1))
    this.addChild(new Text(theme.fg('dim', '  Enter to save · Esc to go back'), 0, 0))
  }

  handleInput(data: string): void {
    this.input.handleInput(data)
  }

  render(width: number): string[] {
    this.input.focused = true
    return super.render(width)
  }
}

export class SelectSubmenu extends Container {
  readonly selectList: SelectList

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    options: SelectItem[],
    currentValue: string,
    onSelect: (value: string) => void,
    onCancel: () => void,
  ) {
    super()
    this.addChild(new Text(theme.bold(theme.fg('accent', title)), 0, 0))
    if (description) {
      this.addChild(new Spacer(1))
      this.addChild(new Text(theme.fg('muted', description), 0, 0))
    }
    this.addChild(new Spacer(1))
    this.selectList = new SelectList(
      options,
      Math.min(options.length, 10),
      selectListTheme(theme),
      SUBMENU_LAYOUT,
    )
    const index = options.findIndex((option) => option.value === currentValue)
    if (index !== -1) this.selectList.setSelectedIndex(index)
    this.selectList.onSelect = (item) => onSelect(item.value)
    this.selectList.onCancel = onCancel
    this.addChild(this.selectList)
    this.addChild(new Spacer(1))
    this.addChild(new Text(theme.fg('dim', '  Enter to select · Esc to go back'), 0, 0))
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data)
  }
}

export class SectionSubmenu extends Container {
  readonly settingsList: SettingsList

  constructor(
    theme: Theme,
    title: string,
    description: string | undefined,
    items: SettingItem[],
    onChange: (id: string, newValue: string) => void,
    onCancel: () => void,
  ) {
    super()
    this.addChild(new Text(theme.bold(theme.fg('accent', title)), 0, 0))
    if (description) {
      this.addChild(new Spacer(1))
      this.addChild(new Text(theme.fg('muted', description), 0, 0))
    }
    this.addChild(new Spacer(1))
    this.settingsList = new SettingsList(
      items,
      Math.min(items.length, 16),
      settingsListTheme(theme),
      onChange,
      onCancel,
      { enableSearch: true },
    )
    this.addChild(this.settingsList)
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data)
  }
}

export const stringInputSubmenu = (
  theme: Theme,
  title: string,
  description: string,
): SettingsSubmenu => (currentValue, done) =>
  new StringInputSubmenu(theme, title, description, currentValue, done, () => done())

export const integerInputSubmenu = (
  theme: Theme,
  title: string,
  description: string,
  minValue = 0,
): SettingsSubmenu => (currentValue, done) =>
  new IntegerInputSubmenu(theme, title, description, currentValue, done, () => done(), minValue)

export const sectionSubmenu = (
  theme: Theme,
  title: string,
  description: string,
  items: SettingItem[],
  persist: (id: string, value: string) => void,
): SettingsSubmenu => (_currentValue, done) =>
  new SectionSubmenu(theme, title, description, markDrillIn(items), persist, () => done())
