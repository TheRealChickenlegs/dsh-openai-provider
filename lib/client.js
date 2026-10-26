/**
 * OpenAI Providers plugin-page configuration UI.
 *
 * Plain JS on purpose: DSH's client module loader serves this file directly and
 * the platform provides React. No bundler or UI-primitive dependency is needed.
 *
 * Security model on this page:
 * - The provider config written to the profile contains only a credential
 *   *reference* (`apiKeyEnv`), never a key.
 * - The key is sent once to `ctx.remote.credentials.set`, which stores it in
 *   DSH's credentials store; it is never read back into this page.
 * - Model discovery sends only a provider id to the host route; the host looks
 *   up the endpoint and key, and returns ids only.
 */
window.__ModuleLoader__.load({
  id: 'dsh-openai-provider',
  factory: function (require) {
    var module = { exports: {} }
    var exports = module.exports
    var React = require('react')

    var PACKAGE_ID = 'dsh-openai-provider'
    var ENTRY_ID = 'dsh-openai-provider'
    var STYLE_ID = PACKAGE_ID + '/settings.css'
    var ROUTE = '/plugin/openai-provider/api/models'
    var ROUTE_HEADER = 'x-dsh-openai-provider'
    var CREDENTIAL_PREFIX = 'DSH_OPENAI_'
    var ID_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/
    var REF_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
    var uidCounter = 0

    function nextUid() {
      uidCounter += 1
      return 'p-' + Date.now().toString(36) + '-' + uidCounter
    }

    var GLOBALS = [
      {
        key: 'outputDir',
        label: 'Default output directory',
        type: 'text',
        placeholder: 'Session working directory',
        hint: 'Where generated media lands without an explicit output_path. ~ is expanded.'
      },
      {
        key: 'maxImagesPerCall',
        label: 'Maximum images per call',
        type: 'number',
        placeholder: '4',
        hint: 'Caps the tool `n` argument (1-10) so one call cannot create an unbounded bill.'
      },
      {
        key: 'requestTimeoutMs',
        label: 'API request timeout (ms)',
        type: 'number',
        placeholder: '60000',
        hint: 'Timeout for one metadata request, model listing, or status poll (1000-600000).'
      },
      {
        key: 'imageTimeoutMs',
        label: 'Image generation timeout (ms)',
        type: 'number',
        placeholder: '180000',
        hint: 'Timeout for one image generation or edit request (10000-1800000).'
      },
      {
        key: 'videoTimeoutMs',
        label: 'Video job timeout (ms)',
        type: 'number',
        placeholder: '900000',
        hint: 'Total polling deadline for one video job (10000-3600000).'
      },
      {
        key: 'pollIntervalMs',
        label: 'Video poll interval (ms)',
        type: 'number',
        placeholder: '5000',
        hint: 'How often to check a running video job (500-60000).'
      },
      {
        key: 'maxDownloadBytes',
        label: 'Maximum download size (bytes)',
        type: 'number',
        placeholder: '536870912',
        hint: 'Hard cap for a generated image or video download (1 MiB - 2 GiB).'
      },
      {
        key: 'writeMetadata',
        label: 'Write JSON metadata sidecars',
        type: 'boolean',
        hint: 'Store provider, model, prompt, request summary and usage next to generated files. Never stores the key.'
      }
    ]

    var CSS = [
      '.op-root{display:flex;flex-direction:column;gap:16px;max-width:860px;color:var(--dsw-alias-label-primary,#0f1115)}',
      '.op-pageTitle{margin:0;font-size:15px;font-weight:600;line-height:22px}',
      '.op-intro{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.op-security{display:flex;gap:8px;align-items:flex-start;padding:10px 12px;border-radius:10px;background:var(--dsw-alias-bg-l2,rgba(77,147,248,.07));border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));font-size:12px;line-height:18px}',
      '.op-security b{font-weight:600}',
      '.op-section{display:flex;flex-direction:column;gap:10px;border-top:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));padding-top:14px}',
      '.op-sectionTitle{margin:0;font-size:13px;font-weight:600;line-height:20px}',
      '.op-card{display:flex;flex-direction:column;gap:12px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.18));border-radius:12px;padding:14px;background:var(--dsw-alias-bg-base,transparent)}',
      '.op-cardHead{display:flex;align-items:center;justify-content:space-between;gap:8px}',
      '.op-cardTitle{font-size:13px;font-weight:600;display:flex;align-items:center;gap:8px}',
      '.op-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(210px,1fr));gap:10px}',
      '.op-field{display:flex;flex-direction:column;gap:4px;min-width:0}',
      '.op-field.wide{grid-column:1/-1}',
      '.op-label{font-size:12px;font-weight:600;line-height:18px}',
      '.op-input,.op-select,.op-textarea{font:inherit;font-size:13px;line-height:20px;padding:5px 9px;border-radius:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));background:var(--dsw-alias-bg-base,transparent);color:var(--dsw-alias-label-primary,#0f1115);box-sizing:border-box;width:100%;min-width:0}',
      '.op-textarea{min-height:56px;resize:vertical}',
      '.op-input:focus-visible,.op-select:focus-visible,.op-textarea:focus-visible{outline:var(--dsw-focus-ring-width,2px) solid var(--dsw-focus-ring-color,var(--dsw-alias-state-business-primary,#4d93f8));outline-offset:1px}',
      '.op-input:disabled,.op-select:disabled,.op-textarea:disabled{opacity:.55}',
      '.op-input.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px}',
      '.op-hint{margin:0;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.op-keyRow{display:grid;grid-template-columns:minmax(180px,1fr) minmax(240px,1.4fr);gap:10px;align-items:end}',
      '.op-keyBox{display:flex;flex-direction:column;gap:6px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.14));border-radius:10px;padding:10px;background:var(--dsw-alias-bg-l2,rgba(15,17,21,.02))}',
      '.op-keyLine{display:flex;gap:6px;align-items:center}',
      '.op-keyLine .op-input{flex:1}',
      '.op-status{display:inline-flex;align-items:center;gap:5px;font-size:11px;line-height:16px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.op-dot{width:7px;height:7px;border-radius:50%;background:var(--dsw-alias-label-quaternary,rgba(15,17,21,.3));display:inline-block}',
      '.op-dot.ok{background:var(--dsw-alias-state-success-primary,#2f9e62)}',
      '.op-dot.warn{background:var(--dsw-alias-state-warning-primary,#d19d20)}',
      '.op-dot.err{background:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.op-actions{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
      '.op-btn{font:inherit;font-size:12px;line-height:18px;padding:4px 10px;border-radius:8px;cursor:pointer;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.16));background:0 0;color:var(--dsw-alias-label-primary,#0f1115);white-space:nowrap}',
      '.op-btn:hover:not(:disabled){background:var(--dsw-alias-bg-hover,rgba(15,17,21,.05))}',
      '.op-btn:disabled{opacity:.5;cursor:default}',
      '.op-btnPrimary{background:var(--dsw-alias-state-business-primary,#4d93f8);border-color:transparent;color:#fff}',
      '.op-btnDanger{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.op-modelsHead{display:flex;align-items:center;justify-content:space-between;gap:8px;flex-wrap:wrap}',
      '.op-count{font-size:11px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.op-listBox{display:flex;flex-direction:column;gap:8px;border:.5px solid var(--dsw-alias-border-l2,rgba(15,17,21,.14));border-radius:10px;padding:10px;background:var(--dsw-alias-bg-l2,rgba(15,17,21,.02))}',
      '.op-modelList{display:flex;flex-direction:column;gap:6px}',
      '.op-modelRow{display:grid;grid-template-columns:minmax(140px,1.5fr) 88px 208px auto;gap:6px;align-items:center}',
      '.op-modelRow.discovered{grid-template-columns:24px minmax(150px,1fr) 96px;cursor:pointer}',
      '.op-check{width:15px;height:15px;margin:0;accent-color:var(--dsw-alias-state-business-primary,#4d93f8);flex:none}',
      '.op-modelId{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}',
      '.op-empty{margin:0;font-size:12px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.op-msg{margin:0;font-size:12px;line-height:18px}',
      '.op-ok{color:var(--dsw-alias-state-business-primary,#4d93f8)}',
      '.op-err{color:var(--dsw-alias-state-error-primary,#e5484d)}',
      '.op-state{margin:0;font-size:12px;line-height:18px;color:var(--dsw-alias-label-tertiary,rgba(15,17,21,.6))}',
      '.op-filter{display:flex;gap:8px;align-items:center;flex-wrap:wrap}',
      '.op-filter .op-input{max-width:260px}',
      '.op-details{border-top:.5px dashed var(--dsw-alias-border-l2,rgba(15,17,21,.16));padding-top:8px}',
      '.op-details summary{cursor:pointer;font-size:12px;font-weight:600;line-height:18px;color:var(--dsw-alias-label-secondary,rgba(15,17,21,.8))}',
      '.op-detailsGrid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:10px;padding-top:10px}',
      '.op-footer{display:flex;align-items:center;gap:8px;flex-wrap:wrap;padding-top:4px}'
    ].join('\n')

    function installStyles() {
      try {
        if (typeof document === 'undefined' || !document.head) return
        if (document.querySelector('style[data-plugin-css="' + STYLE_ID + '"]')) return
        var tag = document.createElement('style')
        tag.dataset.plugin = PACKAGE_ID
        tag.dataset.pluginCss = STYLE_ID
        tag.textContent = CSS
        document.head.appendChild(tag)
      } catch (_) {}
    }

    function useSnapshot(form) {
      return React.useSyncExternalStore(
        function (listener) { return form.subscribe(listener) },
        function () { return form.getSnapshot() }
      )
    }

    function h(type, props) {
      // Variadic (not an array child) keeps static children from needing keys.
      var children = Array.prototype.slice.call(arguments, 2)
      return React.createElement.apply(React, [type, props].concat(children))
    }

    function deriveRef(id) {
      var segment = String(id || '')
        .replace(/-/g, '_')
        .toUpperCase()
        .replace(/[^A-Z0-9_]/g, '_')
      return CREDENTIAL_PREFIX + segment + '_API_KEY'
    }

    function errorText(cause) {
      return String(cause && cause.message ? cause.message : cause)
    }

    /**
     * Read the credentials remote namespace defensively. Cordis throws when a
     * service property is read without the matching `inject` entry, so a plain
     * `ctx.remote.credentials` access inside a component effect can crash the
     * whole slot page. The client plugin declares `remote.credentials` in
     * `exports.inject`, and this helper keeps the page alive even if a future
     * composition mounts the page without that namespace.
     */
    function credentialsOf(ctx) {
      try {
        if (!ctx || !ctx.remote) return undefined
        return ctx.remote.credentials || undefined
      } catch (_) {
        return undefined
      }
    }

    /** Invoke a possibly-missing/throwing async op without ever throwing to the caller. */
    function settledCall(call) {
      try {
        return Promise.resolve(call())
      } catch (cause) {
        return Promise.resolve({ ok: false, error: errorText(cause) })
      }
    }

    function asArray(value) {
      return Array.isArray(value) ? value : []
    }

    function readProviders(value) {
      return asArray(value && value.providers).filter(function (raw) {
        return raw && typeof raw === 'object'
      }).map(function (raw, index) {
        raw = Object.assign({}, raw, { __order: index })
        var cloned = Object.assign({}, raw)
        cloned.id = typeof raw.id === 'string' ? raw.id : ''
        cloned.label = typeof raw.label === 'string' ? raw.label : ''
        cloned.baseUrl = typeof raw.baseUrl === 'string' ? raw.baseUrl : ''
        cloned.apiKeyEnv = typeof raw.apiKeyEnv === 'string' ? raw.apiKeyEnv : ''
        cloned.__uid = typeof raw.__uid === 'string' && raw.__uid !== '' ? raw.__uid : 'p-' + (cloned.id || 'new') + '-' + String(raw.__order || '')
        cloned.models = asArray(raw.models).map(function (model) {
          var copy = Object.assign({}, model)
          copy.id = typeof model.id === 'string' ? model.id : ''
          copy.kind = model.kind === 'video' ? 'video' : 'image'
          if (copy.kind === 'video') {
            // Cheaper Inference's /videos/generations is buffered, so display
            // (and re-save) the sync dialect even for an older saved async value.
            if (isCheaperInferenceHost(cloned.baseUrl)) copy.protocol = 'videos-generations'
            else if (!copy.protocol) copy.protocol = defaultProtocol(copy, cloned.baseUrl)
          }
          return copy
        })
        return cloned
      })
    }

    function serializeProvider(provider) {
      var out = {}
      var known = ['id', 'label', 'baseUrl', 'apiKeyEnv', 'apiKeyHeader', 'apiKeyPrefix', 'organization', 'project', 'headers']
      for (var i = 0; i < known.length; i += 1) {
        var key = known[i]
        var value = provider[key]
        if (typeof value === 'string') {
          if (value.trim() !== '') out[key] = value.trim()
        } else if (value && typeof value === 'object') {
          out[key] = value
        }
      }
      out.models = asArray(provider.models)
        .filter(function (model) { return typeof model.id === 'string' && model.id.trim() !== '' })
        .map(function (model) {
          var item = { id: model.id.trim(), kind: model.kind === 'video' ? 'video' : 'image' }
          var fields = ['label', 'protocol', 'editMode', 'size', 'quality', 'seconds', 'aspectRatio']
          for (var j = 0; j < fields.length; j += 1) {
            var field = fields[j]
            if (typeof model[field] === 'string' && model[field].trim() !== '') item[field] = model[field].trim()
          }
          if (item.protocol === undefined) delete item.protocol
          if (item.editMode === undefined) delete item.editMode
          return item
        })
      return out
    }

    function providerHost(baseUrl) {
      try {
        return new URL(String(baseUrl || '')).hostname.toLowerCase()
      } catch (_) {
        return ''
      }
    }

    function isCheaperInferenceHost(baseUrl) {
      return /(^|\.)cheaperinference\.com$/.test(providerHost(baseUrl))
    }

    function defaultProtocol(model, baseUrl) {
      if (model.kind === 'video') {
        // Cheaper Inference's /videos/generations buffers the render and returns
        // videos[] in the same response; it is not a pollable async job.
        if (isCheaperInferenceHost(baseUrl)) return 'videos-generations'
        if (providerHost(baseUrl) === 'api.openai.com' && /sora/i.test(model.id)) return 'openai-videos'
        return 'async-videos'
      }
      return 'openai-images'
    }

    function defaultEditMode(model) {
      return /(^|[-_/])grok/i.test(model.id) ? 'json' : 'multipart'
    }

    function validationProblem(providers) {
      var seen = {}
      for (var i = 0; i < providers.length; i += 1) {
        var provider = providers[i]
        var label = provider.id || 'Provider ' + (i + 1)
        if (!ID_PATTERN.test(provider.id || '')) {
          return label + ': id must be lowercase letters, digits and hyphens (max 64, no leading/trailing hyphen).'
        }
        if (seen[provider.id]) return 'Duplicate provider id "' + provider.id + '".'
        seen[provider.id] = true
        var url
        try {
          url = new URL((provider.baseUrl || '').trim())
        } catch (_) {
          return label + ': enter an http(s) API base URL such as https://api.openai.com/v1.'
        }
        if (url.protocol !== 'http:' && url.protocol !== 'https:') {
          return label + ': the endpoint must use http or https.'
        }
        if (url.username || url.password) return label + ': the endpoint must not contain a username or password.'
        if (provider.apiKeyEnv && !REF_PATTERN.test(provider.apiKeyEnv)) {
          return label + ': the credential reference must look like OPENAI_API_KEY (letters, digits, underscore).'
        }
        var modelIds = {}
        for (var j = 0; j < asArray(provider.models).length; j += 1) {
          var model = provider.models[j]
          if (!model.id || model.id.trim() === '') return label + ': every model needs an id.'
          if (modelIds[model.id.trim()]) return label + ': duplicate model "' + model.id + '".'
          modelIds[model.id.trim()] = true
        }
      }
      return null
    }

    function Field(props) {
      return h(
        'div',
        { className: 'op-field' + (props.wide ? ' wide' : '') },
        h('label', { className: 'op-label', htmlFor: props.id }, props.label),
        props.children,
        props.hint ? h('p', { className: 'op-hint' }, props.hint) : null
      )
    }

    function StatusDot(props) {
      return h('span', {
        className: 'op-dot' + (props.tone ? ' ' + props.tone : ''),
        title: props.title || ''
      })
    }

    /**
     * Preserve each card's stable React key across a snapshot re-read. Without
     * this, saving a provider changes its derived key and remounts the card,
     * losing discovery results and checkbox selections.
     */
    function mergeProviderUids(previous, next) {
      var byId = {}
      var byIndex = {}
      for (var i = 0; i < previous.length; i += 1) {
        var old = previous[i]
        if (!old || typeof old.__uid !== 'string') continue
        if (typeof old.id === 'string' && old.id !== '') byId[old.id] = old.__uid
        byIndex[i] = old.__uid
      }
      return next.map(function (provider, index) {
        if (typeof provider.id === 'string' && provider.id !== '' && byId[provider.id] !== undefined) {
          provider.__uid = byId[provider.id]
        } else if (provider.id === '' && byIndex[index] !== undefined) {
          provider.__uid = byIndex[index]
        }
        return provider
      })
    }

    /** Page-level guard: a component error must never abdicate the config slot. */
    class PageBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error('[openai-provider] page error:', error) } catch (_) {}
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'op-root' },
            h('h2', { className: 'op-pageTitle' }, 'OpenAI Providers'),
            h('p', { className: 'op-msg op-err' }, 'This settings page hit an error: ' + errorText(this.state.error)),
            h(
              'div',
              { className: 'op-actions' },
              h(
                'button',
                {
                  className: 'op-btn op-btnPrimary',
                  type: 'button',
                  onClick: function () { this.setState({ error: null }) }.bind(this)
                },
                'Retry'
              )
            ),
            h('p', { className: 'op-hint' }, 'If Retry does not help, reload the DSH window and check the renderer console for the stack trace.')
          )
        }
        return this.props.children
      }
    }

    /** Card-level guard: one broken provider must not take down its siblings. */
    class CardBoundary extends React.Component {
      constructor(props) {
        super(props)
        this.state = { error: null }
      }
      static getDerivedStateFromError(error) {
        return { error: error }
      }
      componentDidCatch(error) {
        try { console.error('[openai-provider] provider card error:', error) } catch (_) {}
      }
      render() {
        if (this.state.error) {
          return h(
            'div',
            { className: 'op-card' },
            h('p', { className: 'op-msg op-err' }, 'This provider card hit an error: ' + errorText(this.state.error)),
            h(
              'div',
              { className: 'op-actions' },
              h(
                'button',
                {
                  className: 'op-btn',
                  type: 'button',
                  onClick: function () { this.setState({ error: null }) }.bind(this)
                },
                'Retry card'
              ),
              typeof this.props.onRemove === 'function'
                ? h(
                    'button',
                    {
                      className: 'op-btn op-btnDanger',
                      type: 'button',
                      onClick: this.props.onRemove
                    },
                    'Remove provider'
                  )
                : null
            )
          )
        }
        return this.props.children
      }
    }

    function ProviderCard(props) {
      var provider = props.provider
      var index = props.index
      var ops = props.ops
      var update = props.update
      var disabled = props.disabled

      var keyInputState = React.useState('')
      var keyInfoState = React.useState(null)
      var keyBusyState = React.useState(false)
      var keyErrorState = React.useState('')
      var discoveryState = React.useState(null)
      var filterState = React.useState('')
      var showAllState = React.useState(false)
      var manualIdState = React.useState('')
      var manualKindState = React.useState('image')
      var selectionState = React.useState({})

      var keyInput = keyInputState[0]
      var setKeyInput = keyInputState[1]
      var keyInfo = keyInfoState[0]
      var setKeyInfo = keyInfoState[1]
      var keyBusy = keyBusyState[0]
      var setKeyBusy = keyBusyState[1]
      var keyError = keyErrorState[0]
      var setKeyError = keyErrorState[1]
      var discovery = discoveryState[0]
      var setDiscovery = discoveryState[1]
      var filter = filterState[0]
      var setFilter = filterState[1]
      var showAll = showAllState[0]
      var setShowAll = showAllState[1]
      var manualId = manualIdState[0]
      var setManualId = manualIdState[1]
      var manualKind = manualKindState[0]
      var setManualKind = manualKindState[1]
      var selection = selectionState[0]
      var setSelection = selectionState[1]

      var ref = (provider.apiKeyEnv || '').trim() !== '' ? provider.apiKeyEnv.trim() : deriveRef(provider.id)
      var prefix = 'op-' + index

      function refreshKeyInfo() {
        if (!ops) { setKeyInfo(null); return }
        var pending
        try {
          pending = ops.describeKeys([ref])
        } catch (cause) {
          setKeyInfo({ configured: false, unavailable: errorText(cause) })
          return
        }
        Promise.resolve(pending).then(function (result) {
          if (!result || result.ok !== true) {
            setKeyInfo({ configured: false, unavailable: result && result.error ? result.error : 'credential status unavailable' })
            return
          }
          var info = result.value && result.value[ref]
          setKeyInfo(info || { configured: false })
        }).catch(function (cause) {
          setKeyInfo({ configured: false, unavailable: errorText(cause) })
        })
      }

      React.useEffect(function () {
        setKeyInput('')
        setKeyInfo(null)
        if (!REF_PATTERN.test(ref)) {
          setKeyInfo({ configured: false, unavailable: 'invalid credential reference' })
          return
        }
        refreshKeyInfo()
      }, [ref, ops])

      function saveKey() {
        var value = keyInput.trim()
        if (value === '') {
          setKeyError('Paste the key value first.')
          return
        }
        if (!ops) {
          setKeyError('The credentials service is unavailable in this DSH deployment. Export ' + ref + ' in the environment instead.')
          return
        }
        setKeyBusy(true)
        setKeyError('')
        var pending
        try {
          pending = ops.saveKey(ref, value)
        } catch (cause) {
          setKeyBusy(false)
          setKeyError(errorText(cause))
          return
        }
        Promise.resolve(pending).then(function (result) {
          if (result && result.ok === true) {
            setKeyInput('')
            refreshKeyInfo()
            props.notify('Key saved to the DSH credentials store for reference ' + ref + '.')
          } else {
            setKeyError(result && result.error ? result.error : 'The credential could not be saved.')
          }
        }).catch(function (cause) {
          setKeyError(errorText(cause))
        }).then(function () { setKeyBusy(false) })
      }

      function clearKey() {
        if (!ops) return
        setKeyBusy(true)
        setKeyError('')
        var pending
        try {
          pending = ops.clearKey(ref)
        } catch (cause) {
          setKeyBusy(false)
          setKeyError(errorText(cause))
          return
        }
        Promise.resolve(pending).then(function (result) {
          if (result && result.ok === true) {
            refreshKeyInfo()
            props.notify('Key removed for reference ' + ref + '.')
          } else {
            setKeyError(result && result.error ? result.error : 'The credential could not be removed.')
          }
        }).catch(function (cause) {
          setKeyError(errorText(cause))
        }).then(function () { setKeyBusy(false) })
      }

      function loadModels() {
        setDiscovery({ loading: true, models: [], error: '' })
        setSelection({})
        var saved
        try {
          saved = Promise.resolve(props.saveFirst())
        } catch (cause) {
          setDiscovery({ loading: false, models: [], error: errorText(cause) })
          return
        }
        saved.then(function (ok) {
          if (!ok) {
            setDiscovery({ loading: false, models: [], error: 'Fix the configuration and save before loading models.' })
            return
          }
          if (!ops) {
            setDiscovery({ loading: false, models: [], error: 'The plugin operations are unavailable.' })
            return
          }
          return settledCall(function () { return ops.listModels(provider.id) }).then(function (result) {
            if (result && result.ok === true) {
              setDiscovery({ loading: false, models: result.models || [], error: '', truncated: result.truncated })
            } else {
              setDiscovery({ loading: false, models: [], error: result && result.error ? result.error : 'Model discovery failed.' })
            }
          })
        }).catch(function (cause) {
          setDiscovery({ loading: false, models: [], error: errorText(cause) })
        })
      }

      function toggleSelection(id) {
        setSelection(function (previous) {
          var next = Object.assign({}, previous)
          if (next[id]) delete next[id]
          else next[id] = true
          return next
        })
      }

      function toggleSelectAllShown() {
        var selectable = visibleDiscovered
        var all = selectable.length > 0 && selectable.every(function (model) { return selection[model.id] === true })
        setSelection(function (previous) {
          var next = Object.assign({}, previous)
          if (all) {
            selectable.forEach(function (model) { delete next[model.id] })
          } else {
            selectable.forEach(function (model) { next[model.id] = true })
          }
          return next
        })
      }

      function addSelected() {
        var chosen = discovered.filter(function (model) { return selection[model.id] === true && exposedIds[model.id] !== true })
        if (chosen.length === 0) return
        update(function (current) {
          var models = asArray(current.models).slice()
          var existing = {}
          models.forEach(function (model) { existing[model.id] = true })
          chosen.forEach(function (model) {
            if (existing[model.id]) return
            var kind = model.kind === 'video' ? 'video' : 'image'
            var entry = { id: model.id, kind: kind }
            if (kind === 'image') entry.editMode = defaultEditMode(entry)
            else entry.protocol = defaultProtocol({ id: model.id, kind: 'video' }, provider.baseUrl)
            models.push(entry)
            existing[model.id] = true
          })
          return Object.assign({}, current, { models: models })
        })
        setSelection({})
        props.notify('Added ' + chosen.length + ' model' + (chosen.length === 1 ? '' : 's') + '; save when you are done.')
      }

      function addManual() {
        var id = manualId.trim()
        if (id === '') return
        var entry = { id: id, kind: manualKind }
        if (manualKind === 'image') entry.editMode = defaultEditMode(entry)
        else entry.protocol = defaultProtocol(entry, provider.baseUrl)
        update(function (current) {
          var models = asArray(current.models).slice()
          if (models.some(function (existing) { return existing.id === id })) return current
          models.push(entry)
          return Object.assign({}, current, { models: models })
        })
        setManualId('')
      }

      function changeModel(modelIndex, patch) {
        update(function (current) {
          var models = asArray(current.models).slice()
          models[modelIndex] = Object.assign({}, models[modelIndex], patch)
          return Object.assign({}, current, { models: models })
        })
      }

      function removeModel(modelIndex) {
        update(function (current) {
          var models = asArray(current.models).slice()
          models.splice(modelIndex, 1)
          return Object.assign({}, current, { models: models })
        })
      }

      var keyConfigured = keyInfo && keyInfo.configured === true
      var keyUnavailable = keyInfo && keyInfo.unavailable
      var keyTone = keyUnavailable ? 'warn' : keyConfigured ? 'ok' : 'err'
      var keyText = keyUnavailable
        ? 'credentials service unavailable'
        : keyConfigured
          ? 'configured' + (keyInfo && keyInfo.source ? ' · ' + keyInfo.source : '')
          : 'not configured'
      var exposedIds = {}
      asArray(provider.models).forEach(function (model) { exposedIds[model.id] = true })
      var discovered = discovery && Array.isArray(discovery.models) ? discovery.models : []
      var visibleDiscovered = discovered.filter(function (model) {
        if (exposedIds[model.id]) return false
        if (!showAll && model.kind === null) return false
        if (filter.trim() !== '' && model.id.toLowerCase().indexOf(filter.trim().toLowerCase()) === -1) return false
        return true
      })
      var hiddenByKind = discovered.filter(function (model) {
        return !exposedIds[model.id] && model.kind === null
      }).length
      var selectedCount = discovered.filter(function (model) {
        return selection[model.id] === true && exposedIds[model.id] !== true
      }).length
      var allShownSelected =
        visibleDiscovered.length > 0 &&
        visibleDiscovered.every(function (model) { return selection[model.id] === true })

      var modelRows = asArray(provider.models).map(function (model, modelIndex) {
        var kind = model.kind === 'video' ? 'video' : 'image'
        return h(
          'div',
          { className: 'op-modelRow', key: 'model-' + modelIndex },
          h(
            'div',
            { className: 'op-field' },
            h('input', {
              className: 'op-input mono',
              value: model.id,
              disabled: disabled,
              'aria-label': 'Model id',
              'data-exposed-model-id': model.id,
              onChange: function (event) { changeModel(modelIndex, { id: event.target.value }) }
            })
          ),
          h(
            'select',
            {
              className: 'op-select',
              value: kind,
              disabled: disabled,
              'aria-label': 'Model kind',
              onChange: function (event) {
                var next = event.target.value
                changeModel(modelIndex, {
                  kind: next,
                  protocol: next === 'video' ? defaultProtocol({ id: model.id, kind: 'video' }, provider.baseUrl) : undefined,
                  editMode: next === 'image' ? defaultEditMode(model) : undefined
                })
              }
            },
            [h('option', { key: 'image', value: 'image' }, 'image'), h('option', { key: 'video', value: 'video' }, 'video')]
          ),
          h(
            'select',
            {
              className: 'op-select',
              value:
                kind === 'video'
                  ? isCheaperInferenceHost(provider.baseUrl)
                    ? 'videos-generations'
                    : model.protocol || defaultProtocol({ id: model.id, kind: 'video' }, provider.baseUrl)
                  : model.editMode || defaultEditMode(model),
              disabled: disabled,
              'aria-label': 'API dialect',
              onChange: function (event) {
                if (kind === 'video') changeModel(modelIndex, { protocol: event.target.value })
                else changeModel(modelIndex, { editMode: event.target.value })
              }
            },
            kind === 'video'
              ? isCheaperInferenceHost(provider.baseUrl)
                ? [h('option', { key: 'sync', value: 'videos-generations' }, 'sync /videos/generations')]
                : [
                    h('option', { key: 'sync', value: 'videos-generations' }, 'sync /videos/generations'),
                    h('option', { key: 'async', value: 'async-videos' }, 'async /videos/generations'),
                    h('option', { key: 'openai', value: 'openai-videos' }, 'openai /videos')
                  ]
              : [
                  h('option', { key: 'multipart', value: 'multipart' }, 'edits: multipart'),
                  h('option', { key: 'json', value: 'json' }, 'edits: JSON')
                ]
          ),
          h(
            'button',
            {
              className: 'op-btn op-btnDanger',
              type: 'button',
              disabled: disabled,
              onClick: function () { removeModel(modelIndex) }
            },
            'Remove'
          )
        )
      })

      return h(
        'div',
        { className: 'op-card' },
        h(
          'div',
          { className: 'op-cardHead' },
          h(
            'div',
            { className: 'op-cardTitle' },
            h('span', null, provider.id || 'New provider'),
            h('span', { className: 'op-count' }, asArray(provider.models).length + ' model(s) exposed')
          ),
          h(
            'button',
            {
              className: 'op-btn op-btnDanger',
              type: 'button',
              disabled: disabled,
              onClick: props.remove
            },
            'Remove provider'
          )
        ),
        h(
          'div',
          { className: 'op-grid' },
          h(
            Field,
            { id: prefix + '-id', label: 'Provider id', hint: 'Lowercase slug used by the tools, e.g. openai or grok.' },
            h('input', {
              id: prefix + '-id',
              className: 'op-input mono',
              value: provider.id,
              placeholder: 'openai',
              disabled: disabled,
              onChange: function (event) { update(Object.assign({}, provider, { id: event.target.value.toLowerCase() })) }
            })
          ),
          h(
            Field,
            { id: prefix + '-label', label: 'Display label', hint: 'Optional human name shown by openai_providers.' },
            h('input', {
              id: prefix + '-label',
              className: 'op-input',
              value: provider.label,
              placeholder: provider.id || 'OpenAI',
              disabled: disabled,
              onChange: function (event) { update(Object.assign({}, provider, { label: event.target.value })) }
            })
          ),
          h(
            Field,
            {
              id: prefix + '-url',
              label: 'API base URL',
              wide: true,
              hint: 'The API root, including any prefix. OpenAI is https://api.openai.com/v1; xAI is https://api.x.ai/v1.'
            },
            h('input', {
              id: prefix + '-url',
              className: 'op-input mono',
              value: provider.baseUrl,
              placeholder: 'https://api.openai.com/v1',
              disabled: disabled,
              spellCheck: false,
              onChange: function (event) { update(Object.assign({}, provider, { baseUrl: event.target.value })) }
            })
          )
        ),
        h(
          'div',
          { className: 'op-keyRow' },
          h(
            Field,
            {
              id: prefix + '-ref',
              label: 'Credential reference',
              hint: 'The NAME of the stored key, never the key. Leave blank to use ' + deriveRef(provider.id) + ', or reuse an existing reference such as OPENAI_API_KEY.'
            },
            h('input', {
              id: prefix + '-ref',
              className: 'op-input mono',
              value: provider.apiKeyEnv,
              placeholder: deriveRef(provider.id),
              disabled: disabled,
              spellCheck: false,
              onChange: function (event) { update(Object.assign({}, provider, { apiKeyEnv: event.target.value })) }
            })
          ),
          h(
            'div',
            { className: 'op-keyBox' },
            h(
              'div',
              { className: 'op-keyLine' },
              h('span', { className: 'op-status' }, h(StatusDot, { tone: keyTone }), keyText),
              h('span', { className: 'op-count' }, ref)
            ),
            h(
              'div',
              { className: 'op-keyLine' },
              h('input', {
                className: 'op-input',
                type: 'password',
                value: keyInput,
                placeholder: keyConfigured ? 'Replace stored key (never shown)' : 'Paste API key',
                disabled: disabled || keyBusy,
                autoComplete: 'off',
                spellCheck: false,
                onChange: function (event) { setKeyInput(event.target.value) }
              }),
              h(
                'button',
                {
                  className: 'op-btn',
                  type: 'button',
                  disabled: disabled || keyBusy || keyInput.trim() === '',
                  onClick: saveKey
                },
                keyBusy ? 'Saving…' : 'Save key'
              ),
              h(
                'button',
                {
                  className: 'op-btn',
                  type: 'button',
                  disabled: disabled || keyBusy || !keyConfigured || (keyInfo && keyInfo.writable === false),
                  onClick: clearKey
                },
                'Clear'
              )
            ),
            h('p', { className: 'op-hint' }, 'Stored by DSH’s credentials service with owner-only permissions. Saving the key takes effect immediately; the provider still needs Save. The page never reads the key back.')
          )
        ),
        keyError ? h('p', { className: 'op-msg op-err' }, keyError) : null,
        h(
          'div',
          { className: 'op-modelsHead' },
          h('strong', null, 'Exposed models'),
          h(
            'div',
            { className: 'op-actions' },
            h(
              'button',
              {
                className: 'op-btn',
                type: 'button',
                disabled: disabled || discovery && discovery.loading,
                onClick: loadModels
              },
              discovery && discovery.loading ? 'Loading…' : 'Load models'
            ),
          )
        ),
        discovery && discovery.error ? h('p', { className: 'op-msg op-err' }, discovery.error) : null,
        discovery && !discovery.loading && !discovery.error && discovered.length === 0
          ? h('p', { className: 'op-empty' }, 'The endpoint returned no models. You can add ids manually below.')
          : null,
        discovery && discovered.length > 0
          ? h(
              'div',
              { className: 'op-listBox' },
              h(
                'div',
                { className: 'op-filter' },
                h('input', {
                  className: 'op-input',
                  value: filter,
                  placeholder: 'Filter discovered models',
                  onChange: function (event) { setFilter(event.target.value) }
                }),
                h(
                  'label',
                  { className: 'op-status' },
                  h('input', {
                    type: 'checkbox',
                    checked: showAll,
                    onChange: function (event) { setShowAll(event.target.checked) }
                  }),
                  ' Show non-media models' + (hiddenByKind > 0 ? ' (' + hiddenByKind + ')' : '')
                ),
                h('span', { className: 'op-count' }, visibleDiscovered.length + ' available')
              ),
              h(
                'div',
                { className: 'op-filter' },
                h(
                  'label',
                  { className: 'op-status' },
                  h('input', {
                    type: 'checkbox',
                    className: 'op-check',
                    checked: allShownSelected,
                    disabled: disabled || visibleDiscovered.length === 0,
                    'aria-label': 'Select all shown models',
                    onChange: toggleSelectAllShown
                  }),
                  ' Select all shown'
                ),
                h(
                  'button',
                  {
                    className: 'op-btn',
                    type: 'button',
                    disabled: disabled || selectedCount === 0,
                    onClick: addSelected
                  },
                  'Add selected' + (selectedCount > 0 ? ' (' + selectedCount + ')' : '')
                ),
                h('span', { className: 'op-count' }, selectedCount + ' selected')
              ),
              visibleDiscovered.length === 0
                ? h('p', { className: 'op-empty' }, 'Nothing left to add here.')
                : h(
                    'div',
                    { className: 'op-modelList' },
                    visibleDiscovered.slice(0, 100).map(function (model) {
                      return h(
                        'label',
                        { className: 'op-modelRow discovered', key: 'd-' + model.id },
                        h('input', {
                          type: 'checkbox',
                          className: 'op-check',
                          checked: selection[model.id] === true,
                          disabled: disabled,
                          'aria-label': 'Select ' + model.id,
                          'data-model-id': model.id,
                          onChange: function () { toggleSelection(model.id) }
                        }),
                        h('span', { className: 'op-modelId', title: model.id }, model.id),
                        h('span', { className: 'op-count' }, model.kind || 'unknown')
                      )
                    })
                  ),
              visibleDiscovered.length > 100
                ? h('p', { className: 'op-hint' }, 'Showing 100 of ' + visibleDiscovered.length + '. Use the filter to narrow the list.')
                : null
            )
          : null,
        modelRows.length === 0
          ? h('p', { className: 'op-empty' }, 'No models exposed yet. Load models above, or add an id manually.')
          : h('div', { className: 'op-modelList' }, modelRows),
        asArray(provider.models).some(function (model) { return model.kind === 'video' })
          ? h(
              'p',
              { className: 'op-hint' },
              isCheaperInferenceHost(provider.baseUrl)
                ? 'Cheaper Inference uses the buffered POST /videos/generations endpoint: one request waits for the render and returns a videos[] URL or base64 MP4. No polling.'
                : 'Video API: sync = POST /videos/generations with a buffered videos[] response; async = POST /videos/generations then GET /videos/{id}; openai = POST /videos then GET /videos/{id}/content.'
            )
          : null,
        h(
          'details',
          { className: 'op-details' },
          h('summary', null, 'Model defaults (optional)'),
          h(
            'div',
            { className: 'op-detailsGrid' },
            asArray(provider.models).map(function (model, modelIndex) {
              var isVideo = model.kind === 'video'
              return h(
                'div',
                { className: 'op-field', key: 'dflt-' + modelIndex },
                h('span', { className: 'op-hint' }, model.id || 'model ' + (modelIndex + 1)),
                isVideo
                  ? h(
                      'div',
                      { className: 'op-actions' },
                      h('input', {
                        className: 'op-input',
                        value: model.seconds || '',
                        placeholder: 'seconds e.g. 8',
                        disabled: disabled,
                        'aria-label': 'Default seconds',
                        onChange: function (event) { changeModel(modelIndex, { seconds: event.target.value }) }
                      }),
                      h('input', {
                        className: 'op-input',
                        value: model.aspectRatio || '',
                        placeholder: 'aspect 16:9',
                        disabled: disabled,
                        'aria-label': 'Default aspect ratio',
                        onChange: function (event) { changeModel(modelIndex, { aspectRatio: event.target.value }) }
                      })
                    )
                  : h(
                      'div',
                      { className: 'op-actions' },
                      h('input', {
                        className: 'op-input',
                        value: model.size || '',
                        placeholder: 'size 1024x1024',
                        disabled: disabled,
                        'aria-label': 'Default size',
                        onChange: function (event) { changeModel(modelIndex, { size: event.target.value }) }
                      }),
                      h('input', {
                        className: 'op-input',
                        value: model.quality || '',
                        placeholder: 'quality high',
                        disabled: disabled,
                        'aria-label': 'Default quality',
                        onChange: function (event) { changeModel(modelIndex, { quality: event.target.value }) }
                      })
                    )
              )
            })
          )
        ),
        h(
          'div',
          { className: 'op-actions' },
          h('input', {
            className: 'op-input',
            value: manualId,
            placeholder: 'Add a model id manually',
            disabled: disabled,
            spellCheck: false,
            onChange: function (event) { setManualId(event.target.value) },
            onKeyDown: function (event) {
              if (event.key === 'Enter') {
                event.preventDefault()
                addManual()
              }
            }
          }),
          h(
            'select',
            {
              className: 'op-select',
              value: manualKind,
              disabled: disabled,
              'aria-label': 'Manual model kind',
              onChange: function (event) { setManualKind(event.target.value) }
            },
            [h('option', { key: 'image', value: 'image' }, 'image'), h('option', { key: 'video', value: 'video' }, 'video')]
          ),
          h(
            'button',
            {
              className: 'op-btn',
              type: 'button',
              disabled: disabled || manualId.trim() === '',
              onClick: addManual
            },
            'Add model'
          )
        )
      )
    }

    function ConfigPage(props) {
      var form = props.form
      var ops = props.ops
      var snapshot = useSnapshot(form)

      var providersState = React.useState(function () { return readProviders(snapshot.value) })
      var providers = providersState[0]
      var setProviders = providersState[1]
      var dirtyState = React.useState(false)
      var dirty = dirtyState[0]
      var setDirty = dirtyState[1]
      var editsState = React.useState({})
      var edits = editsState[0]
      var setEdits = editsState[1]
      var savingState = React.useState(false)
      var saving = savingState[0]
      var setSaving = savingState[1]
      var messageState = React.useState('')
      var message = messageState[0]
      var setMessage = messageState[1]
      var errorState = React.useState('')
      var error = errorState[0]
      var setError = errorState[1]

      var disabled = !snapshot.writable || saving

      React.useEffect(function () {
        if (snapshot.status !== 'ready') return
        if (dirty) return
        setProviders(function (previous) { return mergeProviderUids(previous, readProviders(configValue)) })
        setEdits({})
      }, [snapshot, dirty])

      function notify(text) {
        setMessage(text)
        setError('')
      }

      function updateProvider(index, next) {
        setProviders(function (previous) {
          var copy = previous.slice()
          var current = copy[index]
          copy[index] = typeof next === 'function' ? next(current) : next
          return copy
        })
        setDirty(true)
        setMessage('')
        setError('')
      }

      function removeProvider(index) {
        setProviders(function (previous) {
          var copy = previous.slice()
          copy.splice(index, 1)
          return copy
        })
        setDirty(true)
        setMessage('')
      }

      function addProvider() {
        setProviders(function (previous) {
          return previous.concat([{ id: '', label: '', baseUrl: '', apiKeyEnv: '', models: [], __uid: nextUid() }])
        })
        setDirty(true)
        setMessage('')
      }

      function editGlobal(key, value) {
        setEdits(function (previous) {
          var next = Object.assign({}, previous)
          next[key] = value
          return next
        })
        setDirty(true)
        setMessage('')
        setError('')
      }

      function globalValue(field) {
        if (Object.prototype.hasOwnProperty.call(edits, field.key)) return edits[field.key]
        var value = configValue[field.key]
        if (value === undefined || value === null) return ''
        if (field.type === 'boolean') return value ? 'true' : 'false'
        return String(value)
      }

      function buildOps() {
        var opsList = []
        var serialized = providers.map(serializeProvider)
        if (serialized.length === 0) opsList.push({ op: 'unset', path: ['providers'] })
        else opsList.push({ op: 'set', path: ['providers'], value: serialized })
        var keys = Object.keys(edits)
        for (var i = 0; i < keys.length; i += 1) {
          var key = keys[i]
          var field = null
          for (var j = 0; j < GLOBALS.length; j += 1) if (GLOBALS[j].key === key) field = GLOBALS[j]
          if (!field) continue
          var text = edits[key]
          if (text === '' || text === undefined || String(text).trim() === '') {
            opsList.push({ op: 'unset', path: [key] })
            continue
          }
          if (field.type === 'number') {
            var number = Number(text)
            if (!Number.isFinite(number)) return { error: 'Enter a valid number for "' + field.label + '", or leave it blank to inherit.' }
            opsList.push({ op: 'set', path: [key], value: number })
          } else if (field.type === 'boolean') {
            opsList.push({ op: 'set', path: [key], value: text === 'true' })
          } else {
            opsList.push({ op: 'set', path: [key], value: text })
          }
        }
        return { ops: opsList }
      }

      function saveAll(options) {
        var quiet = options && options.quiet === true
        var problem = validationProblem(providers)
        if (problem) {
          setError(problem)
          setMessage('')
          return Promise.resolve(false)
        }
        var built = buildOps()
        if (built.error) {
          setError(built.error)
          setMessage('')
          return Promise.resolve(false)
        }
        if (!dirty && !(options && options.force)) return Promise.resolve(true)
        setSaving(true)
        if (!quiet) {
          setError('')
          setMessage('')
        }
        return form.mutate(built.ops, snapshot.revision).then(function (accepted) {
          if (accepted) {
            setDirty(false)
            setEdits({})
            if (!quiet) setMessage('Saved. API keys stay in the DSH credentials store; this profile holds only their reference names.')
            return true
          }
          setError('The server did not accept these values. Check the field ranges and try again.')
          return false
        }).catch(function (cause) {
          setError('Could not save: ' + String(cause && cause.message ? cause.message : cause))
          return false
        }).then(function (ok) {
          setSaving(false)
          return ok
        })
      }

      if (snapshot.status === 'loading') {
        return h('p', { className: 'op-state' }, 'Loading configuration…')
      }
      if (snapshot.status === 'unavailable') {
        return h('p', { className: 'op-state' }, 'The configuration entry is not available. Make sure the plugin is enabled and the profile is loaded.')
      }
      var configValue = snapshot.value || {}
      var providerCards = providers.map(function (provider, index) {
        return h(
          CardBoundary,
          { key: provider.__uid || 'provider-' + index, onRemove: function () { removeProvider(index) } },
          h(ProviderCard, {
            provider: provider,
            index: index,
            ops: ops,
            disabled: disabled,
            update: function (next) { updateProvider(index, next) },
            remove: function () { removeProvider(index) },
            saveFirst: function () { return saveAll({ quiet: true, force: true }) },
            notify: notify
          })
        )
      })

      var globalFields = GLOBALS.map(function (field) {
        var id = 'op-global-' + field.key
        var value = globalValue(field)
        return h(
          Field,
          { key: field.key, id: id, label: field.label, hint: field.hint },
          field.type === 'boolean'
            ? h(
                'select',
                {
                  id: id,
                  className: 'op-select',
                  value: value,
                  disabled: disabled,
                  onChange: function (event) { editGlobal(field.key, event.target.value) }
                },
                [
                  h('option', { key: 'inherit', value: '' }, 'Inherit'),
                  h('option', { key: 'true', value: 'true' }, 'true'),
                  h('option', { key: 'false', value: 'false' }, 'false')
                ]
              )
            : h('input', {
                id: id,
                className: 'op-input' + (field.type === 'number' ? ' mono' : ''),
                inputMode: field.type === 'number' ? 'decimal' : 'text',
                value: value,
                placeholder: field.placeholder || '',
                disabled: disabled,
                onChange: function (event) { editGlobal(field.key, event.target.value) }
              })
        )
      })

      return h(
        'div',
        { className: 'op-root' },
        h('h2', { className: 'op-pageTitle' }, 'OpenAI Providers'),
        h('p', { className: 'op-intro' }, [
          'Connect any number of OpenAI-compatible endpoints. Each provider contributes the image and video models you explicitly expose; the DSH session reaches them through ',
          h('code', { key: 'code' }, 'openai_generate_image'),
          ', ',
          h('code', { key: 'code2' }, 'openai_generate_video'),
          ' and ',
          h('code', { key: 'code3' }, 'openai_providers'),
          '.'
        ]),
        h(
          'div',
          { className: 'op-security' },
          h('span', null, '🔒'),
          h(
            'div',
            null,
            h('b', null, 'API keys are stored by DSH, not in this profile. '),
            'Saving a key sends it once to DSH’s credentials service (owner-only permissions in ~/.dsh/.credentials.yaml). This page never reads it back, the plugin config contains only the reference name, and after storage the key is sent only to the provider endpoint you configured. Prefer environment variables or HTTPS remote access.'
          )
        ),
        h(
          'section',
          { className: 'op-section' },
          h('h3', { className: 'op-sectionTitle' }, 'Providers'),
          h(
            'p',
            { className: 'op-intro' },
            'Add an endpoint and key, save once, then use "Load models" to pick from the live catalogue. Saving writes only the providers below to this profile; the config file and environment remain fallbacks when this list is empty.'
          ),
          providerCards.length === 0 ? h('p', { className: 'op-empty' }, 'No providers yet. Add one below.') : null,
          providerCards,
          h(
            'div',
            { className: 'op-actions' },
            h(
              'button',
              { className: 'op-btn', type: 'button', disabled: disabled, onClick: addProvider },
              'Add provider'
            )
          )
        ),
        h(
          'details',
          { className: 'op-section' },
          h('summary', { className: 'op-sectionTitle' }, 'Generation defaults'),
          h('p', { className: 'op-intro' }, 'Leave any field blank to inherit from the config file or the built-in default.'),
          h('div', { className: 'op-grid' }, globalFields)
        ),
        error ? h('p', { className: 'op-msg op-err' }, error) : null,
        message ? h('p', { className: 'op-msg op-ok' }, message) : null,
        !snapshot.writable ? h('p', { className: 'op-state' }, 'This deployment stores settings read-only.') : null,
        h(
          'div',
          { className: 'op-footer' },
          h(
            'button',
            {
              className: 'op-btn op-btnPrimary',
              type: 'button',
              disabled: disabled || !dirty,
              onClick: function () { saveAll({}) }
            },
            saving ? 'Saving…' : 'Save'
          ),
          h(
            'button',
            {
              className: 'op-btn',
              type: 'button',
              disabled: disabled || !dirty,
              onClick: function () {
                setDirty(false)
                setEdits({})
                setProviders(readProviders(configValue))
                setMessage('')
                setError('')
              }
            },
            'Discard changes'
          ),
          h('span', { className: 'op-count' }, dirty ? 'Unsaved changes' : 'All changes saved')
        )
      )
    }

    function SafeConfigPage(props) {
      return h(PageBoundary, null, h(ConfigPage, props))
    }

    function apply(ctx) {
      installStyles()
      var form = ctx.configForms.get(ENTRY_ID)
      function callRemote(service, method, args) {
        if (!service || typeof service[method] !== 'function') {
          return Promise.resolve({ ok: false, error: 'The credentials service is unavailable in this DSH deployment.' })
        }
        try {
          return Promise.resolve(service[method].apply(service, args)).then(
            function (result) {
              if (result && result.ok === false) {
                return {
                  ok: false,
                  error: result.error && result.error.message ? result.error.message : 'The credentials service refused the request.'
                }
              }
              return { ok: true, value: (result && result.value) || {} }
            },
            function (cause) {
              return { ok: false, error: errorText(cause) }
            }
          )
        } catch (cause) {
          return Promise.resolve({ ok: false, error: errorText(cause) })
        }
      }

      var ops = {
        describeKeys: function (refs) {
          return callRemote(credentialsOf(ctx), 'describe', [refs])
        },
        saveKey: function (ref, value) {
          return callRemote(credentialsOf(ctx), 'set', [ref, value])
        },
        clearKey: function (ref) {
          return callRemote(credentialsOf(ctx), 'unset', [ref])
        },
        listModels: function (providerId) {
          try {
            return fetch(ROUTE, {
              method: 'POST',
              credentials: 'same-origin',
              headers: {
                'content-type': 'application/json',
                [ROUTE_HEADER]: '1'
              },
              body: JSON.stringify({ providerId: providerId })
            }).then(function (response) {
              return response.text().then(function (text) {
                var data = null
                try { data = JSON.parse(text) } catch (_) {}
                if (data === null) {
                  return {
                    ok: false,
                    error: response.status === 404
                      ? 'Model discovery is not routed in this DSH deployment. Add model ids manually below.'
                      : 'Model discovery returned an unexpected response (HTTP ' + response.status + ').'
                  }
                }
                if (!response.ok || data.ok !== true) {
                  return { ok: false, error: data.error || 'Model discovery failed (HTTP ' + response.status + ').' }
                }
                return { ok: true, models: data.models || [], truncated: data.truncated === true }
              })
            }, function (cause) {
              return { ok: false, error: errorText(cause) }
            })
          } catch (cause) {
            return Promise.resolve({ ok: false, error: errorText(cause) })
          }
        }
      }

      ctx.effect(function () {
        return ctx.configForms.whileServed([ENTRY_ID], function () {
          return ctx.slots.inject('plugins.bundle.config', function () {
            return ctx.slots.register(
              {
                name: 'plugins.bundle.config',
                key: PACKAGE_ID,
                inject: function () { return { form: form, ops: ops } }
              },
              SafeConfigPage
            )
          })
        })
      }, 'openai-provider: settings page')
    }

    exports.apply = apply
    exports.inject = ['slots', 'configForms', 'remote', 'remote.credentials']
    exports.name = 'openai-provider'
    return module.exports
  }
})
