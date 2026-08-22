import { test, expect, type Page } from '@playwright/test'

/**
 * Real-WebKit guard for the left-gutter block controls.
 *
 * The bug this exists for: the outline used to carry the column-resize strip
 * on its RIGHT edge — the exact lane the floating block buttons occupy. The
 * editor's hover tracker treats anything inside `.outline-wrapper` as "not
 * content" and hides the buttons, so with the outline open, every trip from
 * the text out to a button crossed the strip and the buttons vanished
 * mid-reach. Geometry like that cannot be reproduced in jsdom; it needs a
 * real layout and a real pointer.
 */

async function bootEditor(page: Page) {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.waitForTimeout(1000)
  await page.click('.ProseMirror')
  await page.evaluate(() => {
    const dt = new DataTransfer()
    dt.setData('text/plain', '# Title\n\nFirst paragraph of the document.\n\n## Section\n\nSecond paragraph here.')
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  })
  await page.waitForTimeout(500)
}

/** Hover the middle of the first paragraph and wait for the buttons. */
async function hoverParagraph(page: Page) {
  const para = page.locator('.ProseMirror p').first()
  const box = (await para.boundingBox())!
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
  await expect(page.locator('.block-drag-handle')).toBeVisible()
  await expect(page.locator('.block-insert-handle')).toBeVisible()
  return box
}

test('insert button sits left of the drag handle, both clear of the text', async ({ page }) => {
  await bootEditor(page)
  const paraBox = await hoverParagraph(page)

  const insert = (await page.locator('.block-insert-handle').boundingBox())!
  const drag = (await page.locator('.block-drag-handle').boundingBox())!

  // Order in the gutter: "+" then drag handle, then the text column.
  expect(insert.x + insert.width).toBeLessThanOrEqual(drag.x + 1)
  expect(drag.x + drag.width).toBeLessThanOrEqual(paraBox.x + 1)
  // Vertically aligned with each other and with the block's first line.
  expect(Math.abs(insert.y - drag.y)).toBeLessThan(2)
})

test('the buttons survive the trip out of the text with the outline open', async ({ page }) => {
  await bootEditor(page)

  // Open the outline — this is the configuration where the old resize strip
  // sat between the text and the buttons.
  await page.keyboard.press('Meta+Shift+O')
  await expect(page.locator('.outline-wrapper')).toBeVisible()
  await page.waitForTimeout(300)

  const paraBox = await hoverParagraph(page)
  const insert = (await page.locator('.block-insert-handle').boundingBox())!

  // Walk left, one small step at a time, exactly as a real pointer would —
  // a single jump would skip whatever lies in between.
  const y = paraBox.y + paraBox.height / 2
  const from = paraBox.x + 40
  const to = insert.x + insert.width / 2
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(from + ((to - from) * i) / 12, y)
  }
  await page.waitForTimeout(250) // outlast the 150ms hide delay

  await expect(page.locator('.block-insert-handle')).toBeVisible()
  await expect(page.locator('.block-drag-handle')).toBeVisible()

  // And the buttons must not be sitting on top of the outline's headings.
  // The lane is reserved inside the panel's own width, so the box overlaps —
  // what must not overlap is the text, which stops before the lane.
  const rows = await page.locator('.outline-item').all()
  expect(rows.length).toBeGreaterThan(0)
  for (const row of rows) {
    const rb = (await row.boundingBox())!
    expect(rb.x + rb.width).toBeLessThanOrEqual(insert.x + 1)
  }
})

test('"+" menu turns the block below into a real heading', async ({ page }) => {
  await bootEditor(page)
  const before = await page.locator('.ProseMirror h1').count()

  await hoverParagraph(page)
  await page.locator('.block-insert-handle').click()

  const menu = page.locator('.insert-menu')
  await expect(menu).toBeVisible()
  // Rows carry the markdown they write, which is the point of the menu.
  await expect(menu.locator('.hint').first()).toHaveText('')
  // Selected by data-action, not by label: the dev server has no Tauri IPC,
  // so the locale bundle never loads and rows render their raw i18n key.
  await menu.locator('[data-action="h1"]').click()

  await expect(menu).toBeHidden()
  await expect(page.locator('.ProseMirror h1')).toHaveCount(before + 1)
})

