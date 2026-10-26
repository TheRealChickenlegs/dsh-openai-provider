import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import vm from 'node:vm'
import { JSDOM } from 'jsdom'
import React from 'react'

const source = fs.readFileSync(new URL('../lib/client.js', import.meta.url), 'utf8')

/**
 * Load the browser bundle into a jsdom window and return its exports plus the
 * config-page registration. The real DSH slot boundary catches effect errors and
 * abdicates the whole page, so this test clicks the real Add button and asserts
 * the page survives a missing/throwing credentials namespace.
 */
function mountPage(options = {}) {
  const dom = new JSDOM('<!doctype html><html><head></head><body><div id="root"></div></body></html>', {
    url: 'http://127.0.0.1:55768/'
  })
  globalThis.window = dom.window
  globalThis.document = dom.window.document
  Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true })
  globalThis.HTMLElement = dom.window.HTMLElement
  globalThis.MouseEvent = dom.window.MouseEvent
  globalThis.IS_REACT_ACT_ENVIRONMENT = true

  let snapshot = { status: 'ready', writable: true, revision: 0, value: { providers: [] } }
  const listeners = new Set()
  const form = {
    subscribe(listener) {
      listeners.add(listener)
      return () => listeners.delete(listener)
    },
    getSnapshot() {
      return snapshot
    },
    async mutate(ops) {
      let providers = snapshot.value.providers
      for (const op of ops) {
        if (op.path.length === 1 && op.path[0] === 'providers') {
          providers = op.op === 'set' ? op.value : []
        }
      }
      snapshot = {
        ...snapshot,
        revision: snapshot.revision + 1,
        value: { ...snapshot.value, providers }
      }
      for (const listener of listeners) listener()
      return true
    }
  }

  const describeCalls = []
  const credentials = {
    describe: async (refs) => {
      describeCalls.push(refs)
      return { ok: true, value: Object.fromEntries(refs.map((ref) => [ref, { configured: false, writable: true }])) }
    },
    set: async () => ({ ok: true }),
    unset: async () => ({ ok: true })
  }

  const remote = { credentials }
  if (options.throwingCredentials === true) {
    Object.defineProperty(remote, 'credentials', {
      get() {
        throw new Error('cannot get property "remote.credentials" without inject')
      }
    })
  }

  let slot = null
  const ctx = {
    remote,
    configForms: {
      get: () => form,
      whileServed(_namespaces, register) {
        return register(new Set(['dsh-openai-provider']))
      }
    },
    slots: {
      inject(_name, callback) {
        return callback()
      },
      register(definition, component) {
        slot = { definition, component }
        return () => {}
      }
    },
    effect(body) {
      return body()
    }
  }

  let contribution = null
  dom.window.__ModuleLoader__ = {
    load(value) {
      contribution = value
    }
  }
  vm.runInThisContext(source, { filename: 'client.js' })
  assert.ok(contribution)
  const exports = contribution.factory((name) => {
    if (name === 'react') return React
    throw new Error(`unexpected require(${name})`)
  })
  exports.apply(ctx)
  assert.ok(slot, 'the config page must register')
  return { dom, exports, form, slot, describeCalls, credentials, ctx }
}

test('Add provider shows the provider fields and survives a throwing credentials namespace', async () => {
  const { dom, slot, describeCalls } = mountPage({ throwingCredentials: true })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root'))
  const props = slot.definition.inject()

  await React.act(async () => {
    root.render(React.createElement(slot.component, props))
  })
  const add = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Add provider')
  assert.ok(add, 'the empty state has an Add provider button')

  await React.act(async () => {
    add.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })

  assert.equal(dom.window.document.querySelectorAll('[data-slot-error]').length, 0)
  assert.ok(dom.window.document.getElementById('op-0-id'), 'provider id input is rendered')
  assert.ok(dom.window.document.getElementById('op-0-url'), 'base URL input is rendered')
  assert.ok(dom.window.document.getElementById('op-0-ref'), 'credential reference input is rendered')
  assert.ok(
    [...dom.window.document.querySelectorAll('button')].some((button) => button.textContent === 'Add provider'),
    'the Add provider button remains available'
  )
  assert.match(dom.window.document.getElementById('root').textContent, /credentials service unavailable/i)
  assert.equal(describeCalls.length, 0, 'the throwing getter was caught before the remote call')
  await React.act(async () => { root.unmount() })
})

