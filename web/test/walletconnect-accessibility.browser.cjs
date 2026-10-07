const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const { chromium } = require(process.env.PLAYWRIGHT_PACKAGE || '/home/tx/.cache/ms-playwright-go/1.50.1/package');
const source = fs.readFileSync(path.join(__dirname, '../lib/chain/walletconnect-accessibility.ts'), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;

(async () => {
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE || '/home/tx/.cache/ms-playwright/chromium-1243/chrome-linux64/chrome', headless: true, args: ['--no-sandbox'] });
  try {
    const page = await browser.newPage();
    await page.setContent('<button id="outside">Outside</button>');
    await page.addScriptTag({ content: `window.adapter = {}; (function(exports) { ${compiled} })(window.adapter);` });
    const initial = await page.evaluate(() => {
      const modal = document.createElement('w3m-modal');
      document.body.append(modal);
      const root = modal.attachShadow({ mode: 'open' });
      root.innerHTML = '<wui-card role="alertdialog" aria-modal="true" data-testid="w3m-modal-card"><w3m-header></w3m-header><w3m-all-wallets-view></w3m-all-wallets-view></wui-card>';
      const header = root.querySelector('w3m-header').attachShadow({ mode: 'open' });
      header.innerHTML = '<wui-icon-button icon="close"></wui-icon-button><wui-icon-button icon="helpCircle"></wui-icon-button><wui-icon-button icon="chevronLeft"></wui-icon-button>';
      for (const host of header.querySelectorAll('wui-icon-button')) host.attachShadow({ mode: 'open' }).innerHTML = '<button></button>';
      const view = root.querySelector('w3m-all-wallets-view').attachShadow({ mode: 'open' });
      view.innerHTML = '<wui-certified-switch></wui-certified-switch><wui-icon-box icon="qrCode"></wui-icon-box>';
      const certified = view.querySelector('wui-certified-switch').attachShadow({ mode: 'open' });
      certified.innerHTML = '<wui-toggle></wui-toggle>';
      certified.querySelector('wui-toggle').attachShadow({ mode: 'open' }).innerHTML = '<label><input type="checkbox"><span></span></label>';
      window.qrClicks = 0;
      view.querySelector('wui-icon-box').addEventListener('click', () => window.qrClicks++);
      window.disposeAdapter = window.adapter.observeWalletConnectModal(modal);
      return {
        dialog: root.querySelector('wui-card').getAttribute('aria-label'),
        buttons: [...header.querySelectorAll('wui-icon-button')].map(host => host.shadowRoot.querySelector('button').getAttribute('aria-label')),
        checkbox: certified.querySelector('wui-toggle').shadowRoot.querySelector('input').getAttribute('aria-label'),
        outside: document.getElementById('outside').getAttribute('aria-label')
      };
    });
    assert.deepEqual(initial, { dialog: 'WalletConnect', buttons: ['Close wallet connection', 'What is a wallet?', 'Back'], checkbox: 'Only WalletConnect certified wallets', outside: null });
    const qr = page.getByRole('button', { name: 'Show WalletConnect QR code' });
    await qr.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Space');
    assert.equal(await page.evaluate(() => window.qrClicks), 2);
    await page.evaluate(() => {
      const header = document.querySelector('w3m-modal').shadowRoot.querySelector('w3m-header').shadowRoot;
      const close = header.querySelector('[icon="close"]');
      close.shadowRoot.innerHTML = '<button></button>';
      header.querySelector('[icon="helpCircle"]').setAttribute('icon', 'chevronLeft');
    });
    await page.getByRole('button', { name: 'Close wallet connection' }).waitFor();
    await page.waitForFunction(() => {
      const header = document.querySelector('w3m-modal').shadowRoot.querySelector('w3m-header').shadowRoot;
      return [...header.querySelectorAll('wui-icon-button')].filter(host => host.shadowRoot.querySelector('button').getAttribute('aria-label') === 'Back').length === 2;
    });
    await page.evaluate(() => {
      window.disposeAdapter();
      document.querySelector('w3m-modal').shadowRoot.querySelector('w3m-header').shadowRoot.querySelector('[icon="close"]').shadowRoot.innerHTML = '<button id="after-retirement"></button>';
    });
    await page.waitForTimeout(30);
    assert.equal(await page.locator('#after-retirement').getAttribute('aria-label'), null);
    await qr.focus(); await page.keyboard.press('Enter');
    assert.equal(await page.evaluate(() => window.qrClicks), 2);
    await page.evaluate(() => {
      const modal = document.querySelector('w3m-modal');
      modal.shadowRoot.innerHTML = '<w3m-header></w3m-header>';
      window.disposeAdapter = window.adapter.observeWalletConnectModal(modal);
      customElements.define('w3m-header', class extends HTMLElement {
        constructor() {
          super();
          const header = this.attachShadow({ mode: 'open' });
          header.innerHTML = '<wui-icon-button icon="close"></wui-icon-button>';
          header.querySelector('wui-icon-button').attachShadow({ mode: 'open' }).innerHTML = '<button></button>';
        }
      });
    });
    await page.getByRole('button', { name: 'Close wallet connection' }).waitFor();
    await page.evaluate(() => window.disposeAdapter());
    console.log('PASS: actual Chromium shadow DOM labels, dialog/checkbox names, native semantics, QR keyboard single activation, dynamic replacement/upgrade, outside scope and disposal.');
  } finally { await browser.close(); }
})().catch(error => { console.error(error); process.exitCode = 1; });