test('bold row inserts sample text that is actually bold and selected', async ({ page }) => {
  await bootEditor(page)
  await hoverParagraph(page)
  await page.locator('.block-insert-handle').click()
  await page.locator('.insert-menu [data-action="bold"]').click()

  const strong = page.locator('.ProseMirror strong')
  await expect(strong).toHaveCount(1)
  // Typing replaces the placeholder and keeps the formatting.
  await page.keyboard.type('done')
  await expect(page.locator('.ProseMirror strong')).toHaveText('done')
})

test('the width handle lives on the right edge of the content box', async ({ page }) => {
  await bootEditor(page)

  const handle = page.locator('.editor-content-area > .width-handle')
  await expect(handle).toHaveCount(1)
  const hb = (await handle.boundingBox())!
  const area = (await page.locator('.editor-content-area').boundingBox())!
  expect(Math.abs(hb.x + hb.width / 2 - (area.x + area.width))).toBeLessThan(4)
})

test('opening the outline does not widen the content box beyond its two columns', async ({ page }) => {
  await bootEditor(page)
  const before = (await page.locator('.editor-content-area').boundingBox())!

  await page.keyboard.press('Meta+Shift+O')
  await expect(page.locator('.outline-wrapper')).toBeVisible()
  await page.waitForTimeout(300)

  const after = (await page.locator('.editor-content-area').boundingBox())!
  const outline = (await page.locator('.outline-wrapper').boundingBox())!
  // Exactly the outline's own width wider — no extra lane bolted on beside
  // it, which is what made the left block look bloated.
  expect(Math.abs(after.width - (before.width + outline.width))).toBeLessThan(2)
})

test('the outline handle moved to the leading edge', async ({ page }) => {
  await bootEditor(page)
  await page.keyboard.press('Meta+Shift+O')
  await expect(page.locator('.outline-wrapper')).toBeVisible()

  const strip = (await page.locator('.outline-wrapper .resize-handle').boundingBox())!
  const outline = (await page.locator('.outline-wrapper').boundingBox())!
  // Left edge of the panel, not the right one it used to sit on.
  expect(Math.abs(strip.x - outline.x)).toBeLessThan(2)
})

/**
 * The buttons mark the block you are WORKING in, so they have to be driven by
 * the caret, not only by the mouse. Each of these was a live defect: the pair
 * stayed beside a heading while the caret sat in the code block below it, a
 * freshly-opened empty line showed nothing at all, and scrolling left them
 * hanging in the viewport while the text slid away underneath.
 */

const LONG_DOC = [
  '# Title', '', 'First paragraph.', '',
  '```swift', 'let numbers = [1, 2, 3]', 'let even = numbers.filter { $0 % 2 == 0 }', '```', '',
  ...Array.from({ length: 40 }, (_, i) => `Filler paragraph ${i + 1}.\n`),
  '',
].join('\n')

async function bootLong(page: Page) {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.waitForTimeout(800)
  await page.click('.ProseMirror')
  await page.evaluate((doc) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', doc)
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, LONG_DOC)
  await page.waitForTimeout(600)
  await scrollTo(page, 0)
}

async function scrollTo(page: Page, top: number) {
  await page.evaluate((t) => {
    ;(document.querySelector('.editor-wrapper') as HTMLElement).scrollTop = t
  }, top)
  await page.waitForTimeout(250)
}

/** Viewport centre of the first rendered text line inside `sel`. */
function firstLineCentre(page: Page, sel: string) {
  return page.evaluate((s) => {
    const el = document.querySelector(s)
    if (!el) return null
    const node = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode()
    if (!node) return null
    const r = document.createRange()
    r.setStart(node, 0)
    r.setEnd(node, Math.min(1, node.textContent!.length))
    const rect = r.getBoundingClientRect()
    return rect.top + rect.height / 2
  }, sel)
}

