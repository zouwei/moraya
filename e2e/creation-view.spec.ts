import { test, expect, type Page } from '@playwright/test'

/**
 * Creation views — standard / reading / writing (issue #88).
 *
 * The reporter could not open links because doing so needs Cmd held, and
 * concluded the editor had no reading mode at all. Reading view drops the
 * modifier; writing view is the other half of the same axis.
 *
 * All of this is behaviour a unit test cannot reach: whether ProseMirror is
 * actually non-editable, whether a plain click scrolls the document, whether a
 * dimmed block really renders dimmed. It needs a real editor and a real
 * pointer.
 */

const DOC = [
  '# Title',
  '',
  'Intro paragraph with [a link](https://example.com) inside it.',
  '',
  'A [jump to the end](#the-end) anchor link.',
  '',
  ...Array.from({ length: 30 }, (_, i) => `Filler paragraph ${i + 1}.\n`),
  '## The end',
  '',
  'Last paragraph.',
  '',
].join('\n')

async function boot(page: Page) {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.waitForTimeout(1000)
  await page.click('.ProseMirror')
  await page.evaluate((doc) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', doc)
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, DOC)
  await page.waitForTimeout(600)
}

/** The status-bar icon that opens the creation-view popover. */
function viewTrigger(page: Page) {
  return page.locator('.statusbar-left button.status-icon[aria-haspopup="menu"]')
}

/** Open the popover and pick a view by its stable data-view id. */
async function pickView(page: Page, view: 'standard' | 'reading' | 'writing') {
  await viewTrigger(page).click()
  await expect(page.locator('.view-menu')).toBeVisible()
  await page.locator(`.view-menu-item[data-view="${view}"]`).click()
  await expect(page.locator('.view-menu')).toHaveCount(0)
  await page.waitForTimeout(400)
}

test('the popover offers exactly the three views and starts on standard', async ({ page }) => {
  await boot(page)
  // Collapsed to a single icon until asked — the status bar is not a place to
  // spend three buttons on a mode that is usually left alone.
  await expect(page.locator('.view-menu')).toHaveCount(0)
  await expect(viewTrigger(page)).toBeVisible()

  await viewTrigger(page).click()
  const items = page.locator('.view-menu-item')
  await expect(items).toHaveCount(3)
  await expect(page.locator('.view-menu-item[data-view="standard"]')).toHaveClass(/active/)
})

test('the trigger sits in the status bar, immediately after the outline icon', async ({ page }) => {
  await boot(page)
  // Asserted by ORDER among the left icons, not by a fixed count: the status
  // bar grows other icons over time (version history already sits there) and
  // the requirement is "after the outline", not "third".
  const order = await page.evaluate(() => {
    const icons = Array.from(document.querySelectorAll('.statusbar-left button.status-icon'))
    return {
      outline: icons.findIndex((b) => b.getAttribute('aria-label')?.match(/outline/i)),
      trigger: icons.findIndex((b) => b.getAttribute('aria-haspopup') === 'menu'),
    }
  })
  expect(order.outline).toBeGreaterThanOrEqual(0)
  expect(order.trigger).toBe(order.outline + 1)

  const outline = (await page.locator('.statusbar-left button.status-icon').nth(order.outline).boundingBox())!
  const trigger = (await viewTrigger(page).boundingBox())!
  expect(trigger.x).toBeGreaterThan(outline.x)
  expect(Math.abs(trigger.y - outline.y)).toBeLessThan(2)
})

test('the trigger reflects the active view, and marks that it is not standard', async ({ page }) => {
  await boot(page)
  await expect(viewTrigger(page)).not.toHaveClass(/active/)
  await expect(viewTrigger(page)).toHaveAttribute('title', /Standard/i)

  await pickView(page, 'reading')
  // A view that removes the caret has to be legible from the chrome alone.
  await expect(viewTrigger(page)).toHaveClass(/active/)
  await expect(viewTrigger(page)).toHaveAttribute('title', /Reading/i)
})

test('the popover closes on a backdrop click and on Escape, without leaving the view', async ({ page }) => {
  await boot(page)
  await pickView(page, 'reading')

  await viewTrigger(page).click()
  await expect(page.locator('.view-menu')).toBeVisible()
  await page.locator('.view-menu-backdrop').click({ position: { x: 5, y: 5 } })
  await expect(page.locator('.view-menu')).toHaveCount(0)
  await expect(page.locator('.editor-wrapper.view-reading')).toHaveCount(1)

  await viewTrigger(page).click()
  await expect(page.locator('.view-menu')).toBeVisible()
  await page.keyboard.press('Escape')
  await expect(page.locator('.view-menu')).toHaveCount(0)
  // One keystroke does one thing: it closed the popover and did NOT also drop
  // the reading view.
  await expect(page.locator('.editor-wrapper.view-reading')).toHaveCount(1)
})

