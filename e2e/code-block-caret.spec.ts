import { test, expect, type Page } from '@playwright/test'

async function bootCodeBlock(page: Page, lines: string[], language = 'text') {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.locator('.ProseMirror').click()
  await page.evaluate((markdown) => {
    const dt = new DataTransfer()
    dt.setData('text/plain', markdown)
    document.querySelector('.ProseMirror')!.dispatchEvent(
      new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }),
    )
  }, [`\`\`\`${language}`, ...lines, '\`\`\`'].join('\n'))
  await expect(page.locator('.code-block-code')).toHaveText(lines.join('\n'))
}

async function clickCodeLine(page: Page, line: number, xOffset: number) {
  const point = await page.locator('.code-block-code').evaluate((code, args) => {
    const first = document.createRange()
    first.setStart(code.firstChild!, 0)
    first.setEnd(code.firstChild!, 1)
    const rect = first.getBoundingClientRect()
    const lineHeight = parseFloat(getComputedStyle(code.closest('pre')!).lineHeight)
    return { x: rect.left + args.xOffset, y: rect.top + rect.height / 2 + args.line * lineHeight }
  }, { line, xOffset })
  await page.mouse.click(point.x, point.y)
  return page.evaluate(({ x, y }) => (document.elementFromPoint(x, y) as HTMLElement)?.className, point)
}

test('clicking before a long Chinese code line inserts at that line start', async ({ page }) => {
  const lines = [
    '第一行中文内容很长，足以让代码块出现横向滚动，光标仍应准确定位到后续行的行首。'.repeat(2),
    '',
    '第二行中文内容',
  ]
  await bootCodeBlock(page, lines)
  await page.locator('.ProseMirror').evaluate((el) => { (el as HTMLElement).style.fontSize = '26px' })
  expect(await clickCodeLine(page, 2, -8)).toBe('code-block-pre')
  await page.keyboard.type('X')
  await expect(page.locator('.code-block-code')).toHaveText(`${lines[0]}\n\nX${lines[2]}`)
})

test('clicking a later consecutive blank code line inserts there', async ({ page }) => {
  await bootCodeBlock(page, ['第一行文字', '', '第二行文字', '', '', '', '第三行文字'])
  await page.locator('.ProseMirror').evaluate((el) => { (el as HTMLElement).style.fontSize = '26px' })
  expect(await clickCodeLine(page, 5, 16)).toBe('code-block-pre')
  await page.keyboard.type('X')
  await expect(page.locator('.code-block-code')).toHaveText('第一行文字\n\n第二行文字\n\n\nX\n第三行文字')
})

test('blank lines entered with the keyboard remain mouse-addressable', async ({ page }) => {
  await page.goto('/')
  await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
  await page.locator('.ProseMirror').click()
  await page.keyboard.type('```')
  await page.keyboard.press('Enter')
  await expect(page.locator('.code-block-pre')).toBeVisible()
  await page.keyboard.type('第一行文字')
  await page.keyboard.press('Enter')
  await page.keyboard.press('Enter')
  await page.keyboard.type('第二行文字')
  for (let i = 0; i < 4; i++) await page.keyboard.press('Enter')
  await page.keyboard.type('第三行文字')
  await expect(page.locator('.code-block-code')).toHaveText('第一行文字\n\n第二行文字\n\n\n\n第三行文字')

  await page.locator('.ProseMirror').evaluate((el) => { (el as HTMLElement).style.fontSize = '26px' })
  expect(await clickCodeLine(page, 5, 16)).toBe('code-block-pre')
  await page.keyboard.type('X')
  await expect(page.locator('.code-block-code')).toHaveText('第一行文字\n\n第二行文字\n\n\nX\n第三行文字')
})

