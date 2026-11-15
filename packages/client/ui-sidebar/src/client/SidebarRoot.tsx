/**
 * Sidebar shell: column geometry and global panel navigation.
 * Collapse is a slide plus crossfade:
 * content freezes at its expanded width (inline style) and fades out in place
 * while the sliding column (AppFrame grid tracks) clips it — nothing reflows
 * mid-slide. At settle the wide-only content unmounts and the upper
 * controls enter the 56px rail from the same horizontal offset (one icon each,
 * same top-down order) on one fade that ends with the slide. The bottom-pinned
 * settings control only fades. The workspace/session browsing region between
 * global panel rows and the foot is the `sidebar.workspaces` registrant's,
 * and the foot holds `sidebar.settings` plus `sidebar.footer.action`; the shell
 * hands them the wide flag (plus an expand request callback for the browser).
 *
 * The column also owns whether the scroll regions nested in it draw a
 * scrollbar at all: the shell tracks the pointer and rebinds ui-theme's
 * scrollbar indirection away while it is elsewhere, so a list the user is not
 * pointing at carries no bar.
 */
import { useEffect, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  FishLogo, IconAppsAddOutlineRegular, IconChevronRightOutlineRegular, IconFolderCloseRegular, IconFolderOpenRegular,
  IconNewChatOutlineMedium, IconNewChatOutlineRegular, IconPanelLeftOutlineRegular,
  isDarwinDesktop, Menu, ShortcutKeys, Toast, Tooltip, writeClipboard,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { InjectFace, PropsRenderSlots, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {
  SidebarPanelActionsOwnerProps, SidebarPanelMetadata, SidebarPanelSection, SidebarRootComponentProps,
  SidebarRootInjected, SidebarSectionOwnerProps,
} from './contract/slots.ts'
import { FIXED_PANEL_ID } from './panel-pins.ts'
import css from './SidebarRoot.module.css'

/** Wide-content unmount delay; matches the 150ms wide-content fade-out. */
const COLLAPSE_SETTLE_MS = 150

/**
 * How long the column's scrollbars stay drawn after the pointer leaves it.
 * The bar is a pointer affordance here, and hiding it on the leave event
 * itself makes it blink out while the pointer is only crossing the column's
 * edge — on the way to the conversation, or around a portalled menu.
 */
const SCROLLBAR_LINGER_MS = 2000

/** Format complete-build metadata for the local brand badge. */
function localBuildVersion(): string | undefined {
  const version = process.env.DSH_CLIENT_VERSION
  if (version === undefined) return undefined
  const commit = process.env.DSH_CLIENT_COMMIT_HASH
  return version
    + (commit === undefined ? '' : `-${commit}`)
    + (process.env.DSH_CLIENT_GIT_DIRTY === 'true' ? '-dirty' : '')
}

type PanelRowProps =
  Pick<SidebarPanelMetadata, 'id' | 'label'>
  & Pick<SidebarSectionOwnerProps, 'wide'>
  & Pick<PropsRuntime<'sidebar'>, 'usePanelInfo'>
  & Pick<InjectFace<SidebarRootInjected>, 'selectPanel' | 'trackEntryClick'>
  & PropsRenderSlots<'sidebar.panellist'>
  & { readonly nested?: boolean }

/** Analytics category of an official panel; other panels are never reported. */
function officialEntry(id: string): 'plugin' | 'cron' | undefined {
  if (id === 'plugins') return 'plugin'
  return id === 'schedules' ? 'cron' : undefined
}

/** Each panel row subscribes only to its own selection state. */
function PanelRow({ id, label, wide, nested = false, usePanelInfo, selectPanel, trackEntryClick, renderSlot }: PanelRowProps) {
  const active = usePanelInfo(info => info.activePanelId === id)
  return (
    <Tooltip label={label} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.panelRow, nested && css.panelRowNested, active && css.panelActive)}
        aria-label={label}
        aria-current={active ? 'page' : undefined}
        onClick={() => {
          const entry = officialEntry(id)
          if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar' })
          selectPanel(id)
        }}
      >
        <span className={css.panelGlyph} aria-hidden="true">
          {renderSlot('sidebar.panellist', { size: wide ? 16 : 18, active }, { only: id })}
        </span>
        {wide && (
          <span className={clsx(css.panelTitle, css.wide)}>
            {label}
          </span>
        )}
      </button>
    </Tooltip>
  )
}

interface PanelNode {
  readonly kind: 'panel'
  readonly key: string
  readonly order: number
  readonly panel: SidebarPanelMetadata
}

