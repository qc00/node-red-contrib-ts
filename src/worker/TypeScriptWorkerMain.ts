import { parentPort, workerData } from 'worker_threads';
import { TypeScriptWorkerData, TypeScriptWorkerReplyMessage, TypeScriptWorkerRequestMessage } from './TypeScriptWorkerProtocol';
import { TypeScriptWorkerRequestHandler } from './TypeScriptWorkerRequestHandler';

const port = parentPort!;
const reply = (message: TypeScriptWorkerReplyMessage) => port.postMessage(message);
const handler = new TypeScriptWorkerRequestHandler((workerData as TypeScriptWorkerData).userDir);

port.on('message', async (request: TypeScriptWorkerRequestMessage) => {
    try {
        const result = await handler.handle(request.kind, request.payload, event => reply({ type: 'progress', id: request.id, event }));
        reply({ type: 'result', id: request.id, result });
    } catch (error: any) {
        reply({ type: 'error', id: request.id, message: String(error?.stack || error) });
    }
});

reply({ type: 'ready' });
