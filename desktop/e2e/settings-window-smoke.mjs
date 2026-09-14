import { _electron as electron, expect } from '@playwright/test'
import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

const userData = await mkdtemp(join(tmpdir(), 'innercourt-settings-window-'))
const workspacePath = await mkdtemp(join(tmpdir(), 'innercourt-settings-workspace-'))
const environment = {
  ...process.env,
  EDICT_USER_DATA_DIR: userData,
  EDICT_AUTO_DISPATCH: '0',
  EDICT_SKIP_GATEWAY_RESTART: '1',
}
for (const key of ['OPENCLAW_BIN', 'EDICT_NODE_BIN', 'OPENCLAW_CONFIG_PATH', 'OPENCLAW_HOME', 'EDICT_OPENCLAW_HOME', 'EDICT_RUNTIME_DEPENDENCIES']) delete environment[key]

const app = await electron.launch({ args: [resolve('.')], env: environment, timeout: 60_000 })

try {
  const dashboard = await app.firstWindow()
  await dashboard.evaluate(path => window.edictDesktop.useWorkspacePath(path), workspacePath)
  await dashboard.evaluate(() => window.edictDesktop.useWorkspaceAsProject()).catch(error => {
    if (!/Execution context was destroyed/.test(String(error))) throw error
  })
  await expect.poll(async () => {
    try { return (await dashboard.evaluate(() => window.edictDesktop.getDiagnostics())).startupState }
    catch (error) { return /Execution context was destroyed/.test(String(error)) ? 'navigating' : String(error) }
  }, { timeout: 60_000 }).toBe('ready')

  await dashboard.evaluate(() => window.edictDesktop.saveProvider({
    id: 'settings-smoke',
    name: 'Settings smoke fixture',
    baseUrl: 'http://127.0.0.1:9/v1',
    apiKey: 'fixture-secret-before-replacement',
    models: ['fixture-model'],
    defaultModel: 'fixture-model',
  }))
  await dashboard.evaluate(() => window.edictDesktop.openSettings('providers'))
  await expect.poll(() => app.windows().some(page => page.url().endsWith('/settings/index.html')), { timeout: 10_000 }).toBe(true)
  const settings = app.windows().find(page => page.url().endsWith('/settings/index.html'))
  assert(settings, 'settings window should open')

  await expect(settings.getByRole('heading', { name: '编辑 · Settings smoke fixture' })).toBeVisible()
  await expect(settings.locator('#provider-key')).toBeDisabled()
  await expect(settings.locator('#provider-key')).toHaveValue('')
  await expect(settings.getByRole('button', { name: '显示 API Key' })).toBeEnabled()
  await settings.getByRole('button', { name: '显示 API Key' }).click()
  await expect(settings.locator('#provider-key')).toHaveValue('fixture-secret-before-replacement')
  await expect(settings.locator('#provider-key')).toHaveAttribute('type', 'text')
  await settings.getByRole('button', { name: '隐藏 API Key' }).click()
  await expect(settings.locator('#provider-key')).toHaveAttribute('type', 'password')
  await settings.getByRole('button', { name: '更换密钥' }).click()
  await expect(settings.locator('#provider-key')).toHaveValue('')
  await settings.locator('#provider-key').fill('fixture-secret-after-replacement')
  await settings.getByRole('button', { name: '显示 API Key' }).click()
  await expect(settings.locator('#provider-key')).toHaveAttribute('type', 'text')
  await settings.getByRole('button', { name: '保存供应商' }).click()
  await expect(settings.locator('#form-success')).toHaveText('供应商与密钥已保存，运行看板已重载并生效。', { timeout: 60_000 })
  await expect(settings.locator('#provider-key')).toBeDisabled()
  const diagnostics = await settings.evaluate(() => window.edictDesktop.getDiagnostics())
  assert.equal(diagnostics.dashboardReloadRequired, false)
  assert.equal(diagnostics.providerEnvironmentCount, 1)

  const windowIds = await app.evaluate(({ BrowserWindow }) => {
    const windows = BrowserWindow.getAllWindows()
    const settingsWindow = windows.find(window => window.getTitle().includes('设置'))
    const dashboardWindow = windows.find(window => window.id !== settingsWindow?.id)
    return { settings: settingsWindow?.id ?? -1, dashboard: dashboardWindow?.id ?? -1 }
  })
  assert.notEqual(windowIds.settings, -1)
  assert.notEqual(windowIds.dashboard, -1)
  await settings.getByRole('button', { name: '返回总控台' }).click()
  await expect.poll(() => app.evaluate(({ BrowserWindow }, expected) => {
    const settingsWindow = BrowserWindow.fromId(expected.settings)
    const dashboardWindow = BrowserWindow.fromId(expected.dashboard)
    return { settingsVisible: settingsWindow?.isVisible() ?? false, dashboardVisible: dashboardWindow?.isVisible() ?? false }
  }, windowIds)).toEqual({ settingsVisible: false, dashboardVisible: true })

  console.log(JSON.stringify({
    passed: true,
    checks: ['stored key locked', 'stored key reveal and hide', 'explicit replacement', 'visibility toggle', 'save reloads idle dashboard', 'return hides settings and shows dashboard'],
  }))
} finally {
  await app.close()
}