interface SectionNode {
  readonly kind: 'section'
  readonly key: string
  readonly order: number
  readonly section: SidebarPanelSection
  readonly panels: SidebarPanelMetadata[]
}

type PanelListNode = PanelNode | SectionNode

/** Project the flat registration order into stable top-level rows and sections. */
function panelListNodes(panels: readonly SidebarPanelMetadata[], unpinned: readonly string[]): PanelListNode[] {
  const nodes = new Map<string, PanelListNode>()
  for (const panel of panels) {
    if (panel.id !== FIXED_PANEL_ID && unpinned.includes(panel.id)) continue
    if (panel.section === undefined) {
      nodes.set(`panel:${panel.id}`, { kind: 'panel', key: `panel:${panel.id}`, order: panel.order, panel })
      continue
    }
    const key = `section:${panel.section.id}`
    const existing = nodes.get(key)
    if (existing?.kind === 'section') {
      existing.panels.push(panel)
    } else {
      nodes.set(key, {
        kind: 'section',
        key,
        order: panel.section.order,
        section: panel.section,
        panels: [panel],
      })
    }
  }
  return [...nodes.values()].sort((a, b) => a.order - b.order)
}

type PanelSectionRowProps = {
  readonly section: SidebarPanelSection
  readonly open: boolean
  readonly wide: boolean
  readonly onToggle: () => void
}

/** A top-level folder row; its children remain absent from the 56px rail. */
function PanelSectionRow({ section, open, wide, onToggle }: PanelSectionRowProps) {
  return (
    <Tooltip label={section.label} delayMs={500} disabled={wide}>
      <button
        type="button"
        className={clsx(css.panelRow, css.sectionRow, open && css.sectionOpen)}
        aria-label={section.label}
        aria-expanded={open}
        onClick={onToggle}
      >
        <span className={css.panelGlyph} aria-hidden="true">
          {open
            ? <IconFolderOpenRegular size={wide ? 16 : 18} />
            : <IconFolderCloseRegular size={wide ? 16 : 18} />}
        </span>
        {wide && (
          <>
            <span className={clsx(css.panelTitle, css.wide)}>{section.label}</span>
            <IconChevronRightOutlineRegular
              className={clsx(css.sectionChevron, open && css.sectionChevronOpen)}
              size={12}
              aria-hidden="true"
            />
          </>
        )}
      </button>
    </Tooltip>
  )
}

type PanelMoreMenuProps =
  Pick<SidebarSectionOwnerProps, 'wide'>
  & Omit<SidebarPanelActionsOwnerProps, 'onDismiss'>
  & PropsRenderSlots<'sidebar.panellist.actions'>
  & Pick<InjectFace<SidebarRootInjected>, 'trackEntryClick'>
  & { readonly label: string }

/** The panel list's More launcher: a panel-row button whose menu rows come from `sidebar.panellist.actions`. */
function PanelMoreMenu({ wide, label, entries, onOpen, onPinnedChange, trackEntryClick, renderSlot }: PanelMoreMenuProps) {
  const [open, setOpen] = useState(false)
  const onDismiss = (): void => { setOpen(false) }
  return (
    <Menu open={open} onClose={onDismiss} portal autoFocus className={css.moreAnchor} listClassName={css.moreMenu}
      anchor={(
        <Tooltip label={label} delayMs={500} disabled={wide}>
          <button type="button" className={css.panelRow} aria-label={label} aria-haspopup="menu" aria-expanded={open}
            onClick={() => {
              trackEntryClick({ menu_name: 'more', position: 'sidebar' })
              setOpen(value => !value)
            }}>
            <span className={css.panelGlyph} aria-hidden="true"><IconAppsAddOutlineRegular size={wide ? 16 : 18} /></span>
            {wide && <span className={clsx(css.panelTitle, css.wide)}>{label}</span>}
          </button>
        </Tooltip>
      )}>
      {renderSlot('sidebar.panellist.actions', { entries, onOpen, onPinnedChange, onDismiss })}
    </Menu>
  )
}

/**
 * Render the sidebar column shell.
 * @param props - composed slot props (runtime share + injected callbacks, contract/slots.ts).
 * @returns the sidebar element tree.
 */