test('Add provider consults the credentials service when it is available', async () => {
  const { dom, slot, describeCalls } = mountPage()
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root'))
  const props = slot.definition.inject()
  await React.act(async () => {
    root.render(React.createElement(slot.component, props))
  })
  const add = [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent === 'Add provider')
  await React.act(async () => {
    add.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
    await Promise.resolve()
  })
  await React.act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 10))
  })
  assert.ok(dom.window.document.getElementById('op-0-id'))
  assert.deepEqual(describeCalls[0], ['DSH_OPENAI__API_KEY'])
  assert.match(dom.window.document.getElementById('root').textContent, /not configured/i)
  await React.act(async () => { root.unmount() })
})

test('the bundle declares the credentials namespace in its inject list', () => {
  const { exports } = mountPage()
  assert.ok(exports.inject.includes('remote.credentials'))
})

function setInput(dom, element, value) {
  const setter = Object.getOwnPropertyDescriptor(dom.window.HTMLInputElement.prototype, 'value').set
  setter.call(element, value)
  element.dispatchEvent(new dom.window.Event('input', { bubbles: true }))
}

function findButton(dom, text) {
  return [...dom.window.document.querySelectorAll('button')].find((button) => button.textContent.trim() === text)
}

test('discovered models can be multi-selected and added without blanking the provider', async () => {
  const { dom, slot } = mountPage()
  const originalFetch = globalThis.fetch
  globalThis.fetch = async () => ({
    ok: true,
    status: 200,
    text: async () =>
      JSON.stringify({
        ok: true,
        models: [
          { id: 'gpt-image-1', kind: 'image' },
          { id: 'sora-2', kind: 'video' },
          { id: 'flux-pro', kind: 'image' }
        ]
      })
  })
  const { createRoot } = await import('react-dom/client')
  const root = createRoot(dom.window.document.getElementById('root'))
  const props = slot.definition.inject()
  try {
    await React.act(async () => {
      root.render(React.createElement(slot.component, props))
    })
    await React.act(async () => {
      findButton(dom, 'Add provider').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
    })

    setInput(dom, dom.window.document.getElementById('op-0-id'), 'test-provider')
    setInput(dom, dom.window.document.getElementById('op-0-url'), 'https://example.com/v1')
    await React.act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })

    await React.act(async () => {
      findButton(dom, 'Load models').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    const checks = [...dom.window.document.querySelectorAll('input[data-model-id]')]
    assert.deepEqual(
      checks.map((input) => input.dataset.modelId),
      ['gpt-image-1', 'sora-2', 'flux-pro'],
      'discovery rendered selectable models'
    )

    await React.act(async () => {
      checks[0].click()
      checks[1].click()
      await Promise.resolve()
    })
    const addSelected = [...dom.window.document.querySelectorAll('button')].find((button) =>
      button.textContent.startsWith('Add selected')
    )
    assert.ok(addSelected, 'the bulk add button is present')
    assert.match(addSelected.textContent, /\(2\)/)

    await React.act(async () => {
      addSelected.dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })

    assert.equal(dom.window.document.getElementById('op-0-id').value, 'test-provider', 'the provider id survived')
    assert.equal(dom.window.document.getElementById('op-0-url').value, 'https://example.com/v1', 'the base URL survived')
    assert.equal(dom.window.document.querySelectorAll('[data-slot-error]').length, 0)
    const exposedIds = [...dom.window.document.querySelectorAll('input[data-exposed-model-id]')].map(
      (input) => input.value
    )
    assert.deepEqual(exposedIds, ['gpt-image-1', 'sora-2'])
    const text = dom.window.document.getElementById('root').textContent
    assert.equal(/Provider 1: id must be lowercase/.test(text), false)

    // A normal save must still work and keep the provider after the snapshot round-trip.
    await React.act(async () => {
      findButton(dom, 'Save').dispatchEvent(new dom.window.MouseEvent('click', { bubbles: true }))
      await Promise.resolve()
      await new Promise((resolve) => setTimeout(resolve, 20))
    })
    assert.equal(dom.window.document.getElementById('op-0-id').value, 'test-provider')
    assert.equal(/Could not save|not accept/i.test(dom.window.document.getElementById('root').textContent), false)
  } finally {
    globalThis.fetch = originalFetch
    await React.act(async () => { root.unmount() })
  }
})
