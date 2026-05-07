import { sendJson } from '../http-utils.js';

export function registerFileRoutes(router) {
  router.get('/api/files/search', async ({ res, url, services }) => {
    const projectId = url.searchParams.get('projectId');
    const query = url.searchParams.get('q') || '';
    const project = services.getProject(projectId);
    if (!project) {
      sendJson(res, 404, { error: 'Project not found' });
      return;
    }
    try {
      const files = await services.searchProjectFiles(project, query);
      sendJson(res, 200, { files });
    } catch (error) {
      sendJson(res, error.statusCode || 500, { error: error.message || 'Failed to search files' });
    }
  });
}
