import { sendJson } from '../http-utils.js';

export function registerUploadRoutes(router) {
  router.post('/api/uploads', async ({ req, res, services }) => {
    const upload = await services.saveUpload(req, {
      uploadRoot: services.uploadRoot,
      maxUploadBytes: services.maxUploadBytes
    });
    services.log?.(`[upload] saved name=${upload.name} size=${upload.size} kind=${upload.kind} remote=${services.remoteAddress(req)}`);
    sendJson(res, 200, { upload });
  }, { rawBody: true });
}
