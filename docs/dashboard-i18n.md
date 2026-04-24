# Dashboard Internationalization (i18n) Guide

This document describes the internationalization system used in the WindsurfAPI dashboard.

## Overview

The dashboard supports multiple languages through JSON locale bundles. Currently implemented:
- English (`en`)
- Simplified Chinese (`zh-CN`)

## Architecture

### Files

| File | Purpose |
|------|---------|
| `src/dashboard/i18n/en.json` | English translations |
| `src/dashboard/i18n/zh-CN.json` | Chinese translations |
| `src/dashboard/index.html` | Main dashboard (contains I18n helper) |
| `src/dashboard/check-i18n.js` | Regression protection script |

### I18n Helper

The `I18n` object in `index.html` provides:

```javascript
// Load locale bundles
await I18n.init('en');  // or 'zh-CN'

// Translate a key
I18n.t('nav.overview');           // "Dashboard"
I18n.t('card.activeAccounts.title'); // "Active Accounts"

// Translate with placeholders
I18n.t('card.activeAccounts.subtitle', { total: 5, error: 1 });
// Result: "5 total · 1 abnormal"
```

## Adding New Translations

### 1. Static HTML Content

Add `data-i18n` attributes to translatable elements:

```html
<!-- Before -->
<h3>Active Accounts</h3>

<!-- After -->
<h3 data-i18n="section.accounts.title">Active Accounts</h3>
```

Update both locale files:

```json
// en.json
{
  "section": {
    "accounts": {
      "title": "Active Accounts"
    }
  }
}

// zh-CN.json
{
  "section": {
    "accounts": {
      "title": "活跃账号"
    }
  }
}
```

### 2. Dynamic JavaScript Content

Use `I18n.t()` in JavaScript:

```javascript
// Before
element.textContent = `成功 ${count} 个`;

// After
element.textContent = I18n.t('toast.successCount', { count });
```

Add to locale files:

```json
// en.json
{ "toast": { "successCount": "Success: {{count}}" } }

// zh-CN.json  
{ "toast": { "successCount": "成功 {{count}} 个" } }
```

### 3. Backend Error Codes

Backend should return error codes, not raw messages:

```javascript
// Before
res.json({ error: '邮箱或密码错误' });

// After
res.json({ error: 'ERR_INVALID_CREDENTIALS' });
```

Add the error code to locale files:

```json
// en.json
{ "error": { "ERR_INVALID_CREDENTIALS": "Invalid email or password" } }

// zh-CN.json
{ "error": { "ERR_INVALID_CREDENTIALS": "邮箱或密码错误" } }
```

## Key Naming Conventions

### Structure
```
<section>.<component>.<property>
```

Examples:
- `nav.overview` - Navigation items
- `page.accounts.title` - Page titles
- `card.activeAccounts.title` - Card titles
- `button.save` - Button labels
- `toast.saved` - Toast messages
- `error.ERR_*` - Error codes

### Common Sections

| Section | Usage |
|---------|-------|
| `brand` | Brand name and subtitle |
| `nav` | Navigation items |
| `page` | Page titles and subtitles |
| `pageSubtitle` | Page descriptions |
| `section` | Panel titles and descriptions |
| `card` | Metric card titles |
| `button` | Button labels |
| `action` | Action labels |
| `field` | Form field labels and placeholders |
| `table` | Table headers |
| `toast` | Toast notification messages |
| `help` | Help text |
| `status` | Status messages |
| `confirm` | Confirmation dialog titles/descriptions |
| `modal` | Modal dialog content |
| `log` | Log level names |
| `batch` | Batch import messages |
| `error` | Error messages and codes |
| `footer` | Footer text |
| `experimental` | Experimental feature labels |

## Placeholder Syntax

Use `{{variableName}}` for dynamic values:

```json
{
  "card": {
    "activeAccounts": {
      "subtitle": "{{total}} total · {{error}} abnormal"
    }
  }
}
```

Usage:
```javascript
I18n.t('card.activeAccounts.subtitle', { total: 5, error: 1 });
// "5 total · 1 abnormal"
```

## Regression Protection

Run the check script before committing:

```bash
cd src/dashboard
node check-i18n.js
```

This checks for:
1. Hardcoded Chinese text in HTML/JS
2. Missing translation keys
3. Keys present in one locale but not the other
4. `data-i18n` attributes referencing non-existent keys

### CI Integration

Add to your CI pipeline:

```yaml
# .github/workflows/i18n-check.yml
name: I18n Check
on: [push, pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
      - run: node src/dashboard/check-i18n.js
```

## Language Toggle

The dashboard persists language preference in `localStorage`:

```javascript
// Toggle language
I18n.toggle();

// Get current locale
const current = I18n.currentLocale; // 'en' or 'zh-CN'
```

## Best Practices

1. **Always add both locales**: When adding a new key, add it to both `en.json` and `zh-CN.json`

2. **Use descriptive keys**: Prefer `card.activeAccounts.title` over `card.title1`

3. **Keep placeholders semantic**: Use `{{email}}` not `{{e}}`

4. **Error codes**: Use `ERR_*` prefix for backend error codes

5. **Test both languages**: Verify your changes in both EN and CN modes

6. **Run regression check**: Use `check-i18n.js` before committing

## Troubleshooting

### Key not translating
- Check that the key exists in both locale files
- Verify the key path is correct (e.g., `section.accounts.title` vs `accounts.title`)
- Check browser console for I18n errors

### Locale not loading
- Verify the locale file is valid JSON
- Check browser Network tab for 404 errors on `/dashboard/i18n/*.json`
- Ensure `I18n.init()` completed before using `I18n.t()`

### Mixed languages showing
- Some content may be cached; hard refresh (Ctrl+F5) the page
- Check that all dynamic content uses `I18n.t()`
- Verify no hardcoded strings remain in JavaScript
