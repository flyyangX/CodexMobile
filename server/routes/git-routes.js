import { sendJson } from '../http-utils.js';

function gitError(res, error, fallback) {
  const statusCode = error.statusCode || 500;
  sendJson(res, statusCode, { error: error.message || fallback });
}

export function registerGitRoutes(router) {
  router.get('/api/git/status', async ({ res, url, services }) => {
    const projectId = url.searchParams.get('projectId');
    try {
      sendJson(res, 200, { success: true, status: await services.gitService.status(projectId) });
    } catch (error) {
      gitError(res, error, 'Failed to read git status');
    }
  });

  router.get('/api/git/diff', async ({ res, url, services }) => {
    const projectId = url.searchParams.get('projectId');
    try {
      sendJson(res, 200, { success: true, diff: await services.gitService.diff(projectId) });
    } catch (error) {
      gitError(res, error, 'Failed to read git diff');
    }
  });

  router.post('/api/git/pull', async ({ res, body, services }) => {
    try {
      const result = await services.gitService.pull(body.projectId, {
        remote: body.remote,
        branch: body.branch
      });
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      gitError(res, error, 'Failed to pull git repository');
    }
  });

  router.post('/api/git/sync', async ({ res, body, services }) => {
    try {
      const result = await services.gitService.sync(body.projectId);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      gitError(res, error, 'Failed to sync git repository');
    }
  });

  router.post('/api/git/commit-push', async ({ res, body, services }) => {
    try {
      const result = await services.gitService.commitPush(body.projectId, body.message);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      gitError(res, error, 'Failed to commit and push changes');
    }
  });

  router.post('/api/git/commit', async ({ res, body, services }) => {
    try {
      const result = await services.gitService.commit(body.projectId, body.message);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      gitError(res, error, 'Failed to commit changes');
    }
  });

  router.post('/api/git/push', async ({ res, body, services }) => {
    try {
      const result = await services.gitService.push(body.projectId, {
        remote: body.remote,
        branch: body.branch
      });
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      gitError(res, error, 'Failed to push changes');
    }
  });

  router.post('/api/git/branch', async ({ res, body, services }) => {
    try {
      const result = await services.gitService.createBranch(body.projectId, body.branchName || body.branch);
      sendJson(res, 200, { success: true, ...result });
    } catch (error) {
      gitError(res, error, 'Failed to create branch');
    }
  });
}