export function SidebarRoot({
  collapsed,
  width,
  startSession,
  toggleSidebar,
  selectPanel,
  setPinned,
  trackEntryClick,
  useRemoteAccess,
  usePanels,
  useEntryPins,
  useEntryActions,
  useShortcuts,
  usePanelInfo,
  t,
  renderSlot,
}: SidebarRootComponentProps) {
  const panels = usePanels(snapshot => snapshot)
  const unpinned = useEntryPins(ids => ids)
  const activePanelId = usePanelInfo(info => info.activePanelId)
  const hasEntryActions = useEntryActions(registered => registered)
  const [openSections, setOpenSections] = useState<ReadonlySet<string>>(() => new Set())
  const seenSections = useRef(new Set<string>())
  useEffect(() => {
    const newlyRegistered = panels
      .map(panel => panel.section)
      .filter((section): section is SidebarPanelSection => section !== undefined
        && !seenSections.current.has(section.id))
    if (newlyRegistered.length === 0) return
    for (const section of newlyRegistered) seenSections.current.add(section.id)
    const defaults = newlyRegistered.filter(section => section.defaultOpen).map(section => section.id)
    if (defaults.length === 0) return
    setOpenSections((current) => {
      const next = new Set(current)
      for (const id of defaults) next.add(id)
      return next
    })
  }, [panels])
  const activeSectionId = panels.find(panel => panel.id === activePanelId)?.section?.id
  useEffect(() => {
    if (activeSectionId === undefined) return
    setOpenSections((current) => {
      if (current.has(activeSectionId)) return current
      const next = new Set(current)
      next.add(activeSectionId)
      return next
    })
  }, [activePanelId, activeSectionId])
  const nodes = panelListNodes(panels, unpinned)
  const shortcut = useShortcuts(rows => rows.find(row => row.id === 'sidebar.left.toggle'))
  const newShortcut = useShortcuts(rows => rows.find(row => row.id === 'session.new'))
  // A page whose access snapshot excludes starting a Session offers no New Session affordance.
  const canStartSession = useRemoteAccess('session/create')
  const toggleLabel = collapsed ? t('toggle.open') : t('toggle.collapse')
  // Wide content stays mounted while the collapse animates (fading via
  // .collapsed .wide), unmounts at settle, and remounts right away on expand.
  const [settled, setSettled] = useState(collapsed)
  useEffect(() => {
    if (!collapsed) { setSettled(false); return }
    const timer = window.setTimeout(() => { setSettled(true) }, COLLAPSE_SETTLE_MS)
    return () => { window.clearTimeout(timer) }
  }, [collapsed])
  const windowsTitlebar = document.documentElement.hasAttribute('data-windows-titlebar')
  const wide = windowsTitlebar ? !collapsed : !collapsed || !settled
  // The Windows titlebar hosts the New Session controls while the sidebar is collapsed.
  const openNewSession = (): void => {
    trackEntryClick({ menu_name: 'new_session', position: windowsTitlebar && collapsed ? 'titlebar' : 'sidebar' })
    startSession()
  }
  const toggleSection = (id: string): void => {
    if (collapsed) toggleSidebar()
    setOpenSections((current) => {
      const next = new Set(current)
      if (collapsed || !next.has(id)) next.add(id)
      else next.delete(id)
      return next
    })
  }
  // The Windows caption menus occupy the strip to the right of these controls
  // (that is what --dsh-windows-menu-start reserves), so a right-side bubble
  // lands under their text. Below the caption is the only clear side.
  const captionTooltipSide = windowsTitlebar ? 'bottom' : 'right'
  // Freeze the content at its expanded width while it fades out (collapsed
  // && wide): the sliding column then clips it instead of reflowing it. The
  // rail layout (.collapsed styles) only applies once the fade settles.
  const lastWideWidth = useRef(width)
  if (!collapsed) lastWideWidth.current = width

  // Rail-in only crossfades a live collapse: a refresh straight into the
  // collapsed state renders the rail statically (no delay-hidden icons).
  const everWide = useRef(!collapsed)
  if (!collapsed) everWide.current = true

  // Scrollbars in the column follow the pointer (.quietBars rebinds them
  // away): drawn while it is inside, and for SCROLLBAR_LINGER_MS after it
  // leaves. A pointer that returns within that window cancels the pending
  // hide rather than restarting from a hidden bar.
  const column = useRef<HTMLDivElement>(null)
  const [pointerInside, setPointerInside] = useState(false)
  const lingerTimer = useRef<number | undefined>(undefined)
  const armLinger = (): void => {
    if (lingerTimer.current !== undefined) return
    lingerTimer.current = window.setTimeout(() => {
      lingerTimer.current = undefined
      setPointerInside(false)
    }, SCROLLBAR_LINGER_MS)
  }
  const cancelLinger = (): void => {
    window.clearTimeout(lingerTimer.current)
    lingerTimer.current = undefined
  }
  // Leaving is decided by the column's BOX, not by DOM containment, and only
  // while the bars are drawn. ui-settings renders its full-viewport panel as a
  // fixed-position DESCENDANT of this column, so a pointer moved onto that
  // panel — or onto the conversation once it closes — fires no `pointerleave`
  // here, and the bars would stay drawn over a column nobody is pointing at.
  // The element's own leave stays as the one signal geometry cannot give: a
  // pointer that leaves the window emits no further moves.
  useEffect(() => {
    if (!pointerInside) return
    const onMove = (event: PointerEvent): void => {
      const rect = column.current?.getBoundingClientRect()
      /* v8 ignore next -- the listener only exists while the column is mounted and revealed. */
      if (rect === undefined) return
      const inside = event.clientX >= rect.left && event.clientX < rect.right
        && event.clientY >= rect.top && event.clientY < rect.bottom
      if (inside) cancelLinger()
      else armLinger()
    }
    document.addEventListener('pointermove', onMove)
    return () => {
      document.removeEventListener('pointermove', onMove)
      cancelLinger()
    }
  }, [pointerInside])

  const buildVersion = localBuildVersion()
  // The local-build fallbacks copy the badge text; the brand button below
  // skips New Session for clicks inside them. The click still bubbles, so
  // document-level outside-click listeners see it.
  // Each successful copy bumps the key so a repeated copy replays the toast.
  const [copiedToast, setCopiedToast] = useState<number | null>(null)
  const copyVersion = (version: string) => (): void => {
    void writeClipboard(version).then((ok) => {
      if (ok) setCopiedToast(seq => (seq ?? 0) + 1)
    })
  }

  const darwinDesktop = isDarwinDesktop()
  // Rail resting state is the whale mark; hovering swaps in the panel icon
  // (the expand affordance, figma sidebar-hover flow). Expanded it is a plain
  // panel icon.
  const toggle = (
    <Tooltip label={toggleLabel} shortcutKeys={shortcut?.keys} delayMs={500} side={captionTooltipSide}>
      <button
        type="button"
        className={clsx(css.iconButton, css.toggle)}
        aria-label={toggleLabel}
        aria-keyshortcuts={shortcut?.aria}
        onClick={() => { toggleSidebar() }}
      >
        {!wide && !windowsTitlebar && (
          <span className={css.railMark} aria-hidden="true">
            {renderSlot('sidebar.brand.mark', { size: 24 }, { fallback: <FishLogo size={24} /> })}
          </span>
        )}
        {/* Rail icons render at 18 (figma rail spec); expanded keeps the glyph-native sizes. */}
        <IconPanelLeftOutlineRegular className={css.panelIcon} size={wide || windowsTitlebar ? 16 : 18} />
        {!wide && renderSlot('sidebar.toggle.badge', {})}
      </button>
    </Tooltip>
  )

  return (
    <div
      ref={column}
      className={clsx(
        css.root, !wide && css.collapsed, !wide && everWide.current && css.railIn,
        collapsed && wide && css.fading, !pointerInside && css.quietBars,
      )}
      style={wide ? { width: collapsed ? lastWideWidth.current : width } : undefined}
      onPointerEnter={() => {
        cancelLinger()
        setPointerInside(true)
      }}
      onPointerLeave={() => { armLinger() }}
    >
      {/* macOS hiddenInset titlebar: the strip shares the row with the
          traffic lights and keeps the toggle at the sidebar's top-right. */}
      {darwinDesktop && <div className={css.topStrip} data-window-drag>{toggle}</div>}
      <div className={css.logoRow} data-window-drag>
        {/* Expanded, the brand doubles as a New Session shortcut while the
            access snapshot allows `session/create` — except on
            macOS, where it stays part of the logo row's window-drag surface
            (a button would subtract itself through the global no-drag rule);
            the collapsed rail's logo is the expand toggle below instead.
            Mouse clicks on the local-build fallbacks copy the version instead. */}
        {wide && (() => {
          const identity = (
            <span className={css.brandIdentity} aria-hidden="true">
              <span className={css.brandMark}>
                {renderSlot('sidebar.brand.mark', { size: 24 }, {
                  fallback: buildVersion === undefined
                    ? <FishLogo size={24} />
                    : <span className={css.copyVersion} data-copy-version onClick={copyVersion(buildVersion)}><FishLogo size={24} /></span>,
                })}
              </span>
              <span className={css.brandName}>
                {renderSlot('sidebar.brand.name', {}, {
                  fallback: buildVersion === undefined
                    ? <span className={css.fallbackBrandName}>{t('brand.localBuild')}</span>
                    : (
                      <span className={clsx(css.localBuildBrand, css.copyVersion)} data-copy-version onClick={copyVersion(buildVersion)}>
                        <span className={css.localBuildTitle}>{t('brand.localBuild')}</span>
                        <span className={css.buildVersion}>{buildVersion}</span>
                      </span>
                    ),
                })}
              </span>
            </span>
          )
          return darwinDesktop || !canStartSession
            ? <span className={clsx(css.brand, css.wide)}>{identity}</span>
            : (
              <button
                type="button"
                className={clsx(css.brand, css.wide)}
                aria-label={t('session.new.label')}
                aria-keyshortcuts={newShortcut?.aria}
                onClick={(event) => {
                  if ((event.target as Element).closest('[data-copy-version]') !== null) return
                  openNewSession()
                }}
              >
                {identity}
              </button>
            )
        })()}
        {!darwinDesktop && toggle}
      </div>

      {/* The label fades before the hover/focus shortcut, including on translucent backgrounds. */}
      {canStartSession && (
        <Tooltip label={t('session.new.label')} shortcutKeys={newShortcut?.keys} delayMs={500} side={captionTooltipSide} disabled={wide}>
          <button
            type="button"
            className={css.newSession}
            aria-label={t('session.new.label')}
            aria-keyshortcuts={newShortcut?.aria}
            onClick={openNewSession}
          >
            <span className={css.newSessionLabelMask}><span className={css.newSessionContent}>
              {wide
                ? <IconNewChatOutlineMedium size={14} />
                : <IconNewChatOutlineRegular size={windowsTitlebar ? 16 : 18} />}
              {wide && <span className={clsx(css.newSessionLabel, css.wide)}>{t('session.new')}</span>}
            </span></span>
            {wide && newShortcut !== undefined && newShortcut.keys.length > 0 && <span className={css.newSessionShortcut} aria-hidden="true">
              <ShortcutKeys keys={newShortcut.keys} />
            </span>}
          </button>
        </Tooltip>
      )}

      {panels.length > 0 && (
        <nav className={css.panelList} aria-label={t('panels.label')}>
          {nodes.map(node => node.kind === 'panel' ? (
            <PanelRow
              key={node.key}
              id={node.panel.id}
              label={node.panel.label}
              wide={wide}
              usePanelInfo={usePanelInfo}
              selectPanel={selectPanel}
              trackEntryClick={trackEntryClick}
              renderSlot={renderSlot}
            />
          ) : (
            <div key={node.key} className={css.panelSection}>
              <PanelSectionRow
                section={node.section}
                open={openSections.has(node.section.id)}
                wide={wide}
                onToggle={() => { toggleSection(node.section.id) }}
              />
              {wide && openSections.has(node.section.id) && (
                <div className={css.panelSectionRows}>
                  {node.panels.map(panel => (
                    <PanelRow
                      key={panel.id}
                      id={panel.id}
                      label={panel.label}
                      wide={wide}
                      nested
                      usePanelInfo={usePanelInfo}
                      selectPanel={selectPanel}
                      trackEntryClick={trackEntryClick}
                      renderSlot={renderSlot}
                    />
                  ))}
                </div>
              )}
            </div>
          ))}
          {hasEntryActions && (
            <PanelMoreMenu
              wide={wide}
              label={t('panels.more')}
              entries={panels.filter(({ id }) => id !== FIXED_PANEL_ID)
                .map(({ id, label }) => ({ id, label, pinned: !unpinned.includes(id), active: id === activePanelId }))}
              onOpen={(id) => {
                const entry = officialEntry(id)
                if (entry !== undefined) trackEntryClick({ menu_name: entry, position: 'sidebar_more' })
                const panel = panels.find(candidate => candidate.id === id)
                if (panel !== undefined) selectPanel(panel.id)
              }}
              onPinnedChange={setPinned}
              trackEntryClick={trackEntryClick}
              renderSlot={renderSlot}
            />
          )}
        </nav>
      )}

      {/* The browsing region fills the column between the controls and the
          foot in both states; its rail icon column rides the same slot. */}
      <div className={css.regionArea}>
        {renderSlot('sidebar.workspaces', {
          wide,
          expandSidebar: () => { if (collapsed) toggleSidebar() },
        })}
      </div>

      {copiedToast !== null && (
        <Toast key={copiedToast} tone="success" text={t('version.copied')} onDone={() => { setCopiedToast(null) }} />
      )}

      {/* Footer actions stack above Settings in both sidebar widths. */}
      <div className={css.footArea}>
        <div className={css.footerActions}>
          {renderSlot('sidebar.footer.action', { wide })}
        </div>
        <div className={css.settingsArea}>
          {renderSlot('sidebar.settings', { wide })}
        </div>
      </div>
    </div>
  )
}
