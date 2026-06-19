/**
 * Chain plugin registry.
 *
 * The registry is the seam that delivers "add a chain without touching core":
 * core owns this generic registry; concrete plugins register into an instance
 * at composition time. Core never names a specific chain.
 */

import type { ChainAdapter, ChainAdapterConfig, ChainDescriptor, ChainPlugin } from './chain.js';
import { Errors } from './errors.js';
import { err, ok, type Result } from './result.js';
import type { AppError } from './errors.js';

export class ChainRegistry {
  readonly #plugins = new Map<string, ChainPlugin>();

  /** Register a plugin. Throws on duplicate key to surface config mistakes loudly. */
  register(plugin: ChainPlugin): this {
    const key = plugin.descriptor.key;
    if (this.#plugins.has(key)) {
      throw new Error(`Chain plugin already registered for key "${key}"`);
    }
    this.#plugins.set(key, plugin);
    return this;
  }

  registerAll(plugins: Iterable<ChainPlugin>): this {
    for (const p of plugins) this.register(p);
    return this;
  }

  has(key: string): boolean {
    return this.#plugins.has(key);
  }

  descriptors(): ChainDescriptor[] {
    return [...this.#plugins.values()].map((p) => p.descriptor);
  }

  descriptor(key: string): Result<ChainDescriptor, AppError> {
    const plugin = this.#plugins.get(key);
    if (!plugin) return err(unknownChain(key));
    return ok(plugin.descriptor);
  }

  /** Build an adapter for `key` bound to the supplied transport config. */
  adapter(key: string, config: ChainAdapterConfig): Result<ChainAdapter, AppError> {
    const plugin = this.#plugins.get(key);
    if (!plugin) return err(unknownChain(key));
    if (config.rpcUrls.length === 0) {
      return err(Errors.validation('NO_RPC', `No RPC endpoints configured for chain "${key}"`));
    }
    return ok(plugin.create(config));
  }
}

function unknownChain(key: string): AppError {
  return Errors.notFound('UNKNOWN_CHAIN', `No chain plugin registered for "${key}"`, { key });
}
