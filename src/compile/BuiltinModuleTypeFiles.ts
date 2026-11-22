import { builtinModules } from 'module';
import type { ModuleTypeFiles } from './ModuleTypeFileCollector';

export function isBuiltinModule(moduleName: string): boolean {
    return builtinModules.includes(moduleName.replace(/^node:/, ''));
}

/** The answer for a Node built-in: the editor takes its declarations from Node-RED, and needs to know which references are built-ins too. */
export function builtinModuleTypeFiles(): ModuleTypeFiles {
    return { builtin: true, builtinModules: [...builtinModules], files: [], truncated: false };
}
