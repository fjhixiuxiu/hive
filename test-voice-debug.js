const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    headless: false,
    args: [
      '--use-fake-ui-for-media-stream',
      '--use-fake-device-for-media-stream',
      '--disable-web-security',
      '--autoplay-policy=no-user-gesture-required',
    ],
  });

  const context = await browser.newContext({
    permissions: ['microphone', 'camera'],
  });

  const page = await context.newPage();

  console.log('Navigating to Zoom...');
  await page.goto('https://us02web.zoom.us/wc/join/2120045747', {
    waitUntil: 'domcontentloaded',
    timeout: 30000,
  });

  await page.waitForTimeout(3000);
  console.log('URL:', page.url());

  // Find ALL inputs (including hidden ones)
  const inputs = await page.evaluate(() => {
    const items = [];
    document.querySelectorAll('input, textarea, [contenteditable], [role="textbox"]').forEach(el => {
      items.push({
        tag: el.tagName,
        type: el.type,
        id: el.id,
        name: el.name,
        placeholder: el.placeholder,
        ariaLabel: el.getAttribute('aria-label'),
        className: el.className?.substring(0, 80),
        value: el.value,
        visible: el.offsetParent !== null,
        rect: el.getBoundingClientRect(),
      });
    });
    return items;
  });
  console.log('\nAll inputs:');
  inputs.forEach(e => console.log(`  ${e.tag} type="${e.type}" id="${e.id}" name="${e.name}" placeholder="${e.placeholder}" class="${e.className}" visible=${e.visible}`));

  // Try to fill name and join
  try {
    // Look for the name input near "Your Name" text
    const nameInput = page.locator('input[type="text"], input:not([type])').first();
    console.log('\nName input found:', await nameInput.count() > 0);
    if (await nameInput.count() > 0) {
      await nameInput.fill('Hive');
      console.log('Filled name: Hive');
    }

    // Click Mute first
    const muteBtn = page.locator('#preview-audio-control-button, button:has-text("Mute")');
    if (await muteBtn.isVisible({ timeout: 2000 })) {
      // Check if already muted
      const text = await muteBtn.textContent();
      if (text.includes('Mute') && !text.includes('Unmute')) {
        await muteBtn.click();
        console.log('Muted mic');
      }
    }

    // Click Stop Video
    const videoBtn = page.locator('#preview-video-control-button, button:has-text("Stop Video")');
    if (await videoBtn.isVisible({ timeout: 2000 })) {
      await videoBtn.click();
      console.log('Stopped video');
    }

    await page.screenshot({ path: '/tmp/zoom-3-filled.png', fullPage: true });
    console.log('Screenshot saved: /tmp/zoom-3-filled.png');

    // Click Join
    const joinBtn = page.locator('button:has-text("Join")').first();
    if (await joinBtn.isVisible({ timeout: 2000 })) {
      await joinBtn.click();
      console.log('Clicked Join!');
    }

    // Wait for meeting to load
    await page.waitForTimeout(10000);
    await page.screenshot({ path: '/tmp/zoom-4-meeting.png', fullPage: true });
    console.log('Screenshot saved: /tmp/zoom-4-meeting.png');
    console.log('URL after join:', page.url());

    // Check what's on screen now
    const postJoin = await page.evaluate(() => {
      const items = [];
      document.querySelectorAll('button').forEach(el => {
        if (el.offsetParent !== null) {
          items.push({ text: el.textContent?.trim().substring(0, 50), ariaLabel: el.getAttribute('aria-label') });
        }
      });
      return items;
    });
    console.log('\nButtons after join:');
    postJoin.forEach(b => console.log(`  "${b.text}" aria="${b.ariaLabel}"`));

  } catch (e) {
    console.error('Error:', e.message);
  }

  console.log('\nBrowser open for 30s...');
  await page.waitForTimeout(30000);
  await browser.close();
  console.log('Done');
})().catch(e => {
  console.error('Fatal:', e.message);
  process.exit(1);
});
