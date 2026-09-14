import { test, expect } from '@playwright/test'

test.beforeEach(async ({ request }) => {
  const { tasks = [] } = await (await request.get('/api/live-status')).json()
  for (const task of tasks) {
    if (task.id.startsWith('JJC-') && !['Done', 'Cancelled'].includes(task.state)) {
      await request.post('/api/task-action', { data: { taskId: task.id, action: 'cancel', reason: '隔离 UI 验收' } })
    }
  }
  await request.post('/api/command-center/dismiss', { data: {} })
})

test('全局导航不重复且小窗口不需要横向拖动', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('.rail-flow')).toHaveCount(0)
  const nav = page.getByRole('navigation', { name: '应用导航' })
  await expect(nav.getByRole('button', { name: '执行保障', exact: true })).toHaveCount(1)
  await expect(page.getByRole('tab', { name: '执行保障', exact: true })).toHaveCount(0)
  await nav.getByRole('button', { name: '执行保障', exact: true }).click()
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await nav.getByRole('button', { name: '运行', exact: true }).click()
  for (const width of [1440, 1024]) {
    await page.setViewportSize({ width, height: 900 })
    expect(await page.locator('.tabs').evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true)
    await page.screenshot({ path: `test-results/workbench-${width}.png` })
  }
})

test('已保存但尚未进入看板进程的密钥可在执行保障直接应用', async ({ page }) => {
  await page.addInitScript(() => {
    window.reloadConfigurationCalls = 0
    window.edictDesktop = {
      getDiagnostics: async () => ({ dashboardReloadRequired: true, providerEnvironmentCount: 1 }),
      reloadDashboard: async () => { window.reloadConfigurationCalls += 1; return { ok: true } },
    }
  })
  await page.route('**/api/readiness', route => route.fulfill({ json: {
    ok: true,
    ready: false,
    summary: { total: 1, ready: 0, blockers: 1, warnings: 0 },
    next: '请在设置中保存供应商密钥',
    checks: [{ id: 'secret', label: '密钥', ready: false, detail: '请在设置中保存供应商密钥', blocking: true, severity: 'blocker', action: { type: 'settings', target: 'providers', label: '打开供应商设置' } }],
    routes: {},
  } }))
  await page.goto('/')
  await page.getByRole('navigation', { name: '应用导航' }).getByRole('button', { name: '执行保障', exact: true }).click()
  await expect(page.getByText('密钥已保存，但当前看板仍在使用旧运行环境。')).toBeVisible()
  await page.getByRole('button', { name: '应用新配置并重载' }).click()
  await expect.poll(() => page.evaluate(() => window.reloadConfigurationCalls)).toBe(1)
})

test('审批失败保留方案；阶段、确认框和空项目测试正确', async ({ page, request }) => {
  const first = await (await request.post('/api/create-task', { data: { title: '桌面阶段与审批体验验收' } })).json()
  expect(first.ok, first.error).toBe(true)
  await page.goto('/')
  await page.getByRole('button', { name: '复杂任务 多步骤/跨部门' }).click()
  await page.getByLabel('执行前询问', { exact: true }).check()
  await expect(page.locator('.command-permission')).toContainText('执行前询问')
  await page.getByRole('textbox', { name: '交给太子的指令' }).fill('设计并开发另外一个网页')
  await page.getByRole('button', { name: '交给太子', exact: true }).click()
  await page.getByRole('button', { name: '确认执行', exact: true }).click()
  await expect(page.locator('.command-approval')).toBeVisible()
  await expect(page.locator('.command-center')).toContainText('当前已有正式任务')
  await page.getByRole('button', { name: '撤回', exact: true }).click()
  await expect(page.locator('.command-approval')).toHaveCount(0)
  const card = page.locator('.edict-card').filter({ hasText: first.taskId })
  await card.getByRole('button', { name: /叫停/ }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('button', { name: '确认叫停' }).focus()
  await page.keyboard.press('Tab')
  await expect(dialog.getByRole('textbox')).toBeFocused()
  await page.keyboard.press('Escape')
  await expect(dialog).toHaveCount(0)
  await expect(card.getByRole('button', { name: /叫停/ })).toBeFocused()
  await card.getByRole('button', { name: /叫停/ }).click()
  await dialog.getByRole('textbox').fill('暂停阶段核验')
  await dialog.getByRole('button', { name: '确认叫停' }).click()
  await expect(card).toContainText('暂停阶段核验')
  await expect(card).toContainText('太子 · 分拣')
  await expect(card).not.toContainText('当前: 六部')
  const inspector = page.getByRole('complementary', { name: '当前任务执行详情' })
  await inspector.getByRole('button').filter({ hasText: first.taskId }).click()
  await expect(inspector.getByRole('button', { name: '运行', exact: true })).toBeDisabled()
  await request.post('/api/task-action', { data: { taskId: first.taskId, action: 'cancel', reason: '保留成果验收' } })
  await expect(inspector).toContainText(first.taskId)
  await expect(inspector).toContainText('已取消')
})

test('问询会携带原内容进入御书房', async ({ page }) => {
  await page.goto('/')
  await page.getByRole('button', { name: '实时问询 不建立任务' }).click()
  await page.getByRole('textbox', { name: '交给太子的指令' }).fill('请问目前各部门进度如何？')
  await page.getByRole('button', { name: '交给太子', exact: true }).click()
  await expect(page.getByRole('tab', { name: '御书房', exact: true })).toHaveAttribute('aria-selected', 'true')
  await expect(page.getByRole('region', { name: '来自总控台的问询' })).toContainText('请问目前各部门进度如何？')
  await page.reload()
  await page.getByRole('tab', { name: '御书房', exact: true }).click()
  await expect(page.getByRole('region', { name: '来自总控台的问询' })).toContainText('请问目前各部门进度如何？')
})