test('the buttons align with the first line of every block kind', async ({ page }) => {
  await bootLong(page)
  for (const sel of ['.ProseMirror h1', '.ProseMirror p', '.ProseMirror pre']) {
    const box = (await page.locator(sel).first().boundingBox())!
    await page.mouse.move(box.x + 40, box.y + 6)
    await page.waitForTimeout(200)
    const drag = (await page.locator('.block-drag-handle').boundingBox())!
    const line = (await firstLineCentre(page, sel))!
    // A code block's first LINE, not the middle of the whole block — the
    // handle must not float in the centre of a ten-line listing.
    expect(Math.abs(drag.y + drag.height / 2 - line)).toBeLessThan(2)
  }
})

test('the caret drives the buttons when the mouse is elsewhere', async ({ page }) => {
  await bootLong(page)

  await page.locator('.ProseMirror p').first().click()
  await page.mouse.move(4, 4) // park the pointer outside the editor entirely
  await page.waitForTimeout(300)
  const atParagraph = (await page.locator('.block-drag-handle').boundingBox())!

  // Keyboard only: a brand-new empty line must still get the buttons.
  // ArrowDown/Enter rather than End — End scrolls the box to the document
  // end in WebKit, which correctly takes the anchored block off-screen and
  // would be testing the scroll rule, not the caret rule.
  await page.keyboard.press('Enter')
  await page.waitForTimeout(300)
  const atEmptyLine = await page.locator('.block-drag-handle').boundingBox()
  expect(atEmptyLine).not.toBeNull()
  expect(atEmptyLine!.y).toBeGreaterThan(atParagraph.y)

  // Caret inside a code block: the buttons follow it there, and land on the
  // block's first line.
  await page.locator('.ProseMirror pre').first().click()
  await page.mouse.move(4, 4)
  await page.waitForTimeout(300)
  const atCode = (await page.locator('.block-drag-handle').boundingBox())!
  const codeLine = (await firstLineCentre(page, '.ProseMirror pre'))!
  expect(Math.abs(atCode.y + atCode.height / 2 - codeLine)).toBeLessThan(2)
})

test('the buttons stay glued to their block while the page scrolls', async ({ page }) => {
  await bootLong(page)

  // Caret in a known block, pointer parked outside the editor: this is the
  // reported scenario — you scroll and the buttons hang in mid-air while the
  // text they belong to slides away. (With the pointer left over the text,
  // scrolling brings a different block under it and hover re-targets them,
  // which is its own correct behaviour and not what is under test here.)
  const target = page.locator('.ProseMirror p').nth(2)
  await target.click()
  await page.mouse.move(4, 4)
  await page.waitForTimeout(300)

  const handleBefore = (await page.locator('.block-drag-handle').boundingBox())!
  const blockBefore = (await target.boundingBox())!

  await scrollTo(page, 200)

  const handleAfter = (await page.locator('.block-drag-handle').boundingBox())!
  const blockAfter = (await target.boundingBox())!

  const blockMoved = blockAfter.y - blockBefore.y
  const handleMoved = handleAfter.y - handleBefore.y
  expect(Math.abs(blockMoved)).toBeGreaterThan(50) // the page really did scroll
  expect(Math.abs(handleMoved - blockMoved)).toBeLessThan(2) // and they moved together
})

test('the buttons hide when their block scrolls out, and come back', async ({ page }) => {
  await bootLong(page)
  await page.locator('.ProseMirror p').nth(1).click()
  await page.mouse.move(4, 4)
  await page.waitForTimeout(300)
  await expect(page.locator('.block-drag-handle')).toBeVisible()

  await scrollTo(page, 900)
  // Gone rather than floating over the tab bar — they are position: fixed, so
  // nothing else would have clipped them.
  await expect(page.locator('.block-drag-handle')).toHaveCount(0)

  // Back without a keystroke or a mouse move.
  await scrollTo(page, 0)
  await expect(page.locator('.block-drag-handle')).toBeVisible()
})
