/**
 * Provider/model selection shared by the tools.
 *
 * The plugin's contract: only models the user explicitly exposed are callable.
 * That keeps cost and surprise under the user's control, and makes the
 * discovery tool's answer the same thing the generation tools will accept.
 */
import {
  ambiguousProvider,
  modelNotExposed,
  modelRequired,
  noModels,
  noProviderForKind,
  notConfigured,
  unknownProvider
} from './errors.js'
import type { ImageEditMode, ModelConfig, ModelKind, ProviderConfig, ResolvedConfig } from './types.js'
import { guessModelKind } from './config.js'

/** Resolve the provider for a call, honoring the one-provider shortcut. */
export function selectProvider(config: ResolvedConfig, requested?: string): ProviderConfig {
  if (config.providers.length === 0) throw notConfigured()
  const value = typeof requested === 'string' ? requested.trim() : ''
  if (value !== '') {
    const match =
      config.providers.find((provider) => provider.id === value) ??
      config.providers.find((provider) => provider.id.toLowerCase() === value.toLowerCase())
    if (match === undefined) throw unknownProvider(value, config.providers.map((provider) => provider.id))
    return match
  }
  if (config.providers.length > 1) throw ambiguousProvider(config.providers.map((provider) => provider.id))
  return config.providers[0]!
}

/**
 * Resolve the provider for a call that needs one capability. When no provider
 * is named, a provider that exposes at least one model of that kind is chosen
 * automatically — the common case of one image provider plus one video
 * provider. Ambiguity is still an error, never a guess.
 */
export function selectProviderForKind(
  config: ResolvedConfig,
  requested: string | undefined,
  kind: ModelKind
): ProviderConfig {
  const value = typeof requested === 'string' ? requested.trim() : ''
  if (value !== '') return selectProvider(config, value)
  if (config.providers.length === 0) throw notConfigured()
  const capable = config.providers.filter((provider) => modelsOfKind(provider, kind).length > 0)
  if (capable.length === 1) return capable[0]!
  if (capable.length > 1) throw ambiguousProvider(capable.map((provider) => provider.id))
  throw noProviderForKind(kind, config.providers.map((provider) => provider.id))
}

/** Models of one kind exposed by a provider, in declaration order. */
export function modelsOfKind(provider: ProviderConfig, kind: ModelKind): ModelConfig[] {
  return provider.models.filter((model) => model.kind === kind)
}

/** Resolve the model for a call of a given kind. */
export function selectModel(provider: ProviderConfig, kind: ModelKind, requested?: string): ModelConfig {
  const candidates = modelsOfKind(provider, kind)
  const value = typeof requested === 'string' ? requested.trim() : ''
  if (value !== '') {
    const match =
      candidates.find((model) => model.id === value) ??
      candidates.find((model) => model.id.toLowerCase() === value.toLowerCase())
    if (match !== undefined) return match
    const elsewhere = provider.models.find((model) => model.id === value)
    if (elsewhere !== undefined) {
      throw modelNotExposed(provider.id, value, candidates.map((model) => model.id))
    }
    throw modelNotExposed(provider.id, value, candidates.map((model) => model.id))
  }
  if (candidates.length === 0) throw noModels(provider.id, kind)
  if (candidates.length === 1) return candidates[0]!
  throw modelRequired(provider.id, kind, candidates.map((model) => model.id))
}

/** Effective image edit mode for a model, with the xAI-style JSON default. */
export function editModeFor(model: ModelConfig): ImageEditMode {
  if (model.editMode === 'json' || model.editMode === 'multipart') return model.editMode
  return /(^|[-_/])grok/i.test(model.id) ? 'json' : 'multipart'
}

/** Effective video protocol for a model. */
export function videoProtocolFor(
  model: ModelConfig
): 'openai-videos' | 'async-videos' | 'videos-generations' {
  if (
    model.protocol === 'openai-videos' ||
    model.protocol === 'async-videos' ||
    model.protocol === 'videos-generations'
  ) {
    return model.protocol
  }
  return 'async-videos'
}

/** Human label for a model. */
export function modelLabel(model: ModelConfig): string {
  return model.label !== undefined && model.label !== '' ? model.label : model.id
}

/** Compact one-line description used by the discovery tool and settings page. */
export function describeModel(model: ModelConfig): string {
  const extras: string[] = []
  if (model.kind === 'video') extras.push(videoProtocolFor(model))
  else extras.push(editModeFor(model) === 'json' ? 'json edits' : 'multipart edits')
  if (model.size !== undefined) extras.push(model.size)
  if (model.quality !== undefined) extras.push(model.quality)
  if (model.seconds !== undefined) extras.push(`${model.seconds}s`)
  return `${model.id} [${model.kind}; ${extras.join(', ')}]`
}

/** Whether a provider has at least one exposed model of a kind. */
export function supportsKind(provider: ProviderConfig, kind: ModelKind): boolean {
  return modelsOfKind(provider, kind).length > 0
}
