# Playwright E2E Testing Reference

End-to-end patterns for Next.js applications. Locate elements the way a user does: `getByRole`, `getByLabel`, `getByText`. Reach for `getByTestId` only when no role or label identifies the element, and never for a CSS selector tied to markup.

## Configuration with Authenticated State

```typescript
// playwright.config.ts
import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env.CI,
  retries: process.env.CI ? 2 : 0,
  reporter: [['html', { open: 'never' }]],
  use: {
    baseURL: 'http://localhost:3000',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },
  projects: [
    { name: 'setup', testMatch: /.*\.setup\.ts/ },
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'], storageState: 'playwright/.auth/user.json' },
      dependencies: ['setup'],
    },
  ],
  webServer: {
    command: 'npm run dev',
    url: 'http://localhost:3000',
    reuseExistingServer: !process.env.CI,
  },
});
```

```typescript
// e2e/auth.setup.ts — logs in once; every test in the dependent projects starts signed in
import { test as setup, expect } from '@playwright/test';

setup('authenticate', async ({ page }) => {
  await page.goto('/login');
  await page.getByLabel('Email').fill('test@example.com');
  await page.getByLabel('Password').fill('password123');
  await page.getByRole('button', { name: /sign in/i }).click();

  await expect(page).toHaveURL('/dashboard');
  await page.context().storageState({ path: 'playwright/.auth/user.json' });
});
```

Add Firefox, WebKit or a mobile device as further projects with the same `storageState` and `dependencies`.

## A Test

```typescript
import { test, expect } from '@playwright/test';

test('navigates to the about page', async ({ page }) => {
  await page.goto('/');

  await page.getByRole('link', { name: /about/i }).click();

  await expect(page).toHaveURL('/about');
  await expect(page.getByRole('heading', { name: /about/i })).toBeVisible();
});

test('validates required fields', async ({ page }) => {
  await page.goto('/contact');

  await page.getByRole('button', { name: /send/i }).click();

  await expect(page.getByText('Name is required')).toBeVisible();
});
```

Assertions such as `toBeVisible` and `toHaveURL` retry until they hold, so no explicit wait is needed.

## Page Objects

Use one when several tests drive the same screen.

```typescript
// e2e/pages/login.page.ts
import { type Page, expect } from '@playwright/test';

export class LoginPage {
  constructor(private readonly page: Page) {}

  goto = () => this.page.goto('/login');

  async login(email: string, password: string) {
    await this.page.getByLabel('Email').fill(email);
    await this.page.getByLabel('Password').fill(password);
    await this.page.getByRole('button', { name: /sign in/i }).click();
  }

  expectError = (message: string) => expect(this.page.getByRole('alert')).toContainText(message);
}
```

## Network Stubs

```typescript
test('shows an error when the API fails', async ({ page }) => {
  await page.route('**/api/users', (route) =>
    route.fulfill({ status: 500, json: { error: 'Server error' } }),
  );

  await page.goto('/users');

  await expect(page.getByRole('alert')).toContainText('Failed to load users');
});
```

`page.route` intercepts browser requests only. Data fetched on the server (Server Components, Server Actions) never passes through it: seed the test database or point the server at a stub API.

## Dialogs and Uploads

```typescript
test('opens and closes the details dialog', async ({ page }) => {
  await page.goto('/products');
  await page.getByRole('button', { name: /details/i }).first().click();

  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading')).toHaveText('Product Details');

  await dialog.getByRole('button', { name: /close/i }).click();
  await expect(dialog).toBeHidden();
});

test('confirms a delete', async ({ page }) => {
  await page.goto('/items/1');
  page.once('dialog', (dialog) => dialog.accept());   // register before the click that opens it

  await page.getByRole('button', { name: /delete/i }).click();

  await expect(page.getByText('Item deleted')).toBeVisible();
});

test('uploads a file', async ({ page }) => {
  await page.goto('/upload');
  await page.getByLabel('File').setInputFiles({
    name: 'test.txt',
    mimeType: 'text/plain',
    buffer: Buffer.from('Test file content'),
  });
  await page.getByRole('button', { name: /upload/i }).click();

  await expect(page.getByText('File uploaded successfully')).toBeVisible();
});
```

## Accessibility

```typescript
import AxeBuilder from '@axe-core/playwright';

test('has no accessibility violations', async ({ page }) => {
  await page.goto('/');

  const results = await new AxeBuilder({ page }).analyze();

  expect(results.violations).toEqual([]);
});
```

## Visual Regression

`await expect(page).toHaveScreenshot('homepage.png')` compares against a stored image; scope it to a locator for a single component. Baselines are per platform, so generate them where CI runs, and update them with `npx playwright test --update-snapshots`.

## Running

`npx playwright test` runs everything; add a file path, `--project=chromium`, `--ui` or `--debug` as needed. `npx playwright show-report` opens the last HTML report.
