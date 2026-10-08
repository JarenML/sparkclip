'use strict'
// End-to-end: the real BridgeClip app (production build, isolated userData,
// hidden window) against the mock Zernio and its scripted browser.
//
//   npm run test:e2e
//
// Optional: BRIDGECLIP_E2E_APP_DIR (build folder), BRIDGECLIP_E2E_SKIP_BUILD=1
// (reuse the last build), BRIDGECLIP_E2E_SHOTS (folder for screenshots).

const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { createMockZernio } = require('../support/mock-zernio.cjs')
const { buildApp, launchApp } = require('../support/electron-app.cjs')

const KEY = 'e2e-mock-zernio-key-0001'
const TIMEOUT = 15_000

test('accounts: set up, connect, reconnect, disconnect, recover and work offline', { timeout: 300_000 }, async (t) => {
  const appDir = buildApp()
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'bridgeclip-e2e-userdata-'))
  const shots = process.env.BRIDGECLIP_E2E_SHOTS
  const mock = await createMockZernio({ apiKey: KEY })
  const [profile] = mock.state.profiles
  mock.addProfile('Brand')
  mock.addAccount('linkedin', profile._id, { username: 'jane', displayName: 'Jane Doe' })
  mock.addAccount('pinterest', profile._id, { username: 'pins' })

  let session = null
  t.after(async () => {
    await session?.close()
    await mock.close().catch(() => {})
    fs.rmSync(userDataDir, { recursive: true, force: true })
  })
  session = await launchApp({ appDir, userDataDir, mock })
  let page = session.page
  const shot = async (name) => { if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) }).catch(() => {}) }
  const row = (platform) => page.locator(`li[data-platform="${platform}"]`)
  const notice = () => page.getByTestId('accounts-notice')
  const openAccounts = () => page.locator('nav[aria-label="Main"] button', { hasText: 'Accounts' }).click()
  const openSettings = () => page.locator('nav[aria-label="Main"] button', { hasText: 'Settings' }).click()
  const expectNotice = (pattern) => notice().filter({ hasText: pattern }).waitFor({ timeout: TIMEOUT })
  const expectRowState = (platform, state) => page.locator(`li[data-platform="${platform}"][data-state="${state}"]`).waitFor({ timeout: TIMEOUT })
  const click = (name) => page.getByRole('button', { name, exact: true }).click()
  // The app's dropdowns are a combobox button with a listbox menu.
  const choose = async (combobox, name) => {
    await combobox.click()
    await page.getByRole('listbox').getByRole('option', { name, exact: true }).click()
  }
  // A platform's page: open it from its tile, leave by the back link (the sidebar has an Accounts button too).
  const openPlatform = (name) => click(`Open ${name} accounts`)
  const back = () => page.getByRole('button', { name: 'Accounts', exact: true }).last().click()
  const accountRows = (name) => page.getByRole('list', { name: `${name} accounts`, exact: true }).locator('li[data-account]')

  await t.test('pasting a rejected key shows the auth error', async () => {
    await openAccounts()
    await page.getByText('Connect with Zernio').waitFor({ timeout: TIMEOUT })
    await shot('01-setup')
    const input = page.locator('input[type="password"]').first()
    await input.fill('wrong-key-0000')
    await input.blur()
    await page.getByText('Zernio rejected your API key. Check the key in Settings.').waitFor({ timeout: TIMEOUT })
    await shot('02-auth-error')
    assert.ok(mock.state.requests.some((r) => !r.authorized))
  })

  await t.test('replacing the key in Settings loads the accounts', async () => {
    await page.getByRole('button', { name: 'Open Settings' }).first().click()
    const zernio = page.getByLabel(/^Zernio \(optional\)/)
    await zernio.fill(KEY)
    await zernio.blur()
    await page.getByText('Saved', { exact: true }).waitFor({ timeout: TIMEOUT })
    await openAccounts()
    await expectRowState('linkedin', 'connected')
    await row('linkedin').getByText('1 account', { exact: true }).waitFor()
    // The grid names no account; the platform's page does.
    assert.equal(await row('linkedin').getByText('@jane', { exact: false }).count(), 0)
    await expectRowState('pinterest', 'connected')
    assert.equal(await row('tiktok').getAttribute('data-state'), 'disconnected')
    await page.getByTestId('accounts-synced').filter({ hasText: 'Synced just now' }).waitFor()
    await shot('03-accounts')
  })

  await t.test('connect: sign-in in the scripted browser, redirect to the loopback, success', async () => {
    await click('Connect TikTok')
    await expectNotice('TikTok connected as @tiktok_creator.')
    await expectRowState('tiktok', 'connected')
    const opened = new URL(mock.state.opened.at(-1))
    assert.equal(opened.host, 'www.tiktok.com')
    const sessionInfo = mock.state.sessions.at(-1)
    assert.match(sessionInfo.redirectUrl, /^http:\/\/127\.0\.0\.1:\d+\/zernio\/connected\/[a-f0-9]{32}$/)
    assert.equal(mock.state.visits.at(-1).status, 200)
    assert.match(mock.state.visits.at(-1).body, /Account connected/)
    await shot('04-connected')
  })

  await t.test('an error redirect shows a friendly message', async () => {
    mock.setBrowser('instagram', { error: 'oauth_denied' })
    await click('Connect Instagram')
    await expectNotice('Instagram sign-in was cancelled')
    assert.equal(await row('instagram').getAttribute('data-state'), 'disconnected')
    assert.match(mock.state.visits.at(-1).body, /didn.t finish/)
    await shot('05-error-redirect')
  })

  await t.test('connect on a platform Zernio already has just refreshes', async () => {
    mock.addAccount('youtube', profile._id, { username: 'mychannel' })
    mock.setConnectResponse('youtube', 'alreadyConnected')
    const opened = mock.state.opened.length
    await click('Connect YouTube')
    await expectNotice('YouTube is already connected as @mychannel.')
    await expectRowState('youtube', 'connected')
    assert.equal(mock.state.opened.length, opened, 'no browser for an account that is already connected')
  })

  await t.test('reconnect asks for a fresh sign-in and clears the badge', async () => {
    const tiktok = mock.state.accounts.find((a) => a.platform === 'tiktok')
    mock.setHealth(tiktok._id, { status: 'error', needsReconnect: true, issues: ['Token expired'] })
    await click('Refresh accounts')
    await expectRowState('tiktok', 'reconnect')
    await row('tiktok').getByText('1 needs attention', { exact: false }).waitFor()
    await openPlatform('TikTok')
    await accountRows('TikTok').first().getByText('Reconnect needed', { exact: false }).waitFor()
    await shot('06-needs-reconnect')
    const sessionsBefore = mock.state.sessions.length
    await click('Reconnect tiktok creator · @tiktok_creator')
    await page.getByRole('alertdialog').getByText('permanently deletes its Zernio analytics, inbox and DM history', { exact: false }).waitFor()
    assert.equal(mock.state.sessions.length, sessionsBefore, 'the browser is not opened before the warning is confirmed')
    await click('Confirm reconnecting TikTok')
    await expectNotice('TikTok connected')
    await page.locator('li[data-account][data-state="connected"]').waitFor({ timeout: TIMEOUT })
    assert.equal(mock.state.sessions.at(-1).force, true)
    await back()
    await expectRowState('tiktok', 'connected')
  })

  await t.test('disconnect asks first, then removes the account', async () => {
    await openPlatform('LinkedIn')
    await click('Disconnect Jane Doe · @jane')
    await page.getByRole('alertdialog').getByText('This also removes Jane Doe · @jane from your Zernio workspace', { exact: false }).waitFor()
    const cancel = page.getByRole('alertdialog').getByRole('button', { name: 'Cancel', exact: true })
    const confirm = page.getByRole('button', { name: 'Confirm disconnecting LinkedIn', exact: true })
    assert.equal(await cancel.evaluate((element) => element === document.activeElement), true)
    await page.keyboard.press('Shift+Tab')
    assert.equal(await confirm.evaluate((element) => element === document.activeElement), true)
    await page.keyboard.press('Tab')
    assert.equal(await cancel.evaluate((element) => element === document.activeElement), true)
    await click('Confirm disconnecting LinkedIn')
    await expectNotice('LinkedIn disconnected.')
    await page.getByText('No LinkedIn accounts yet.', { exact: false }).waitFor({ timeout: TIMEOUT })
    await back()
    await expectRowState('linkedin', 'disconnected')
    assert.equal(mock.state.accounts.some((a) => a.platform === 'linkedin'), false)
  })

  await t.test('cancel stops waiting and closes the loopback server', async () => {
    mock.setBrowser('facebook', 'abandon')
    await click('Connect Facebook')
    await row('facebook').getByText('Finish signing in to Facebook in your browser').waitFor({ timeout: TIMEOUT })
    await shot('07-waiting')
    await click('Cancel connecting Facebook')
    await page.getByRole('button', { name: 'Connect Facebook', exact: true }).waitFor()
    await assert.rejects(fetch(`${mock.state.sessions.at(-1).redirectUrl}?connected=facebook`))
  })

  await t.test('a reload while signing in restores the waiting state', async () => {
    mock.setBrowser('threads', 'abandon')
    await click('Connect Threads')
    await row('threads').getByText('Finish signing in to Threads').waitFor({ timeout: TIMEOUT })
    await page.reload()
    await openAccounts()
    await row('threads').getByText('Finish signing in to Threads').waitFor({ timeout: TIMEOUT })
    await click('Cancel connecting Threads')
  })

  await t.test('without a redirect, coming back to the window finds the new account', async () => {
    mock.setBrowser('threads', 'no-redirect')
    await click('Connect Threads')
    await mock.waitFor(() => mock.state.accounts.some((a) => a.platform === 'threads'))
    await new Promise((resolve) => setTimeout(resolve, 8_500))
    await page.evaluate(() => window.dispatchEvent(new Event('focus')))
    await expectNotice('Threads connected as @threads_creator.')
    await expectRowState('threads', 'connected')
  })

  await t.test('a platform page lists the accounts in every profile and adds another into a new or a chosen profile', async () => {
    const brand = mock.state.profiles.find((p) => p.name === 'Brand')
    mock.addAccount('youtube', brand._id, { username: 'brandchannel' })
    await click('Refresh accounts')
    await row('youtube').getByText('2 accounts', { exact: true }).waitFor({ timeout: TIMEOUT })
    await openPlatform('YouTube')
    await accountRows('YouTube').nth(1).waitFor({ timeout: TIMEOUT })
    await accountRows('YouTube').getByText('Brand', { exact: true }).waitFor()

    // Both profiles have YouTube, so the new account needs a new profile.
    const browserCount = mock.state.opened.length
    await click('Add account')
    await page.getByLabel('New profile name', { exact: true }).fill('Launch team')
    mock.failNext('POST', '/api/v1/profiles', 409, { error: 'Name already taken' })
    await click('Connect')
    await expectNotice('already exists')
    assert.equal(mock.state.opened.length, browserCount, 'no sign-in opens when the profile could not be created')
    assert.equal(await accountRows('YouTube').count(), 2)

    await click('Add account')
    await page.getByLabel('New profile name', { exact: true }).fill('Launch team')
    await click('Connect')
    await expectNotice('YouTube connected')
    await accountRows('YouTube').nth(2).waitFor({ timeout: TIMEOUT })
    const launch = mock.state.profiles.find((p) => p.name === 'Launch team')
    assert.ok(mock.state.accounts.some((a) => a.platform === 'youtube' && a.profileId._id === launch._id))
    await shot('11-platform-accounts')
    await back()
    await row('youtube').getByText('3 accounts', { exact: true }).waitFor()

    // Profiles without the platform are offered; an earlier step left Threads' browser without a redirect.
    mock.setBrowser('threads', undefined)
    await openPlatform('Threads')
    await click('Add account')
    await choose(page.getByLabel('Profile for the new Threads account', { exact: true }), 'Brand')
    await click('Connect')
    await expectNotice('Threads connected')
    await accountRows('Threads').nth(1).waitFor({ timeout: TIMEOUT })
    assert.ok(mock.state.accounts.some((a) => a.platform === 'threads' && a.profileId._id === brand._id))
    await back()
    await shot('12-platforms')
  })

  await t.test('a 429 keeps the accounts on screen and says when to retry', async () => {
    mock.failNext('GET', '/api/v1/profiles', 429, { error: 'Rate limit exceeded. Please retry after 2 seconds.', details: { retryAfterSeconds: 2 } }, { 'Retry-After': '2' })
    await click('Refresh accounts')
    await page.getByText(/Zernio's rate limit was reached\. Try again in \ds\./).waitFor({ timeout: TIMEOUT })
    await expectRowState('tiktok', 'connected')
    await shot('08-rate-limited')
    await new Promise((resolve) => setTimeout(resolve, 2_500))
    await click('Try again')
    await page.getByTestId('accounts-synced').filter({ hasText: 'Synced just now' }).waitFor({ timeout: TIMEOUT })
  })

  await t.test('offline: the cached accounts render with a last-synced hint', async () => {
    await session.close()
    session = await launchApp({ appDir, userDataDir, apiUrl: 'http://127.0.0.1:9/api/v1' })
    page = session.page
    await openAccounts()
    // The cache is seconds old, so opening the page doesn't ask Zernio; refreshing does.
    await expectRowState('tiktok', 'connected')
    await page.getByTestId('accounts-synced').filter({ hasText: 'Synced' }).waitFor()
    await click('Refresh accounts')
    await page.getByText('Could not reach Zernio. Check your internet connection and try again.').waitFor({ timeout: TIMEOUT })
    await expectRowState('tiktok', 'connected')
    await page.getByTestId('accounts-synced').filter({ hasText: 'Last synced' }).waitFor()
    await shot('09-offline')
  })

  await t.test('removing the key clears the accounts and the cache', async () => {
    const cache = path.join(userDataDir, 'zernio-accounts.json')
    assert.equal(fs.existsSync(cache), true)
    assert.equal(fs.readFileSync(cache, 'utf8').includes(KEY), false)
    await openSettings()
    const remove = page.getByRole('button', { name: 'Remove key' })
    await remove.nth((await remove.count()) - 1).click()
    await openAccounts()
    await page.getByText('Connect with Zernio').waitFor({ timeout: TIMEOUT })
    assert.equal(fs.existsSync(cache), false)
    await shot('10-key-removed')
  })
})