test('the reported Chinese code block accepts clicks on every line', async ({ page }) => {
  const lines = [
    '图里是一则配特朗普照片的中文帖子，但截图太糊，正文和来源都看不清，我不想靠猜来评价它的观点。',
    '',
    '就这张图而言，配了人物照片，不等于文字内容就可信。涉及他说了什么、做了什么，得看原始报道、发布时间和完整上下文。',
    '',
    '',
    '你发张清晰原图，或者把正文贴出来，我再具体说：哪些是事实、哪些是推测，有没有偷换概念。  ',
  ]
  const original = lines.join('\n')

  for (const line of [0, 1, 2, 3, 4, 5]) {
    await bootCodeBlock(page, lines, '')
    expect(await page.locator('.code-block-code').evaluate((code) => code.textContent)).toBe(original)

    const hit = await clickCodeLine(page, line, lines[line] ? -8 : 16)
    expect(hit).toBe('code-block-pre')

    const caret = await page.locator('.visual-custom-caret').evaluate((element) => {
      const rect = element.getBoundingClientRect()
      return { display: getComputedStyle(element).display, centerY: rect.top + rect.height / 2 }
    })
    const code = await page.locator('.code-block-code').evaluate((element, lineIndex) => {
      const range = document.createRange()
      range.setStart(element.firstChild!, 0)
      range.setEnd(element.firstChild!, 1)
      const rect = range.getBoundingClientRect()
      const lineHeight = parseFloat(getComputedStyle(element.closest('pre')!).lineHeight)
      return rect.top + rect.height / 2 + lineIndex * lineHeight
    }, line)
    expect(caret.display).toBe('block')
    expect(Math.abs(caret.centerY - code)).toBeLessThan(8)

    await page.keyboard.type('X')
    const expected = [...lines]
    expected[line] = `X${expected[line]}`
    expect(await page.locator('.code-block-code').evaluate((element) => element.textContent)).toBe(expected.join('\n'))
  }
})

test('clicks across consecutive blank code lines target the clicked row', async ({ page }) => {
  const lines = ['first', '', '', '', 'last']
  for (const line of [1, 2, 3]) {
    for (const xOffset of [80, 250, 450]) {
      await bootCodeBlock(page, lines)
      expect(await clickCodeLine(page, line, xOffset)).toBe('code-block-pre')
      const caretCenter = await page.locator('.visual-custom-caret').evaluate((element) => {
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      })
      const targetCenter = await page.locator('.code-block-code').evaluate((code, lineIndex) => {
        const range = document.createRange()
        range.setStart(code.firstChild!, 0)
        range.setEnd(code.firstChild!, 1)
        const rect = range.getBoundingClientRect()
        const lineHeight = parseFloat(getComputedStyle(code.closest('pre')!).lineHeight)
        return rect.top + rect.height / 2 + lineIndex * lineHeight
      }, line)
      expect(Math.abs(caretCenter - targetCenter),
        `caret on blank line ${line}, horizontal offset ${xOffset}`).toBeLessThan(8)
      await page.keyboard.type('X')
      const expected = [...lines]
      expected[line] = 'X'
      expect(await page.locator('.code-block-code').evaluate((code) => code.textContent),
        `blank line ${line}, horizontal offset ${xOffset}`).toBe(expected.join('\n'))
    }
  }
})

test('trailing blank code lines created with Enter remain clickable across the row', async ({ page }) => {
  for (const line of [1, 2, 3]) {
    await page.goto('/')
    await page.waitForSelector('.ProseMirror', { timeout: 20_000 })
    await page.locator('.ProseMirror').click()
    await page.keyboard.type('```')
    await page.keyboard.press('Enter')
    await page.keyboard.type('first')
    for (let i = 0; i < 3; i++) await page.keyboard.press('Enter')
    expect(await page.locator('.code-block-code').evaluate((code) => code.textContent)).toBe('first\n\n\n')

    expect(await clickCodeLine(page, line, 250)).toBe('code-block-pre')
    await page.keyboard.type('X')
    const expected = ['first', '', '', '']
    expected[line] = 'X'
    expect(await page.locator('.code-block-code').evaluate((code) => code.textContent),
      `trailing blank line ${line}`).toBe(expected.join('\n'))
  }
})
