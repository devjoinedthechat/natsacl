import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { buildModel, resolveConfig, type Config, type Model, type ResolvedConfig } from '../src/index.js';

export const FIXTURES = resolve(__dirname, 'fixtures');

export function fixture(name: string): string {
  return resolve(FIXTURES, name);
}

/** Build the model for a fixture, starting from its config file (if any) and applying overrides. */
export function modelFor(name: string, overrides: Partial<Config> = {}): { model: Model; config: ResolvedConfig; root: string } {
  const root = fixture(name);
  const configFile = resolve(root, 'natsacl.config.json');
  let raw: Config = {};
  try {
    raw = JSON.parse(readFileSync(configFile, 'utf8')) as Config;
  } catch {
    raw = {};
  }
  const config = resolveConfig({ ...raw, ...overrides }, { rootDir: root, configFile });
  const model = buildModel(config);
  return { model, config, root };
}

export function user(model: Model, service: string) {
  const found = model.services.find((s) => s.service === service);
  if (!found) throw new Error(`no service ${service} in ${model.services.map((s) => s.service).join(', ')}`);
  return found;
}

export function codes(model: Model, severity?: 'error' | 'warning' | 'info'): string[] {
  return model.diagnostics.filter((d) => !severity || d.severity === severity).map((d) => d.code);
}
