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
  const outline = (await page.locator('.outline-wrapper').boundingBox())!
  expect(insert.x).toBeGreaterThanOrEqual(outline.x + outline.width - 1)
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

test('the outline handle moved to the leading edge', async ({ page }) => {
  await bootEditor(page)
  await page.keyboard.press('Meta+Shift+O')
  await expect(page.locator('.outline-wrapper')).toBeVisible()

  const strip = (await page.locator('.outline-wrapper .resize-handle').boundingBox())!
  const outline = (await page.locator('.outline-wrapper').boundingBox())!
  // Left edge of the panel, not the right one it used to sit on.
  expect(Math.abs(strip.x - outline.x)).toBeLessThan(2)
})
