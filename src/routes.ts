import { NodeAPI } from 'node-red';
import { builtinModuleTypeFiles, isBuiltinModule } from './module-types';
import { DeployTypeCheckCoordinator } from './deploy-scheduler';
import { TypeScriptCompilerService } from './compiler';

export const ADMIN_ROUTE_PREFIX = '/typescript-node';

/** Serves the editor what only the runtime can compute: context key types, module typings and parsed tsconfig. */
export function registerTypeScriptAdminRoutes(RED: NodeAPI, typeCheckService: DeployTypeCheckCoordinator, typeScriptCompiler: TypeScriptCompilerService) {
    const canRead = RED.auth.needsPermission('typescript.read');
    const fail = (res: any) => (error: any) => res.status(500).json({ error: String(error?.message || error) });

    RED.httpAdmin.get(`${ADMIN_ROUTE_PREFIX}/context-types`, canRead, async (_req, res) => {
        await typeCheckService.whenIdle();
        res.json(typeCheckService.registry);
    });

    RED.httpAdmin.get(`${ADMIN_ROUTE_PREFIX}/module-types`, canRead, (req, res) => {
        const moduleName = String(req.query.module || '');
        if (isBuiltinModule(moduleName)) {
            res.json(builtinModuleTypeFiles());
            return;
        }
        if (!moduleName || !typeCheckService.usesModule(moduleName)) {
            res.status(404).json({ error: `No deployed typescript node uses module '${moduleName}'` });
            return;
        }
        typeScriptCompiler.collectModuleTypes(moduleName).then(files => res.json(files), fail(res));
    });

    RED.httpAdmin.post(`${ADMIN_ROUTE_PREFIX}/compiler-options`, canRead, (req, res) => {
        const tsconfig = typeof req.body?.tsconfig === 'string' ? req.body.tsconfig : '';
        typeScriptCompiler.resolveCompilerOptions(tsconfig).then(resolved => res.json(resolved), fail(res));
    });
}
