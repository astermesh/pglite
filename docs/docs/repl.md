---
outline: [2, 3]
---

<script setup>
import { defineClientComponent } from 'vitepress'

const Repl = defineClientComponent(() => {
  return import('../components/Repl.vue')
})
</script>

<style scoped>
  .repl {
    height: 350px;
  }
</style>

# PGlite REPL Component

A REPL, or terminal, for use in the browser with PGlite, allowing you to have an interactive session with your WASM Postgres in the page.

This is the REPL with a full PGlite Postgres embedded in the page:

<ClientOnly>
  <Repl class="repl" />
</ClientOnly>

## Features:

- Available as both a [React.js](#react-component) component and a [Web Component](#web-component)
- [CodeMirror](https://codemirror.net) for input editing
- Auto complete, including table and column names from the database
- Input history (up and down keys)
- `\d` PSQL commands (via [psql-describe](https://www.npmjs.com/package/psql-describe))

## React Component

```bash
npm install @astermesh/pglite-repl
```

then to include in a page:

```tsx
import { PGlite } from '@astermesh/pglite'
import { Repl } from '@astermesh/pglite-repl'

function MyComponent() {
  const pg = new PGlite()

  return (
    <>
      <Repl pg={pg} />
    </>
  )
}
```

The props for the `<Repl>` component are described by this interface:

```ts
// The theme to use, auto is auto-switching based on the system
type ReplTheme = 'light' | 'dark' | 'auto'

interface ReplProps {
  pg: PGlite // PGlite db instance
  border?: boolean // Outer border on the component, defaults to false
  lightTheme?: Extension
  darkTheme?: Extension
  theme?: ReplTheme // Defaults to "auto"
}
```

The `lightTheme` and `darkTheme` should be instances of a [React CodeMirror](https://uiwjs.github.io/react-codemirror/) theme.

## Web Component

Although the PGlite REPL is built with React, it's also available as a web
component for easy inclusion in a bundled application or another framework.

```html
<!-- Include the Repl web component in your page -->
<pglite-repl id="repl"></pglite-repl>

<script type="module">
  import { PGlite } from '@astermesh/pglite'
  import '@astermesh/pglite-repl/webcomponent'

  // Create a PGlite instance
  const pg = new PGlite()

  // Retrieve the Repl element
  const repl = document.getElementById('repl')

  // REPL to your PGlite instance
  repl.pg = pg
</script>
```

### With Vue.js

The REPL Web Component can be used with Vue.js:

```vue
<script setup>
import { PGlite } from '@astermesh/pglite'
import '@astermesh/pglite-repl/webcomponent'

const pg = new PGlite()
</script>
<template>
  <pglite-repl :pg="pg" />
</template>
```

You will also need to configure Vue to ignore the `pglite-` prefix:

```ts
app.config.compilerOptions.isCustomElement = (tag) => {
  return tag.startsWith('pglite-')
}
```

See the [Vue docs for more details](https://vuejs.org/api/application.html#app-config-compileroptions-iscustomelement).
