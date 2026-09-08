import { Worker, isMainThread } from 'node:worker_threads';

// Test-only readiness observation in the actual CLI process. The query worker
// clears execArgv, and storage workers do not install this main-thread observer.
if (isMainThread) {
  const postMessage = Worker.prototype.postMessage;
  Worker.prototype.postMessage = function (value, ...rest) {
    postMessage.call(this, value, ...rest);
    if (value?.kind === 'execute') process.send?.({ kind: 'query-executing' });
  };
}
