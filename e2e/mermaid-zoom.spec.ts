import { test, expect, type Page } from '@playwright/test'

/**
 * Real-WebKit coverage for the mermaid zoom preview (GitHub issue #89).
 *
 * The zoom button is grafted onto a toolbar that `@moraya/core` builds, and it
 * is armed by a `pointerover` delegate — neither of which a DOM-less unit test
 * can exercise. These specs also pin the interaction contract the feature was
 * designed around: the magnifier opens the modal, and clicking the diagram
 * body still means "edit the source".
 */

const DIAGRAM = ['```mermaid', 'flowchart TD', '  A[Start] --> B[Middle]', '  B --> C[End]', '```'].join('\n')

async function bootDiagram(page: Page) {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.waitForTimeout(1000)
  await page.click('.ProseMirror')
  await page.evaluate((markdown) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', markdown)
    document
      .querySelector('.ProseMirror')!
      .dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }))
  }, DIAGRAM)
  // mermaid is a ~2.4 MB lazy chunk on first use — give it room.
  await page.waitForSelector('.mermaid-preview svg', { timeout: 25_000 })
}

async function openZoom(page: Page) {
  await page.hover('.code-block-wrapper.mermaid-preview-mode')
  const btn = page.locator('.mermaid-zoom-btn')
  await expect(btn).toBeVisible()
  await btn.click()
  await expect(page.locator('.mermaid-zoom-overlay')).toBeVisible()
}

test('hovering a rendered diagram reveals the zoom button', async ({ page }) => {
  await bootDiagram(page)

  // Not present until the pointer reaches the block (it is created lazily).
  await expect(page.locator('.mermaid-zoom-btn')).toHaveCount(0)

  await page.hover('.code-block-wrapper.mermaid-preview-mode')
  await expect(page.locator('.mermaid-zoom-btn')).toBeVisible()
})

test('the three toolbar buttons share one icon language', async ({ page }) => {
  await bootDiagram(page)
  await page.hover('.code-block-wrapper.mermaid-preview-mode')

  const buttons = await page.locator('.code-toolbar-right button').evaluateAll((els) =>
    els.map((el) => {
      const svg = el.querySelector('svg')
      return {
        className: el.className,
        width: svg?.getAttribute('width') ?? null,
        height: svg?.getAttribute('height') ?? null,
        strokeWidth: svg?.getAttribute('stroke-width') ?? null,
        // A visible text label (the old "✏️ Edit") would show up here.
        text: (el.textContent || '').trim(),
        title: el.getAttribute('title'),
      }
    }),
  )

  expect(buttons.map((b) => b.className)).toEqual([
    'mermaid-zoom-btn',
    'mermaid-toggle-btn',
    'code-copy-btn',
  ])
  for (const b of buttons) {
    expect(b.width).toBe('14')
    expect(b.height).toBe('14')
    expect(b.strokeWidth).toBe('2')
    expect(b.text).toBe('')
    expect(b.title).toBeTruthy() // the label moved to the tooltip
  }
})

test('zoom button opens the diagram full-window, fitted and captioned', async ({ page }) => {
  await bootDiagram(page)
  await openZoom(page)

  const overlay = page.locator('.mermaid-zoom-overlay')
  await expect(overlay.locator('svg').first()).toBeVisible()
  await expect(overlay.locator('.zoom-caption')).toHaveText('flowchart')

  // The whole point of the feature: the diagram is bigger than it was inline.
  const inlineWidth = await page
    .locator('.mermaid-preview svg')
    .evaluate((el) => el.getBoundingClientRect().width)
  const zoomedWidth = await overlay
    .locator('.zoom-content svg')
    .evaluate((el) => el.getBoundingClientRect().width)
  expect(zoomedWidth).toBeGreaterThan(inlineWidth)
})

test('+ / − / 1:1 / fit change the zoom level', async ({ page }) => {
  await bootDiagram(page)
  await openZoom(page)

  const percent = page.locator('.zoom-percent')
  const readPercent = async () => Number((await percent.innerText()).replace('%', ''))

  const fitted = await readPercent()

  await page.locator('.zoom-controls button[aria-label]').last().click() // "+"
  expect(await readPercent()).toBeGreaterThan(fitted)

  await page.locator('.zoom-controls button[aria-label]').first().click() // "−"
  expect(await readPercent()).toBe(fitted)

  await page.locator('.zoom-text-btn').last().click() // actual size
  expect(await readPercent()).toBe(100)

  await page.locator('.zoom-text-btn').first().click() // fit
  expect(await readPercent()).toBe(fitted)
})

test('the header caption is centred, clear of the window buttons', async ({ page }) => {
  await bootDiagram(page)
  await openZoom(page)

  // The overlay covers the frameless title bar, and macOS paints its traffic
  // lights over the top-left corner — a leading-aligned caption sits under them.
  const overlay = (await page.locator('.mermaid-zoom-overlay').boundingBox())!
  const caption = (await page.locator('.zoom-caption').boundingBox())!

  const overlayCentre = overlay.x + overlay.width / 2
  const captionCentre = caption.x + caption.width / 2
  expect(Math.abs(captionCentre - overlayCentre)).toBeLessThan(2)
  expect(caption.x).toBeGreaterThan(120)
})

test('Escape closes the zoom preview', async ({ page }) => {
  await bootDiagram(page)
  await openZoom(page)

  await page.keyboard.press('Escape')
  await expect(page.locator('.mermaid-zoom-overlay')).toHaveCount(0)
})

test('clicking the diagram body still opens the source for editing', async ({ page }) => {
  await bootDiagram(page)

  await page.click('.mermaid-preview')

  await expect(page.locator('.mermaid-zoom-overlay')).toHaveCount(0)
  await expect(page.locator('.code-block-wrapper.mermaid-preview-mode')).toHaveCount(0)
  await expect(page.locator('.code-block-pre')).toBeVisible()
})