test('reading view makes the document non-editable', async ({ page }) => {
  await boot(page)
  const before = await page.locator('.ProseMirror').innerText()

  await pickView(page, 'reading')
  await expect(page.locator('.editor-wrapper.view-reading')).toHaveCount(1)
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'false')

  await page.locator('.ProseMirror p').first().click()
  await page.keyboard.type('THIS MUST NOT APPEAR')
  await expect(page.locator('.ProseMirror')).toHaveText(before.replace(/\s+/g, ' ').trim().slice(0, 20), {
    useInnerText: true,
    timeout: 2000,
  }).catch(() => { /* exact-text match is brittle; the assertion below is the real one */ })
  expect(await page.locator('.ProseMirror').innerText()).toBe(before)
})

test('reading view hides the editing affordances', async ({ page }) => {
  await boot(page)
  await pickView(page, 'reading')

  // Hovering a paragraph in standard view summons both gutter buttons; in
  // reading view there is nothing to drag and nothing to insert.
  const box = (await page.locator('.ProseMirror p').first().boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await page.waitForTimeout(400)

  await expect(page.locator('.block-drag-handle')).toHaveCount(0)
  await expect(page.locator('.block-insert-handle')).toHaveCount(0)
  await expect(page.locator('.width-handle')).toHaveCount(0)
})

test('reading view pins the rendered surface and says why', async ({ page }) => {
  await boot(page)
  await pickView(page, 'reading')

  const source = page.locator('.mode-switcher .mode-btn', { hasText: 'Source' })
  const split = page.locator('.mode-switcher .mode-btn', { hasText: 'Split' })
  await expect(source).toHaveClass(/disabled/)
  await expect(split).toHaveClass(/disabled/)
  // Still on screen, with the reason in its tooltip, rather than removed.
  await expect(source).toBeVisible()
  await expect(source).toHaveAttribute('title', /reading view/i)

  await source.click()
  await page.waitForTimeout(300)
  await expect(page.locator('.ProseMirror')).toBeVisible() // did not switch away
})

test('reading view restores the surface you came from', async ({ page }) => {
  await boot(page)
  await page.locator('.mode-switcher .mode-btn', { hasText: 'Source' }).click()
  await page.waitForTimeout(400)
  await expect(page.locator('.source-textarea')).toBeVisible()

  await pickView(page, 'reading')
  await expect(page.locator('.ProseMirror')).toBeVisible()

  await pickView(page, 'standard')
  await expect(page.locator('.source-textarea')).toBeVisible()
})

test('a plain click on an anchor link scrolls the document', async ({ page }) => {
  await boot(page)
  await pickView(page, 'reading')

  const scrollTop = () =>
    page.evaluate(() => (document.querySelector('.editor-wrapper') as HTMLElement).scrollTop)
  await page.evaluate(() => { (document.querySelector('.editor-wrapper') as HTMLElement).scrollTop = 0 })
  expect(await scrollTop()).toBe(0)

  // No modifier — this is exactly what issue #88 could not do.
  await page.locator('.ProseMirror a', { hasText: 'jump to the end' }).click()
  await page.waitForTimeout(900) // smooth scroll

  expect(await scrollTop()).toBeGreaterThan(100)
})

test('a plain click on a link does not put the caret in the text', async ({ page }) => {
  await boot(page)
  await pickView(page, 'reading')
  const before = await page.locator('.ProseMirror').innerText()

  await page.locator('.ProseMirror a', { hasText: 'a link' }).click()
  await page.waitForTimeout(400)

  // The external open goes nowhere without a Tauri host, but the click must
  // still be claimed: no edit, no navigation, no caret dropped into the link.
  expect(await page.locator('.ProseMirror').innerText()).toBe(before)
  expect(page.url()).toMatch(/localhost|^about:blank/)
})

test('writing view keeps the document editable', async ({ page }) => {
  await boot(page)
  await pickView(page, 'writing')

  await expect(page.locator('.editor-wrapper.view-writing')).toHaveCount(1)
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')

  await page.locator('.ProseMirror p').first().click()
  await page.keyboard.press('End')
  await page.keyboard.type(' EDITED')
  await expect(page.locator('.ProseMirror')).toContainText('EDITED')
})

test('writing view dims every block but the one holding the caret', async ({ page }) => {
  await boot(page)
  await pickView(page, 'writing')
  await page.locator('.ProseMirror p').first().click()
  await page.waitForTimeout(400)

  await expect(page.locator('.ProseMirror > .moraya-focus-block')).toHaveCount(1)

  const opacities = await page.evaluate(() => {
    const kids = Array.from(document.querySelectorAll('.ProseMirror > *')) as HTMLElement[]
    const focused = kids.find((k) => k.classList.contains('moraya-focus-block'))!
    const other = kids.find((k) => !k.classList.contains('moraya-focus-block'))!
    return {
      focused: parseFloat(getComputedStyle(focused).opacity),
      other: parseFloat(getComputedStyle(other).opacity),
    }
  })
  expect(opacities.focused).toBe(1)
  expect(opacities.other).toBeLessThan(0.6)
})

test('the focus mark follows the caret between blocks', async ({ page }) => {
  await boot(page)
  await pickView(page, 'writing')

  await page.locator('.ProseMirror p').first().click()
  await page.waitForTimeout(300)
  const first = await page.locator('.ProseMirror > .moraya-focus-block').innerText()

  await page.locator('.ProseMirror p').nth(2).click()
  await page.waitForTimeout(300)
  const second = await page.locator('.ProseMirror > .moraya-focus-block').innerText()

  expect(second).not.toBe(first)
  await expect(page.locator('.ProseMirror > .moraya-focus-block')).toHaveCount(1)
})

test('standard view leaves no trace of either view behind', async ({ page }) => {
  await boot(page)
  await pickView(page, 'writing')
  await page.locator('.ProseMirror p').first().click()
  await page.waitForTimeout(300)
  await expect(page.locator('.moraya-focus-block')).toHaveCount(1)

  await pickView(page, 'standard')
  await expect(page.locator('.editor-wrapper.view-writing')).toHaveCount(0)
  await expect(page.locator('.editor-wrapper.view-reading')).toHaveCount(0)
  await expect(page.locator('.moraya-focus-block')).toHaveCount(0)
  await expect(page.locator('.ProseMirror')).toHaveAttribute('contenteditable', 'true')
})

test('Escape leaves a view, and does nothing in standard', async ({ page }) => {
  await boot(page)
  await pickView(page, 'reading')
  await expect(page.locator('.editor-wrapper.view-reading')).toHaveCount(1)

  await page.keyboard.press('Escape')
  await page.waitForTimeout(400)
  await expect(page.locator('.editor-wrapper.view-reading')).toHaveCount(0)
  await expect(viewTrigger(page)).not.toHaveClass(/active/)

  // Already standard: Escape must not disturb anything.
  const before = await page.locator('.ProseMirror').innerText()
  await page.keyboard.press('Escape')
  await page.waitForTimeout(200)
  expect(await page.locator('.ProseMirror').innerText()).toBe(before)
})

test('search highlights survive sharing the decorations prop with the focus mark', async ({ page }) => {
  // The focus mark is a node decoration, and ProseMirror's `decorations` prop
  // holds exactly one value — which search already owned. They compose now;
  // this is the guard that composing did not cost search its highlights.
  await boot(page)
  await page.locator('.ProseMirror').click()
  await page.keyboard.press('Meta+f')
  const input = page.locator('.search-bar .search-input').first()
  await expect(input).toBeVisible({ timeout: 5000 })
  await input.fill('paragraph')
  await page.waitForTimeout(800)
  const standardHits = await page.locator('.search-highlight, .search-highlight-current').count()
  expect(standardHits).toBeGreaterThan(1)

  await pickView(page, 'writing')
  await page.locator('.ProseMirror p').first().click()
  await page.waitForTimeout(500)

  // Both marks present at once, neither having evicted the other.
  expect(await page.locator('.search-highlight, .search-highlight-current').count()).toBe(standardHits)
  await expect(page.locator('.moraya-focus-block')).toHaveCount(1)
})

test('the switcher stays reachable inside every view', async ({ page }) => {
  // Reading removes the caret; if the way out were hidden too, the only exits
  // left would be a keystroke and a menu the reporter already failed to find.
  await boot(page)
  for (const view of ['reading', 'writing', 'standard'] as const) {
    await pickView(page, view)
    await expect(viewTrigger(page)).toBeVisible()
    await viewTrigger(page).click()
    await expect(page.locator(`.view-menu-item[data-view="${view}"]`)).toHaveClass(/active/)
    await page.keyboard.press('Escape')
  }
})
